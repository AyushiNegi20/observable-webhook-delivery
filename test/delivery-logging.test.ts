import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { DeliveryError } from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";
import { captureLogger } from "./helpers/capture-logger.js";

describe("delivery log correlation", () => {
  let captured: ReturnType<typeof captureLogger>;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
    captured = captureLogger();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await Promise.all([provider.shutdown(), captured.close()]);
      } finally {
        context.disable();
      }
    }
  });

  it.each(["success", "failure"] as const)(
    "matches %s logs to the delivery span without recording payloads",
    async (outcome) => {
      const failed = outcome === "failure";
      const payloadMarker = "private-payload-marker";
      const headerMarker = "test-only-auth-marker";
      app = buildApp({
        logger: captured.logger,
        telemetry: new OpenTelemetryDeliveryTelemetry(provider.getTracer("log-test")),
        deliveryClient: {
          async deliver() {
            await Promise.resolve();
            if (failed) {
              throw new DeliveryError("Receiver unavailable", {
                reason: "http_status",
                statusCode: 503,
              });
            }
          },
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/events",
        headers: { authorization: `Bearer ${headerMarker}` },
        payload: {
          eventType: "invoice.created",
          data: { customerNote: payloadMarker },
        },
      });

      expect(response.statusCode).toBe(failed ? 502 : 201);
      const body = response.json<{ eventId: string; status: string }>();
      expect(body.status).toBe(failed ? "failed" : "delivered");
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const span = spans[0];
      if (span === undefined) {
        throw new Error("Expected a completed delivery span");
      }
      expect(span.name).toBe("webhook.deliver");
      expect(span.status.code).toBe(failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
      expect(span.attributes["webhook.delivery.result"]).toBe(outcome);
      expect(span.attributes["webhook.event.id"]).toBe(body.eventId);

      const deliveryLogs = captured.records.filter((record) => record.eventId === body.eventId);
      expect(deliveryLogs.map((record) => record.msg)).toEqual([
        "Webhook delivery started",
        failed ? "Webhook delivery failed" : "Webhook delivery completed",
      ]);
      expect(deliveryLogs.map((record) => record.level)).toEqual([30, failed ? 50 : 30]);
      for (const record of deliveryLogs) {
        expect(record).toMatchObject({
          reqId: response.headers["x-request-id"],
          eventId: body.eventId,
          eventType: "invoice.created",
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
        });
      }

      const logged = JSON.stringify(captured.records);
      const traced = JSON.stringify({ attributes: span.attributes, events: span.events });
      for (const marker of [payloadMarker, headerMarker]) {
        expect(logged).not.toContain(marker);
        expect(traced).not.toContain(marker);
        expect(response.body).not.toContain(marker);
      }
      if (failed) {
        expect(response.body).not.toContain("Receiver unavailable");
      } else {
        for (const record of deliveryLogs) {
          expect(record).not.toHaveProperty("failureReason");
          expect(record).not.toHaveProperty("statusCode");
        }
      }
    },
    15_000,
  );

  it("keeps event IDs separate across overlapping successful and failed requests", async () => {
    let releaseDeliveries!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseDeliveries = resolve; });
    const deliveredIds: string[] = [];
    app = buildApp({
      logger: captured.logger,
      telemetry: new OpenTelemetryDeliveryTelemetry(provider.getTracer("log-test")),
      deliveryClient: {
        async deliver(event) {
          deliveredIds.push(event.id);
          await barrier;
          if (event.data.fail === true) {
            throw new DeliveryError("Synthetic receiver failure", { reason: "http_status", statusCode: 503 });
          }
        },
      },
    });
    const server = app;
    const requests = [false, true].map(async (fail) => server.inject({
      method: "POST", url: "/events",
      payload: { eventType: "invoice.created", data: { fail } },
    }));

    try {
      await vi.waitFor(() => expect(deliveredIds).toHaveLength(2), { timeout: 5000 });
      expect(new Set(deliveredIds).size).toBe(2);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      releaseDeliveries();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode)).toEqual([201, 502]);
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(2);
      for (const response of responses) {
        const eventId = response.json<{ eventId: string }>().eventId;
        expect(deliveredIds).toContain(eventId);
        const span = spans.find((entry) => entry.attributes["webhook.event.id"] === eventId);
        expect(span).toBeDefined();
        expect(span?.attributes["webhook.delivery.result"]).toBe(response.statusCode === 201 ? "success" : "failure");
        const logs = captured.records.filter((record) => record.eventId === eventId);
        expect(logs).toHaveLength(2);
        for (const log of logs) {
          expect(log).toMatchObject({
            eventId, eventType: "invoice.created", reqId: response.headers["x-request-id"],
            traceId: span?.spanContext().traceId, spanId: span?.spanContext().spanId,
          });
        }
      }
    } finally {
      releaseDeliveries();
      await Promise.allSettled(requests);
    }
  }, 15_000);

  it.each([
    {
      name: "a network error",
      error: new DeliveryError("Destination unreachable", { reason: "network" }),
      reason: "network", statusCode: undefined,
    },
    {
      name: "a timeout",
      error: new DeliveryError("Delivery deadline expired", { reason: "timeout" }),
      reason: "timeout", statusCode: undefined,
    },
    {
      name: "an unclassified delivery error",
      error: new DeliveryError("Unclassified failure"),
      reason: "unknown", statusCode: undefined,
    },
    {
      name: "a rate-limited receiver",
      error: new DeliveryError("Receiver rate limited", { reason: "http_status", statusCode: 429 }),
      reason: "http_status", statusCode: 429,
    },
    {
      name: "an unavailable receiver",
      error: new DeliveryError("Receiver unavailable", { reason: "http_status", statusCode: 503 }),
      reason: "http_status", statusCode: 503,
    },
    {
      name: "an unexpected exception",
      error: new Error("Unexpected failure"),
      reason: "unexpected", statusCode: undefined,
    },
    {
      name: "a non-Error rejection",
      error: "Unexpected rejection",
      reason: "unexpected", statusCode: undefined,
    },
  ])("logs searchable fields for $name", async ({ error, reason, statusCode }) => {
    app = buildApp({
      logger: captured.logger,
      telemetry: new OpenTelemetryDeliveryTelemetry(provider.getTracer("log-test")),
      deliveryClient: { async deliver() { throw error; } },
    });
    const response = await app.inject({
      method: "POST",
      url: "/events",
      payload: { eventType: "invoice.created", data: {} },
    });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const failures = captured.records.filter((record) => record.msg === "Webhook delivery failed");
    expect(failures).toHaveLength(1);
    const failure = failures[0];

    expect(failure).toMatchObject({
      level: 50,
      failureReason: reason,
      durationMs: expect.any(Number),
      reqId: response.headers["x-request-id"],
      traceId: spans[0]?.spanContext().traceId,
      spanId: spans[0]?.spanContext().spanId,
    });
    expect(failure).toHaveProperty("err");
    expect(failure?.failureReason).toBe(spans[0]?.attributes["webhook.delivery.failure_reason"]);
    expect(spans[0]?.attributes["webhook.event.id"]).toBe(response.json<{ eventId: string }>().eventId);
    if (statusCode === undefined) expect(failure).not.toHaveProperty("statusCode");
    else expect(failure?.statusCode).toBe(statusCode);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      eventId: expect.any(String),
      status: "failed",
      error: "Webhook delivery failed",
    });
  }, 15_000);
});
