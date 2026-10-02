import { context, metrics, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
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

describe("delivery trace context", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let tracer: Tracer;
  let telemetry: OpenTelemetryDeliveryTelemetry;

  beforeEach(() => {
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer("context-test");
    telemetry = new OpenTelemetryDeliveryTelemetry(
      tracer,
      metrics.getMeter("context-test"),
    );
  });

  afterEach(async () => {
    try {
      await provider.shutdown();
    } finally {
      context.disable();
    }
  });

  it.each(["success", "failure"])(
    "preserves the parent trace and restores its context after %s",
    async (outcome) => {
      const failure = new Error("Destination unavailable");

      await tracer.startActiveSpan("request", async (parent) => {
        try {
          const parentFields = activeTraceFields();
          const delivery = telemetry.trackDelivery("invoice.created", async () => {
            const deliveryFields = activeTraceFields();
            expect(deliveryFields.traceId).toBe(parentFields.traceId);
            expect(deliveryFields.spanId).not.toBe(parentFields.spanId);

            await Promise.resolve();
            expect(activeTraceFields()).toEqual(deliveryFields);

            if (outcome === "failure") {
              throw failure;
            }
            return "delivered";
          });

          if (outcome === "failure") {
            await expect(delivery).rejects.toBe(failure);
          } else {
            await expect(delivery).resolves.toBe("delivered");
          }
          expect(activeTraceFields()).toEqual(parentFields);
        } finally {
          parent.end();
        }
      });

      expect(activeTraceFields()).toEqual({});
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      const parent = spans.find((span) => span.name === "request");
      const child = spans.find((span) => span.name === "webhook.deliver");

      expect(spans).toHaveLength(2);
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
      expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId);
      expect(child?.attributes["webhook.delivery.result"]).toBe(outcome);
    },
  );

  it("keeps concurrent deliveries in separate request traces", async () => {
    let releaseDeliveries!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseDeliveries = resolve;
    });
    const deliveries = ["first request", "second request"].map((name) =>
      tracer.startActiveSpan(name, async (parent) => {
        try {
          const parentFields = activeTraceFields();
          return await telemetry.trackDelivery("invoice.created", async () => {
            const deliveryFields = activeTraceFields();
            await barrier;
            expect(activeTraceFields()).toEqual(deliveryFields);
            return { parentFields, deliveryFields };
          });
        } finally {
          parent.end();
        }
      }),
    );

    try {
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      releaseDeliveries();
      const results = await Promise.all(deliveries);
      expect(results[0]?.parentFields.traceId)
        .not.toBe(results[1]?.parentFields.traceId);

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(4);
      for (const { parentFields, deliveryFields } of results) {
        expect(deliveryFields.traceId).toBe(parentFields.traceId);
        expect(deliveryFields.spanId).not.toBe(parentFields.spanId);
        const child = spans.find(
          (span) => span.spanContext().spanId === deliveryFields.spanId,
        );
        expect(child?.name).toBe("webhook.deliver");
        expect(child?.parentSpanContext?.spanId).toBe(parentFields.spanId);
      }
      expect(activeTraceFields()).toEqual({});
    } finally {
      releaseDeliveries();
      await Promise.allSettled(deliveries);
    }
  });
});
