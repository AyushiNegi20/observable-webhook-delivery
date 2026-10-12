import { metrics, trace } from "@opentelemetry/api";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serviceVersion } from "../src/service-metadata.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";

describe("delivery instrumentation scope", () => {
  let spanExporter: InMemorySpanExporter;
  let metricExporter: InMemoryMetricExporter;
  let tracerProvider: NodeTracerProvider;
  let meterProvider: MeterProvider;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    tracerProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60_000,
      })],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    metrics.setGlobalMeterProvider(meterProvider);
  });

  afterEach(async () => {
    try {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    } finally {
      trace.disable();
      metrics.disable();
    }
  });

  it.each([
    {
      name: "the application version by default",
      defaults: true,
      tracerName: "observable-webhook-delivery",
      meterName: "observable-webhook-delivery",
      version: serviceVersion,
    },
    {
      name: "the supplied scopes when instruments are injected",
      defaults: false,
      tracerName: "test-tracer",
      meterName: "test-meter",
      version: "test-version",
    },
  ])("exports $name", async ({ defaults, tracerName, meterName, version }) => {
    const telemetry = defaults
      ? new OpenTelemetryDeliveryTelemetry()
      : new OpenTelemetryDeliveryTelemetry(
        tracerProvider.getTracer(tracerName, version),
        meterProvider.getMeter(meterName, version),
      );

    await telemetry.trackDelivery("invoice.created", async () => {});
    await expect(telemetry.trackDelivery("invoice.created", async () => {
      throw new Error("Receiver unavailable");
    })).rejects.toThrow("Receiver unavailable");
    await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.instrumentationScope).toMatchObject({ name: tracerName, version });
    }

    const scopes = metricExporter.getMetrics().at(-1)?.scopeMetrics;
    expect(scopes).toHaveLength(1);
    expect(scopes?.[0]?.scope).toMatchObject({ name: meterName, version });
    expect(scopes?.[0]?.metrics.map((metric) => metric.descriptor.name).sort()).toEqual([
      "webhook.delivery.active",
      "webhook.delivery.attempts",
      "webhook.delivery.duration",
      "webhook.delivery.failures",
    ]);
  });
});
