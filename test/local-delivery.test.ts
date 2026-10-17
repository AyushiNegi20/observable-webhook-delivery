import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HttpDeliveryClient, type WebhookEvent } from "../src/delivery.js";

describe.each([
  { label: "IPv4", host: "127.0.0.1", urlHost: "127.0.0.1", peer: "127.0.0.1" },
  { label: "IPv6", host: " ::1 ", urlHost: "[::1]", peer: "::1" },
])("local receiver over $label", ({ label, host, urlHost, peer }) => {
  it("delivers through the API and mock receiver", async ({ skip }) => {
    const received: { event: WebhookEvent; peer: string; host: string | undefined }[] = [];
    let deliveryClient: HttpDeliveryClient;
    const app = buildApp({
      logger: false,
      deliveryClient: { async deliver(event) { await deliveryClient.deliver(event); } },
    });
    app.addHook("preHandler", async (request) => {
      if (request.url === "/mock/webhooks") {
        received.push({
          event: request.body as WebhookEvent,
          peer: request.ip,
          host: request.headers.host,
        });
      }
    });

    try {
      const { host: bindHost } = loadConfig({ HOST: host });
      try {
        // Use an OS-assigned port to avoid conflicts with a running demo.
        await app.listen({ host: bindHost, port: 0 });
      } catch (error) {
        if (label === "IPv6" && error instanceof Error && "code" in error
          && (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")) {
          skip();
          return;
        }
        throw error;
      }
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected the application to bind a TCP port");
      }
      const config = loadConfig({ HOST: host, PORT: String(address.port) });
      const baseUrl = `http://${urlHost}:${address.port}`;
      expect(config.deliveryTargetUrl).toBe(`${baseUrl}/mock/webhooks`);
      deliveryClient = new HttpDeliveryClient(config.deliveryTargetUrl, config.deliveryTimeoutMs);

      const response = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventType: "invoice.created", data: { invoiceId: "inv_local" } }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { eventId: string; status: string };
      expect(response.status).toBe(201);
      expect(result).toEqual({ eventId: expect.any(String), status: "delivered" });
      expect(received).toEqual([{
        peer,
        host: `${urlHost}:${address.port}`,
        event: {
          id: result.eventId,
          eventType: "invoice.created",
          data: { invoiceId: "inv_local" },
          createdAt: expect.any(String),
        },
      }]);
    } finally {
      await app.close();
    }
  }, 20_000);
});
