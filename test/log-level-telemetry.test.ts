import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { DeliveryError } from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";
import { captureLogger } from "./helpers/capture-logger.js";

describe("log thresholds and delivery telemetry", () => {
  it.each([
    { level: "info", minimum: 30 },
    { level: "warn", minimum: 40 },
    { level: "error", minimum: 50 },
    { level: "fatal", minimum: 60 },
    { level: "silent", minimum: Infinity },
  ] as const)("filters logs at $level without changing traces or metrics", async ({ level, minimum }) => {
    const captured = captureLogger();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const spans = new InMemorySpanExporter();
    const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    const reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    const app = buildApp({
      logger: captured.logger,
      logLevel: level,
      mockReceiverStatusCode: 503,
      telemetry: new OpenTelemetryDeliveryTelemetry(
        tracerProvider.getTracer("log-level-test"), meterProvider.getMeter("log-level-test"),
      ),
      deliveryClient: {
        async deliver(event) {
          if (event.data.fail === true) {
            throw new DeliveryError("Synthetic receiver failure", { reason: "http_status", statusCode: 503 });
          }
        },
      },
    });

    try {
      expect(app.log.level).toBe(level);
      expect(captured.logger.level).toBe("info");
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      const eventIds: string[] = [];
      for (const fail of [false, true]) {
        const response = await app.inject({
          method: "POST", url: "/events",
          payload: { eventType: "invoice.created", data: { fail } },
        });
        expect(response.statusCode).toBe(fail ? 502 : 201);
        expect(response.headers["x-request-id"]).toBeTruthy();
        eventIds.push(response.json<{ eventId: string }>().eventId);
      }
      const receiver = await app.inject({
        method: "POST", url: "/mock/webhooks",
        payload: {
          id: "9a636036-e782-460f-bc36-a3fc0e46a8f4", eventType: "invoice.created",
          data: {}, createdAt: "2026-10-27T00:00:00.000Z",
        },
      });
      expect(receiver.statusCode).toBe(503);

      for (const record of captured.records) {
        expect(record.level).toBeGreaterThanOrEqual(minimum);
        expect(record.component).toBe("logging-test");
      }
      const messages = captured.records.map((record) => record.msg);
      expect(messages.includes("incoming request")).toBe(minimum <= 30);
      expect(messages.includes("Webhook delivery completed")).toBe(minimum <= 30);
      expect(messages.includes("Mock receiver rejected webhook")).toBe(minimum <= 40);
      expect(messages.includes("Webhook delivery failed")).toBe(minimum <= 50);
      if (minimum > 50) expect(captured.records).toEqual([]);

      await tracerProvider.forceFlush();
      expect(spans.getFinishedSpans().map((span) => span.attributes["webhook.event.id"])).toEqual(eventIds);
      expect(spans.getFinishedSpans().map((span) => span.attributes["webhook.delivery.result"]))
        .toEqual(["success", "failure"]);
      if (minimum <= 50) {
        const failureSpan = spans.getFinishedSpans()[1];
        expect(captured.records.find((record) => record.msg === "Webhook delivery failed")).toMatchObject({
          eventId: eventIds[1], traceId: failureSpan?.spanContext().traceId,
          spanId: failureSpan?.spanContext().spanId, failureReason: "http_status", statusCode: 503,
        });
      }
      const { resourceMetrics, errors } = await reader.collect();
      expect(errors).toEqual([]);
      const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
      expect(metrics).toHaveLength(4);
      for (const [name, value] of [["attempts", 2], ["failures", 1], ["active", 0]] as const) {
        const metric = metrics.find((entry) => entry.descriptor.name === `webhook.delivery.${name}`);
        expect(metric?.dataPoints).toHaveLength(1);
        expect(metric?.dataPoints[0]?.value).toBe(value);
      }
      const duration = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.duration");
      if (duration?.dataPointType !== DataPointType.HISTOGRAM) throw new Error("Expected duration histogram");
      expect(duration.dataPoints.reduce((total, point) => total + point.value.count, 0)).toBe(2);
    } finally {
      try {
        await app.close();
      } finally {
        try {
          await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown(), captured.close()]);
        } finally {
          context.disable();
        }
      }
    }
  }, 15_000);
});
