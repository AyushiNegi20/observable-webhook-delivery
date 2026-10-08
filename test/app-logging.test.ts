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
});
