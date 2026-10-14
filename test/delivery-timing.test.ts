import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { captureLogger } from "./helpers/capture-logger.js";

describe("delivery timing logs", () => {
  let captured: ReturnType<typeof captureLogger>;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
    captured = captureLogger();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await app?.close();
    } finally {
      await captured.close();
    }
  });

  it.each([
    { failed: false, elapsedMs: 0 },
    { failed: false, elapsedMs: 125.5 },
    { failed: true, elapsedMs: 0 },
    { failed: true, elapsedMs: 125.5 },
  ])("records $elapsedMs ms when failed=$failed", async ({ failed, elapsedMs }) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    app = buildApp({
      logger: captured.logger,
      deliveryClient: {
        async deliver() {
          await Promise.resolve();
          clock.mockReturnValue(1000 + elapsedMs);
          if (failed) throw new Error("Receiver unavailable");
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/events",
      payload: { eventType: "invoice.created", data: { invoiceId: "inv_123" } },
    });
    const eventId = response.json<{ eventId: string }>().eventId;
    const logs = captured.records.filter((record) => record.eventId === eventId);

    expect(response.statusCode).toBe(failed ? 502 : 201);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.msg).toBe("Webhook delivery started");
    expect(logs[0]).not.toHaveProperty("durationMs");
    expect(logs[1]).toMatchObject({
      msg: failed ? "Webhook delivery failed" : "Webhook delivery completed",
      durationMs: elapsedMs,
      reqId: response.headers["x-request-id"],
      eventId,
    });
    expect(response.json()).not.toHaveProperty("durationMs");
  }, 15_000);
});
