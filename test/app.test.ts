import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { DeliveryClient, WebhookEvent } from "../src/delivery.js";

function createDeliveryClient(
  implementation: (event: WebhookEvent) => Promise<void> = async () => {},
): DeliveryClient & { deliver: ReturnType<typeof vi.fn> } {
  return {
    deliver: vi.fn(implementation),
  };
}

describe("webhook delivery API", () => {
  it("reports its health", async () => {
    const app = buildApp({ deliveryClient: createDeliveryClient(), logger: false });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("delivers a valid event", async () => {
    const deliveryClient = createDeliveryClient();
    const app = buildApp({ deliveryClient, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/events",
      payload: {
        eventType: "invoice.created",
        data: { invoiceId: "inv_123", amount: 120 },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: "delivered" });
    expect(deliveryClient.deliver).toHaveBeenCalledOnce();
    expect(deliveryClient.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "invoice.created",
        data: { invoiceId: "inv_123", amount: 120 },
      }),
    );

    await app.close();
  });

  it("rejects an invalid event", async () => {
    const deliveryClient = createDeliveryClient();
    const app = buildApp({ deliveryClient, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/events",
      payload: { eventType: "invoice created" },
    });

    expect(response.statusCode).toBe(400);
    expect(deliveryClient.deliver).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns a gateway error when delivery fails", async () => {
    const deliveryClient = createDeliveryClient(async () => {
      throw new Error("Destination unavailable");
    });
    const app = buildApp({ deliveryClient, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/events",
      payload: {
        eventType: "invoice.created",
        data: { invoiceId: "inv_123" },
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      status: "failed",
      error: "Webhook delivery failed",
    });

    await app.close();
  });

  it("accepts a webhook at the mock receiver", async () => {
    const app = buildApp({ deliveryClient: createDeliveryClient(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/mock/webhooks",
      payload: {
        id: "a545a04d-5380-4d9c-bca8-37f20936e942",
        eventType: "invoice.created",
        data: { invoiceId: "inv_123" },
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await app.close();
  });
});
