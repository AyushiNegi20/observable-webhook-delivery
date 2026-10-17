import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { HttpDeliveryClient } from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";
import { captureLogger } from "./helpers/capture-logger.js";

describe("serialization failure through the event API", () => {
  let app: FastifyInstance;
  let captured: ReturnType<typeof captureLogger>;
  let spans: InMemorySpanExporter;
  let tracerProvider: NodeTracerProvider;
  let meterProvider: MeterProvider;
  let reader: PeriodicExportingMetricReader;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    captured = captureLogger();
    spans = new InMemorySpanExporter();
    tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    meterProvider = new MeterProvider({ readers: [reader] });
    app = buildApp({
      deliveryClient: new HttpDeliveryClient("http://receiver.test/webhooks", 1000),
      logger: captured.logger,
      telemetry: new OpenTelemetryDeliveryTelemetry(
        tracerProvider.getTracer("serialization-test"),
        meterProvider.getMeter("serialization-test"),
      ),
    });
    await app.ready();
  }, 15_000);

  afterEach(async () => {
    try {
      await app.close();
    } finally {
      try {
        await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown(), captured.close()]);
      } finally {
        context.disable();
        vi.unstubAllGlobals();
      }
    }
  });

  async function expectMetrics(attemptCount: number) {
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    const attributes = {
      "webhook.event.type": "invoice.created",
      "webhook.delivery.system": "http",
    };
    for (const [name, value] of [["attempts", attemptCount], ["active", 0]] as const) {
      const metric = metrics.find((entry) => entry.descriptor.name === `webhook.delivery.${name}`);
      expect(metric?.dataPoints).toEqual([expect.objectContaining({ attributes, value })]);
    }
    const failures = metrics.find((entry) => entry.descriptor.name === "webhook.delivery.failures");
    expect(failures?.dataPoints).toEqual([expect.objectContaining({
      attributes: { ...attributes, "webhook.delivery.failure_reason": "serialization" },
      value: 1,
    })]);
    const duration = metrics.find((entry) => entry.descriptor.name === "webhook.delivery.duration");
    expect(duration?.dataPoints).toHaveLength(attemptCount);
    for (const result of attemptCount === 1 ? ["failure"] : ["failure", "success"]) {
      const point = duration?.dataPoints.find(
        (entry) => entry.attributes["webhook.delivery.result"] === result,
      );
      expect(point).toMatchObject({
        attributes: { ...attributes, "webhook.delivery.result": result },
        value: { count: 1 },
      });
    }
  }

  it("reports deeply nested JSON as serialization failure and recovers for the next event", async () => {
    const marker = "private-nested-payload-marker";
    // Valid JSON can be deeper than the runtime's JSON.stringify call stack.
    const depth = 20_000;
    const payload = '{"eventType":"invoice.created","data":'
      + '{"nested":'.repeat(depth) + JSON.stringify(marker) + "}".repeat(depth) + "}";
    expect(Buffer.byteLength(payload)).toBeLessThan(256 * 1024);
    const response = await app.inject({
      method: "POST", url: "/events",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      eventId: expect.any(String), status: "failed", error: "Webhook delivery failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await tracerProvider.forceFlush();
    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(1);
    const span = finished[0];
    expect(span?.status).toMatchObject({
      code: SpanStatusCode.ERROR, message: "Webhook event could not be serialized",
    });
    expect(span?.attributes).toMatchObject({
      "webhook.delivery.result": "failure",
      "webhook.delivery.failure_reason": "serialization",
    });
    expect(span?.attributes).not.toHaveProperty("http.response.status_code");
    const failures = captured.records.filter((record) => record.msg === "Webhook delivery failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      failureReason: "serialization",
      eventId: response.json<{ eventId: string }>().eventId,
      reqId: response.headers["x-request-id"],
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
    });
    expect(failures[0]).not.toHaveProperty("statusCode");
    expect(JSON.stringify(captured.records)).not.toContain(marker);
    expect(JSON.stringify({ attributes: span?.attributes, events: span?.events })).not.toContain(marker);
    expect(response.body).not.toContain(marker);
    await expectMetrics(1);

    const accepted = await app.inject({
      method: "POST", url: "/events",
      payload: { eventType: "invoice.created", data: { invoiceId: "inv_123" } },
    });
    expect(accepted.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
    await tracerProvider.forceFlush();
    expect(spans.getFinishedSpans().map((entry) => entry.attributes["webhook.delivery.result"]))
      .toEqual(["failure", "success"]);
    await expectMetrics(2);
  }, 15_000);
});
