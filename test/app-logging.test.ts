import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { captureLogger } from "./helpers/capture-logger.js";

describe("application logging", () => {
  let captured: ReturnType<typeof captureLogger>;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
    captured = captureLogger();
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      await captured.close();
    }
  });

  it("uses a supplied logger with its bindings and request serializer", async () => {
    app = buildApp({
      deliveryClient: { deliver: async () => {} },
      logger: captured.logger,
    });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const incoming = captured.records.find((record) => record.msg === "incoming request");
    expect(incoming).toMatchObject({
      component: "logging-test",
      reqId: response.headers["x-request-id"],
      req: { method: "GET", url: "/health" },
    });
  }, 15_000);

  it("writes delivery logs through the supplied logger", async () => {
    app = buildApp({
      deliveryClient: { deliver: async () => {} },
      logger: captured.logger,
    });
    const response = await app.inject({
      method: "POST",
      url: "/events",
      payload: { eventType: "invoice.created", data: { invoiceId: "inv_123" } },
    });
    const body = response.json<{ eventId: string }>();
    const deliveryLogs = captured.records.filter(
      (record) => record.eventId === body.eventId,
    );

    expect(response.statusCode).toBe(201);
    expect(deliveryLogs.map((record) => record.msg)).toEqual([
      "Webhook delivery started",
      "Webhook delivery completed",
    ]);
    for (const record of deliveryLogs) {
      expect(record).toMatchObject({
        component: "logging-test",
        reqId: response.headers["x-request-id"],
        eventType: "invoice.created",
      });
    }
  }, 15_000);

  it.each([
    { statusCode: 200, received: true },
    { statusCode: 204, received: true },
    { statusCode: 299, received: true },
    { statusCode: 300, received: false },
    { statusCode: 400, received: false },
    { statusCode: 429, received: false },
    { statusCode: 503, received: false },
    { statusCode: 599, received: false },
  ])("logs the mock receiver outcome for status $statusCode", async ({ statusCode, received }) => {
    app = buildApp({
      deliveryClient: { deliver: async () => {} },
      logger: captured.logger,
      mockReceiverStatusCode: statusCode,
    });
    const eventId = "a545a04d-5380-4d9c-bca8-37f20936e942";
    const payloadMarker = "mock-payload-not-for-logs";
    const response = await app.inject({
      method: "POST",
      url: "/mock/webhooks",
      payload: {
        id: eventId,
        eventType: "invoice.created",
        data: { note: payloadMarker },
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    });
    const receiverLogs = captured.records.filter((record) => record.eventId === eventId);

    expect(response.statusCode).toBe(statusCode);
    if (statusCode !== 204) {
      expect(response.json()).toEqual({ received });
    }
    expect(receiverLogs).toHaveLength(1);
    expect(receiverLogs[0]).toMatchObject({
      level: received ? 30 : 40,
      msg: received ? "Mock receiver accepted webhook" : "Mock receiver rejected webhook",
      reqId: response.headers["x-request-id"],
      eventId,
      eventType: "invoice.created",
      statusCode,
      received,
    });
    expect(JSON.stringify(captured.records)).not.toContain(payloadMarker);
  }, 15_000);
});
