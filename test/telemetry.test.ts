import {
  context,
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
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

import {
  activeTraceFields,
  OpenTelemetryDeliveryTelemetry,
} from "../src/telemetry.js";

describe("trace log fields", () => {
  beforeEach(() => {
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
  });

  afterEach(() => {
    context.disable();
  });

  it("omits trace fields when there is no active span", () => {
    expect(activeTraceFields()).toEqual({});
  });

  it.each([
    { name: "both IDs are invalid", ...INVALID_SPAN_CONTEXT },
    {
      name: "the trace ID is invalid",
      ...INVALID_SPAN_CONTEXT,
      spanId: "0123456789abcdef",
    },
    {
      name: "the span ID is invalid",
      ...INVALID_SPAN_CONTEXT,
      traceId: "0123456789abcdef0123456789abcdef",
    },
  ])(
    "omits trace fields when $name",
    ({ traceId, spanId, traceFlags }) => {
      const activeContext = trace.setSpanContext(context.active(), {
        traceId,
        spanId,
        traceFlags,
      });

      expect(context.with(activeContext, activeTraceFields)).toEqual({});
    },
  );

  it.each([TraceFlags.NONE, TraceFlags.SAMPLED])(
    "keeps valid trace fields with trace flags %i",
    (traceFlags) => {
      const spanContext = {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags,
      };
      const activeContext = trace.setSpanContext(context.active(), spanContext);

      expect(context.with(activeContext, activeTraceFields)).toEqual({
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      });
    },
  );
});

describe("delivery telemetry", () => {
  it("records successful and failed deliveries", async () => {
    const spanExporter = new InMemorySpanExporter();
    const contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
    const tracerProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    const metricExporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [metricReader] });
    const telemetry = new OpenTelemetryDeliveryTelemetry(
      tracerProvider.getTracer("test"),
      meterProvider.getMeter("test"),
    );
    let traceFields: Record<string, string> = {};

    await telemetry.trackDelivery("invoice.created", async () => {
      traceFields = activeTraceFields();
    });

    await expect(
      telemetry.trackDelivery("invoice.created", async () => {
        throw new Error("Destination unavailable");
      }),
    ).rejects.toThrow("Destination unavailable");

    await tracerProvider.forceFlush();
    await meterProvider.forceFlush();

    expect(traceFields.traceId).toHaveLength(32);
    expect(traceFields.spanId).toHaveLength(16);

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.name === "webhook.deliver")).toBe(true);
    expect(spans[0]?.attributes).toMatchObject({
      "webhook.event.type": "invoice.created",
      "webhook.delivery.system": "http",
      "webhook.delivery.result": "success",
    });
    expect(spans[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans[1]?.attributes["webhook.delivery.result"]).toBe("failure");
    expect(spans[1]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[1]?.events[0]?.name).toBe("exception");

    const exportedMetrics = metricExporter.getMetrics().at(-1);
    const metrics = exportedMetrics?.scopeMetrics.flatMap(
      (scope) => scope.metrics,
    );
    const attempts = metrics?.find(
      (metric) => metric.descriptor.name === "webhook.delivery.attempts",
    );
    const failures = metrics?.find(
      (metric) => metric.descriptor.name === "webhook.delivery.failures",
    );
    const duration = metrics?.find(
      (metric) => metric.descriptor.name === "webhook.delivery.duration",
    );

    expect(attempts?.dataPointType).toBe(DataPointType.SUM);
    expect(attempts?.dataPoints[0]?.value).toBe(2);
    expect(failures?.dataPointType).toBe(DataPointType.SUM);
    expect(failures?.dataPoints[0]?.value).toBe(1);
    expect(duration?.dataPointType).toBe(DataPointType.HISTOGRAM);

    if (duration?.dataPointType !== DataPointType.HISTOGRAM) {
      throw new Error("Expected a duration histogram");
    }

    expect(duration.descriptor.unit).toBe("ms");
    expect(duration.dataPoints).toHaveLength(2);
    for (const point of duration.dataPoints) {
      expect(point.value.buckets.boundaries).toEqual([
        0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2000, 2500, 3000,
        5000, 7500, 10000, 30000, 60000,
      ]);
      const bucketCount = point.value.buckets.counts.reduce(
        (sum, count) => sum + count,
        0,
      );
      expect(bucketCount).toBe(point.value.count);
    }

    const recordedDurations = duration.dataPoints.reduce(
      (total, point) => total + point.value.count,
      0,
    );
    expect(recordedDurations).toBe(2);

    await tracerProvider.shutdown();
    await meterProvider.shutdown();
    context.disable();
    contextManager.disable();
  });
});
