import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { HttpDeliveryClient, type WebhookEvent } from "../src/delivery.js";

describe("delivery payload size", () => {
  it.each(["text", "exponent numbers"])("delivers %s at the API limit after serialization", async (content) => {
    const limit = 256 * 1024;
    const empty = JSON.stringify({ eventType: "invoice.created", data: { note: "" } });
    const note = "a".repeat(limit - Buffer.byteLength(empty));
    let payload = JSON.stringify({ eventType: "invoice.created", data: { note } });
    if (content === "exponent numbers") {
      const prefix = '{"eventType":"invoice.created","data":{"values":[';
      const suffix = ']}}';
      const count = Math.floor((limit - Buffer.byteLength(prefix + suffix) + 1) / 5);
      payload = (prefix + Array<string>(count).fill("1e20").join(",") + suffix).padEnd(limit, " ");
    }
    const expectedData = (JSON.parse(payload) as { data: Record<string, unknown> }).data;
    const received: WebhookEvent[] = [];
    let targetUrl: string;
    const app = buildApp({
      logger: false,
      deliveryClient: {
        async deliver(event) {
          await new HttpDeliveryClient(targetUrl, 5000).deliver(event);
        },
      },
    });
    app.addHook("preHandler", async (request) => {
      if (request.url === "/mock/webhooks") received.push(request.body as WebhookEvent);
    });

    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      targetUrl = `${address}/mock/webhooks`;
      expect(Buffer.byteLength(payload)).toBe(limit);
      const response = await fetch(`${address}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { eventId: string; status: string };

      expect(response.status).toBe(201);
      expect(result.status).toBe("delivered");
      expect(received).toHaveLength(1);
      expect(received[0]?.id).toBe(result.eventId);
      expect(received[0]?.eventType).toBe("invoice.created");
      expect(JSON.stringify(received[0]?.data) === JSON.stringify(expectedData)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(received[0]))).toBeGreaterThan(limit);
    } finally {
      await app.close();
    }
  }, 20_000);
});
