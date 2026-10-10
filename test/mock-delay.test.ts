import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

const webhook = {
  id: "a545a04d-5380-4d9c-bca8-37f20936e942",
  eventType: "invoice.created",
  data: { invoiceId: "inv_123" },
  createdAt: "2026-08-25T00:00:00.000Z",
};

describe("mock receiver delay", () => {
  it.each([200, 503])("delays a %i response without blocking health checks", async (statusCode) => {
    const app = buildApp({
      deliveryClient: { deliver: async () => {} },
      logger: false,
      mockReceiverDelayMs: 250,
      mockReceiverStatusCode: statusCode,
    });
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    app.addHook("preHandler", async (request) => {
      if (request.url === "/mock/webhooks") entered();
    });
    await app.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finished = false;
    const delivery = app.inject({ method: "POST", url: "/mock/webhooks", payload: webhook })
      .then((response) => { finished = true; return response; });

    try {
      await handlerEntered;
      await vi.advanceTimersByTimeAsync(249);
      expect(finished).toBe(false);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(finished).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const response = await delivery;
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({ received: statusCode === 200 });
    } finally {
      try {
        await vi.runAllTimersAsync();
        await delivery;
      } finally {
        vi.useRealTimers();
        await app.close();
      }
    }
  }, 15_000);
});
