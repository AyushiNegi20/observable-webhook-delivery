import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeliveryError,
  HttpDeliveryClient,
  type WebhookEvent,
} from "../src/delivery.js";

const event: WebhookEvent = {
  id: "a545a04d-5380-4d9c-bca8-37f20936e942",
  eventType: "invoice.created",
  data: { invoiceId: "inv_123" },
  createdAt: "2026-08-25T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP delivery client", () => {
  it("posts the event to the configured destination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpDeliveryClient("http://receiver.test/webhooks", 1000);

    await client.deliver(event);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://receiver.test/webhooks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(event),
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "observable-webhook-delivery",
          "x-webhook-attempt": "1",
          "x-webhook-created-at": "2026-08-25T00:00:00.000Z",
          "x-webhook-event": "invoice.created",
          "x-webhook-id": "a545a04d-5380-4d9c-bca8-37f20936e942",
          "x-webhook-schema-version": "1",
        },
      }),
    );
  });

  it("reports unsuccessful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const client = new HttpDeliveryClient("http://receiver.test/webhooks", 1000);

    await expect(client.deliver(event)).rejects.toThrow(
      new DeliveryError("Webhook destination responded with status 503"),
    );
  });

  it("accepts a no-content success response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    const client = new HttpDeliveryClient("http://receiver.test/webhooks", 1000);

    await expect(client.deliver(event)).resolves.toBeUndefined();
  });

  it("wraps network failures as delivery errors", async () => {
    const networkError = new Error("Connection refused");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    const client = new HttpDeliveryClient("http://receiver.test/webhooks", 1000);

    await expect(client.deliver(event)).rejects.toMatchObject({
      name: "DeliveryError",
      message: "Webhook destination could not be reached",
      cause: networkError,
    });
  });
});
