import { context, trace } from "@opentelemetry/api";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeliveryError } from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";

describe("delivery event identifiers", () => {
  let exporter: InMemorySpanExporter;
  let tracerProvider: NodeTracerProvider;
  let meterProvider: MeterProvider;
  let reader: PeriodicExportingMetricReader;
  let telemetry: OpenTelemetryDeliveryTelemetry;

  beforeEach(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    exporter = new InMemorySpanExporter();
    tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    meterProvider = new MeterProvider({ readers: [reader] });
    telemetry = new OpenTelemetryDeliveryTelemetry(
      tracerProvider.getTracer("event-id-test"), meterProvider.getMeter("event-id-test"),
    );
  });

  afterEach(async () => {
    try {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    } finally {
      context.disable();
    }
  });

  it("keeps the two-argument API without inventing an event identifier", async () => {
    await expect(telemetry.trackDelivery("invoice.created", async () => "delivered"))
      .resolves.toBe("delivered");
    await tracerProvider.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.attributes).not.toHaveProperty(["webhook.event.id"]);
  });

  it.each([false, true])("records IDs on spans but not metric labels when failed=%s", async (failed) => {
    const eventIds = [
      "c6d12b16-c95a-4cda-a230-c925aee6c302",
      "37bf367a-8ed1-4785-b4c0-b2914626b5a3",
    ];
    const failure = new DeliveryError("Synthetic failure", { reason: "http_status", statusCode: 503 });
    for (const eventId of eventIds) {
      const delivery = telemetry.trackDelivery("invoice.created", async () => {
        expect(trace.getActiveSpan()).toBeDefined();
        await Promise.resolve();
        if (failed) throw failure;
        return eventId;
      }, { eventId });
      if (failed) await expect(delivery).rejects.toBe(failure);
      else await expect(delivery).resolves.toBe(eventId);
    }
    await tracerProvider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.attributes["webhook.event.id"])).toEqual(eventIds);
    expect(spans.every((span) => span.attributes["webhook.delivery.result"] === (failed ? "failure" : "success")))
      .toBe(true);

    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(metrics).toHaveLength(failed ? 4 : 3);
    for (const metric of metrics) {
      expect(metric.dataPoints).toHaveLength(1);
      for (const point of metric.dataPoints) {
        expect(point.attributes).not.toHaveProperty(["webhook.event.id"]);
        for (const eventId of eventIds) expect(Object.values(point.attributes)).not.toContain(eventId);
      }
    }
    expect(metrics.find((metric) => metric.descriptor.name === "webhook.delivery.attempts")?.dataPoints[0]?.value).toBe(2);
    expect(metrics.find((metric) => metric.descriptor.name === "webhook.delivery.active")?.dataPoints[0]?.value).toBe(0);
    if (failed) {
      expect(metrics.find((metric) => metric.descriptor.name === "webhook.delivery.failures")?.dataPoints[0]?.value).toBe(2);
    }
    const duration = metrics.find((metric) => metric.descriptor.name === "webhook.delivery.duration");
    if (duration?.dataPointType !== DataPointType.HISTOGRAM) throw new Error("Expected duration histogram");
    expect(duration.dataPoints[0]?.value.count).toBe(2);
  });
});
