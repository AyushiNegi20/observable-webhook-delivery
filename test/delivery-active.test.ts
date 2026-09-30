import { trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";

function pendingDelivery() {
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, complete };
}

describe("active delivery metrics", () => {
  let meterProvider: MeterProvider;
  let metricReader: PeriodicExportingMetricReader;
  let telemetry: OpenTelemetryDeliveryTelemetry;

  beforeEach(() => {
    metricReader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    meterProvider = new MeterProvider({ readers: [metricReader] });
    telemetry = new OpenTelemetryDeliveryTelemetry(
      trace.getTracer("test"),
      meterProvider.getMeter("test"),
    );
  });

  afterEach(async () => {
    await meterProvider.shutdown();
  });

  async function activeDeliveries(): Promise<number> {
    const { resourceMetrics, errors } = await metricReader.collect();
    expect(errors).toEqual([]);
    const metric = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((entry) => entry.descriptor.name === "webhook.delivery.active");

    if (metric?.dataPointType !== DataPointType.SUM) {
      throw new Error("Expected an active delivery counter");
    }

    expect(metric.isMonotonic).toBe(false);
    expect(metric.dataPoints).toHaveLength(1);
    expect(metric.dataPoints[0]?.attributes).toEqual({
      "webhook.event.type": "invoice.created",
      "webhook.delivery.system": "http",
    });
    return metric.dataPoints.reduce((total, point) => total + point.value, 0);
  }

  it("counts overlapping deliveries until each finishes", async () => {
    const first = pendingDelivery();
    const second = pendingDelivery();
    const deliveries: Promise<void>[] = [];

    try {
      deliveries.push(
        telemetry.trackDelivery("invoice.created", () => first.promise),
      );
      await expect(activeDeliveries()).resolves.toBe(1);

      deliveries.push(
        telemetry.trackDelivery("invoice.created", () => second.promise),
      );
      await expect(activeDeliveries()).resolves.toBe(2);

      second.complete();
      await deliveries[1];
      await expect(activeDeliveries()).resolves.toBe(1);

      first.complete();
      await deliveries[0];
      await expect(activeDeliveries()).resolves.toBe(0);
    } finally {
      first.complete();
      second.complete();
      await Promise.all(deliveries);
    }
  });

  it.each([
    { name: "an Error", failure: new Error("Destination unavailable") },
    { name: "a non-Error rejection", failure: "Destination unavailable" },
  ])("clears the count after $name", async ({ failure }) => {
    await expect(
      telemetry.trackDelivery("invoice.created", async () => {
        await expect(activeDeliveries()).resolves.toBe(1);
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(activeDeliveries()).resolves.toBe(0);
  });

  it("clears the count after a synchronous exception", async () => {
    const failure = new Error("Delivery could not start");

    await expect(
      telemetry.trackDelivery("invoice.created", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(activeDeliveries()).resolves.toBe(0);
  });
});
