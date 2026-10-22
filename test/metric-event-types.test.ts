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

describe("delivery metric event-type budget", () => {
  let provider: MeterProvider;
  let reader: PeriodicExportingMetricReader;

  beforeEach(() => {
    reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    provider = new MeterProvider({ readers: [reader] });
  });

  afterEach(async () => { await provider.shutdown(); });

  function telemetry(maxMetricEventTypes?: number) {
    return new OpenTelemetryDeliveryTelemetry(
      trace.getTracer("cardinality-test"), provider.getMeter("cardinality-test"),
      maxMetricEventTypes === undefined ? {} : { maxMetricEventTypes },
    );
  }

  async function collect() {
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  }

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid event-type budget %s", (limit) => {
      expect(() => telemetry(limit)).toThrow("Expected maxMetricEventTypes to be a positive safe integer");
    },
  );

  it("keeps the default budget at 100 named types plus an overflow group", async () => {
    const delivery = telemetry();
    for (let index = 0; index < 105; index++) {
      await delivery.trackDelivery(`invoice.${index}`, async () => {});
    }
    const attempts = (await collect()).find((metric) => metric.descriptor.name === "webhook.delivery.attempts");
    if (attempts?.dataPointType !== DataPointType.SUM) throw new Error("Expected attempt counter");
    expect(attempts.dataPoints).toHaveLength(101);
    expect(attempts.dataPoints.reduce((sum, point) => sum + point.value, 0)).toBe(105);
    expect(attempts.dataPoints.find((point) => point.attributes["webhook.event.type"] === "_other")?.value).toBe(5);
  });

  it("bounds labels without dropping attempts or duration observations", async () => {
    const delivery = telemetry(2);
    for (const eventType of ["invoice.created", "invoice.paid", "payment.failed", "customer.created"]) {
      await delivery.trackDelivery(eventType, async () => {});
    }
    const metrics = await collect();
    for (const name of ["attempts", "active", "duration"]) {
      const metric = metrics.find((entry) => entry.descriptor.name === `webhook.delivery.${name}`);
      expect(metric?.dataPoints.map((point) => point.attributes["webhook.event.type"]).sort())
        .toEqual(["_other", "invoice.created", "invoice.paid"]);
      if (metric?.dataPointType === DataPointType.SUM) {
        expect(metric.dataPoints.reduce((sum, point) => sum + point.value, 0))
          .toBe(name === "attempts" ? 4 : 0);
      } else if (metric?.dataPointType === DataPointType.HISTOGRAM) {
        expect(metric.dataPoints.reduce((sum, point) => sum + point.value.count, 0)).toBe(4);
      } else {
        throw new Error("Expected a counter or histogram");
      }
    }
  });

  it("keeps admitted names stable across collections and later event types", async () => {
    const delivery = telemetry(1);
    await delivery.trackDelivery("invoice.created", async () => {});
    await collect();
    await delivery.trackDelivery("payment.failed", async () => {});
    await collect();
    await delivery.trackDelivery("customer.created", async () => {});
    await delivery.trackDelivery("invoice.created", async () => {});
    const attempts = (await collect()).find((metric) => metric.descriptor.name === "webhook.delivery.attempts");
    expect(attempts?.dataPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributes: { "webhook.event.type": "invoice.created", "webhook.delivery.system": "http" }, value: 2 }),
      expect.objectContaining({ attributes: { "webhook.event.type": "_other", "webhook.delivery.system": "http" }, value: 2 }),
    ]));
    expect(attempts?.dataPoints).toHaveLength(2);
  });

  it("balances overlapping overflow deliveries across collections", async () => {
    const delivery = telemetry(1);
    await delivery.trackDelivery("invoice.created", async () => {});
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = delivery.trackDelivery("payment.failed", () => new Promise<void>((resolve) => {
      finishFirst = resolve;
    }));
    const second = delivery.trackDelivery("customer.created", () => new Promise<void>((resolve) => {
      finishSecond = resolve;
    }));
    async function expectOverflowActive(value: number) {
      const active = (await collect()).find((metric) => metric.descriptor.name === "webhook.delivery.active");
      expect(active?.dataPoints.find((point) => point.attributes["webhook.event.type"] === "_other")?.value)
        .toBe(value);
    }
    try {
      await expectOverflowActive(2);
      finishSecond();
      await second;
      await expectOverflowActive(1);
      finishFirst();
      await first;
      await expectOverflowActive(0);
    } finally {
      finishFirst();
      finishSecond();
      await Promise.all([first, second]);
    }
  });
});
