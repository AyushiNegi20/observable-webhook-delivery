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
        headers: {
          "content-type": "application/json",
          "x-webhook-event": "invoice.created",
          "x-webhook-id": "a545a04d-5380-4d9c-bca8-37f20936e942",
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
});
