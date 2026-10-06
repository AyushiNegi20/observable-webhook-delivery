import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

const webhook = {
  id: "a545a04d-5380-4d9c-bca8-37f20936e942",
  eventType: "invoice.created",
  data: { invoiceId: "inv_123" },
  createdAt: "2026-08-25T00:00:00.000Z",
};

describe.each(["/events", "/mock/webhooks"])("%s JSON validation", (url) => {
  let app: FastifyInstance;
  const deliver = vi.fn(async () => {});
  const payload = url === "/events"
    ? { eventType: webhook.eventType, data: webhook.data }
    : webhook;

  beforeEach(async () => {
    deliver.mockClear();
    app = buildApp({ deliveryClient: { deliver }, logger: false });
    await app.ready();
  }, 15_000);

  afterEach(async () => {
    await app.close();
  });

  it.each([
    { name: "a numeric event type", field: "eventType", value: 123 },
    { name: "a boolean event type", field: "eventType", value: true },
    { name: "an array event type", field: "eventType", value: ["invoice.created"] },
    { name: "an array data field", field: "data", value: [{ invoiceId: "inv_123" }] },
    { name: "a null data field", field: "data", value: null },
    { name: "a string data field", field: "data", value: "invoice" },
  ])("rejects $name without coercion", async ({ field, value }) => {
    const response = await app.inject({
      method: "POST",
      url,
      payload: { ...payload, [field]: value },
    });

    expect(response.statusCode).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("accepts mixed JSON values inside the data object", async () => {
    const data = {
      amount: 120,
      paid: false,
      note: null,
      items: [{ quantity: 2 }],
      metadata: { reference: "00123" },
    };
    const response = await app.inject({
      method: "POST",
      url,
      payload: { ...payload, data },
    });

    expect(response.statusCode).toBe(url === "/events" ? 201 : 200);
    if (url === "/events") {
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ eventType: webhook.eventType, data }),
      );
    } else {
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  if (url === "/mock/webhooks") {
    it.each(["id", "createdAt"] as const)("rejects an array %s", async (field) => {
      const response = await app.inject({
        method: "POST",
        url,
        payload: { ...webhook, [field]: [webhook[field]] },
      });

      expect(response.statusCode).toBe(400);
    });
  }
});
