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
import { expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { DeliveryError } from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";
import { captureLogger } from "./helpers/capture-logger.js";

it("groups metric labels without changing event types in API delivery, traces, or logs", async () => {
  const captured = captureLogger();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const deliveredTypes: string[] = [];
  const cases = [
    { eventType: "invoice.created", status: 201 },
    { eventType: "payment.failed", status: 502 },
    { eventType: "customer.created", status: 201 },
    { eventType: "inventory.updated", status: 502 },
  ];
  const app = buildApp({
    logger: captured.logger,
    telemetry: new OpenTelemetryDeliveryTelemetry(
      tracerProvider.getTracer("cardinality-test"),
      meterProvider.getMeter("cardinality-test"),
      { maxMetricEventTypes: 1 },
    ),
    deliveryClient: {
      async deliver(event) {
        deliveredTypes.push(event.eventType);
        if (event.eventType === "payment.failed") {
          throw new DeliveryError("Synthetic receiver failure", { reason: "http_status", statusCode: 503 });
        }
        if (event.eventType === "inventory.updated") {
          throw new DeliveryError("Synthetic timeout", { reason: "timeout" });
        }
      },
    },
  });

  try {
    for (const { eventType, status } of cases) {
      const response = await app.inject({
        method: "POST", url: "/events", payload: { eventType, data: {} },
      });
      expect(response.statusCode).toBe(status);
      const eventId = response.json<{ eventId: string }>().eventId;
      await tracerProvider.forceFlush();
      const span = exporter.getFinishedSpans().at(-1);
      expect(span?.attributes["webhook.event.type"]).toBe(eventType);
      expect(span?.attributes["webhook.event.id"]).toBe(eventId);
      expect(span?.attributes["webhook.delivery.result"]).toBe(status === 201 ? "success" : "failure");
      const logs = captured.records.filter((record) => record.eventId === eventId);
      expect(logs).toHaveLength(2);
      for (const log of logs) {
        expect(log).toMatchObject({
          eventType, reqId: response.headers["x-request-id"],
          traceId: span?.spanContext().traceId, spanId: span?.spanContext().spanId,
        });
      }
    }
    expect(deliveredTypes).toEqual(cases.map((entry) => entry.eventType));
    expect(exporter.getFinishedSpans()).toHaveLength(4);
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(metrics).toHaveLength(4);
    const attributes = { "webhook.event.type": "_other", "webhook.delivery.system": "http" };
    const attempts = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.attempts");
    expect(attempts?.dataPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributes, value: 3 }),
      expect.objectContaining({ attributes: { ...attributes, "webhook.event.type": "invoice.created" }, value: 1 }),
    ]));
    const failures = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.failures");
    expect(failures?.dataPoints).toHaveLength(2);
    for (const reason of ["http_status", "timeout"]) {
      expect(failures?.dataPoints).toContainEqual(expect.objectContaining({
        attributes: { ...attributes, "webhook.delivery.failure_reason": reason }, value: 1,
      }));
    }
    const active = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.active");
    expect(active?.dataPoints.map((point) => point.value)).toEqual([0, 0]);
    const duration = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.duration");
    if (duration?.dataPointType !== DataPointType.HISTOGRAM) throw new Error("Expected duration histogram");
    expect(duration.dataPoints.reduce((sum, point) => sum + point.value.count, 0)).toBe(4);
    expect(duration.dataPoints).toContainEqual(expect.objectContaining({
      attributes: { ...attributes, "webhook.delivery.result": "failure" },
      value: expect.objectContaining({ count: 2 }),
    }));
    for (const metric of metrics) {
      for (const point of metric.dataPoints) {
        expect(["invoice.created", "_other"]).toContain(point.attributes["webhook.event.type"]);
        expect(point.attributes).not.toHaveProperty(["webhook.event.id"]);
      }
    }
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
