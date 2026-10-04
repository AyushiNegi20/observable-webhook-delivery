import { SpanStatusCode } from "@opentelemetry/api";
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

describe("delivery failure telemetry", () => {
  let spanExporter: InMemorySpanExporter;
  let tracerProvider: NodeTracerProvider;
  let metricReader: PeriodicExportingMetricReader;
  let meterProvider: MeterProvider;
  let telemetry: OpenTelemetryDeliveryTelemetry;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    tracerProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    metricReader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    meterProvider = new MeterProvider({ readers: [metricReader] });
    telemetry = new OpenTelemetryDeliveryTelemetry(
      tracerProvider.getTracer("failure-test"),
      meterProvider.getMeter("failure-test"),
    );
  });

  afterEach(async () => {
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });

  async function failureMetric() {
    const { resourceMetrics, errors } = await metricReader.collect();
    expect(errors).toEqual([]);
    return resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "webhook.delivery.failures");
  }

  async function expectFailure(error: unknown, reason: string): Promise<void> {
    await expect(
      telemetry.trackDelivery("invoice.created", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await tracerProvider.forceFlush();

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.attributes).toMatchObject({
      "webhook.delivery.result": "failure",
      "webhook.delivery.failure_reason": reason,
    });

    const failures = await failureMetric();
    expect(failures?.dataPointType).toBe(DataPointType.SUM);
    expect(failures?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "webhook.event.type": "invoice.created",
          "webhook.delivery.system": "http",
          "webhook.delivery.failure_reason": reason,
        },
        value: 1,
      }),
    ]);
  }

  it.each(["network", "timeout", "http_status", "unknown"] as const)(
    "labels %s failures on the span and counter",
    async (reason) => {
      await expectFailure(new DeliveryError("Delivery failed", { reason }), reason);
    },
  );

  it.each([new Error("Unexpected failure"), "Unexpected rejection"])(
    "uses a bounded label for unexpected errors: %s",
    async (error) => {
      await expectFailure(error, "unexpected");
    },
  );

  it("does not attach a failure reason to a successful delivery", async () => {
    await expect(
      telemetry.trackDelivery("invoice.created", async () => "delivered"),
    ).resolves.toBe("delivered");
    await tracerProvider.forceFlush();

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["webhook.delivery.result"]).toBe("success");
    expect(spans[0]?.attributes["webhook.delivery.failure_reason"]).toBeUndefined();
    const failures = await failureMetric();
    expect(failures?.dataPoints ?? []).toHaveLength(0);
  });
});
