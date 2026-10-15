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
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";
import { captureLogger } from "./helpers/capture-logger.js";

describe.each([
  { url: "/events", limit: 256 * 1024 },
  { url: "/mock/webhooks", limit: 2 * 1024 * 1024 },
])("rejected $url request telemetry", ({ url, limit }) => {
  let app: FastifyInstance;
  let captured: ReturnType<typeof captureLogger>;
  let spans: InMemorySpanExporter;
  let tracerProvider: NodeTracerProvider;
  let meterProvider: MeterProvider;
  let reader: PeriodicExportingMetricReader;
  const deliver = vi.fn(async () => {});

  beforeEach(async () => {
    deliver.mockClear();
    captured = captureLogger();
    spans = new InMemorySpanExporter();
    tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    meterProvider = new MeterProvider({ readers: [reader] });
    app = buildApp({
      deliveryClient: { deliver },
      logger: captured.logger,
      telemetry: new OpenTelemetryDeliveryTelemetry(
        tracerProvider.getTracer("rejection-test"),
        meterProvider.getMeter("rejection-test"),
      ),
    });
    await app.ready();
  }, 15_000);

  afterEach(async () => {
    try {
      await app.close();
    } finally {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown(), captured.close()]);
    }
  });

  async function deliveryMetrics() {
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name.startsWith("webhook.delivery."));
  }

  it.each([
    { kind: "invalid schema", statusCode: 400 },
    { kind: "malformed JSON", statusCode: 400 },
    { kind: "oversized body", statusCode: 413 },
    { kind: "unsupported content type", statusCode: 415 },
  ])("keeps $kind out of delivery telemetry", async ({ kind, statusCode }) => {
    const body = {
      ...(url === "/mock/webhooks" ? {
        id: "a545a04d-5380-4d9c-bca8-37f20936e942",
        createdAt: "2026-08-25T00:00:00.000Z",
      } : {}),
      eventType: kind === "invalid schema" ? "invalid event type" : "invoice.created",
      data: { note: kind === "oversized body" ? "a".repeat(limit) : "test" },
    };
    const response = await app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": kind === "unsupported content type" ? "application/octet-stream" : "application/json",
      },
      payload: kind === "malformed JSON" ? "{" : JSON.stringify(body),
    });
    await tracerProvider.forceFlush();

    expect(response.statusCode).toBe(statusCode);
    expect(deliver).not.toHaveBeenCalled();
    expect(spans.getFinishedSpans()).toHaveLength(0);
    expect((await deliveryMetrics()).reduce((count, metric) => count + metric.dataPoints.length, 0)).toBe(0);
    expect(captured.records.filter((record) => record.eventId !== undefined)).toEqual([]);

    // A valid request proves the instruments are active, not missing or disabled.
    const accepted = await app.inject({
      method: "POST", url: "/events",
      payload: { eventType: "probe.created", data: {} },
    });
    await tracerProvider.forceFlush();
    expect(accepted.statusCode).toBe(201);
    expect(deliver).toHaveBeenCalledOnce();
    expect(spans.getFinishedSpans()).toHaveLength(1);
    expect(spans.getFinishedSpans()[0]?.name).toBe("webhook.deliver");

    const metrics = await deliveryMetrics();
    const attempts = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.attempts");
    const failures = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.failures");
    const active = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.active");
    const duration = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.duration");
    expect(attempts?.dataPoints).toEqual([expect.objectContaining({ value: 1 })]);
    expect(failures?.dataPoints ?? []).toEqual([]);
    expect(active?.dataPoints).toEqual([expect.objectContaining({ value: 0 })]);
    expect(duration?.dataPoints).toHaveLength(1);
    expect(duration?.dataPoints[0]?.value).toMatchObject({ count: 1 });
    for (const metric of metrics) {
      for (const point of metric.dataPoints) {
        expect(point.attributes["webhook.event.type"]).toBe("probe.created");
      }
    }
  }, 15_000);
});
