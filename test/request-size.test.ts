import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

const sizeCases = [
  { encoding: "ASCII", unit: "a" },
  { encoding: "two-byte UTF-8", unit: "\u00e9" },
  { encoding: "three-byte UTF-8", unit: "\u6f22" },
].flatMap((content) => [-1, 0, 1].map((offset) => ({ ...content, offset })));

describe.each([
  { url: "/events", limit: 256 * 1024, successStatus: 201 },
  { url: "/mock/webhooks", limit: 2 * 1024 * 1024, successStatus: 200 },
])("$url request size", ({ url, limit, successStatus }) => {
  let app: FastifyInstance;
  const deliver = vi.fn(async () => {});

  beforeEach(async () => {
    deliver.mockClear();
    app = buildApp({ deliveryClient: { deliver }, logger: false });
    await app.ready();
  }, 15_000);

  afterEach(async () => {
    await app.close();
  });

  it.each(sizeCases)("enforces the byte limit for $encoding at offset $offset", async ({ unit, offset }) => {
    const envelope = url === "/mock/webhooks" ? {
      id: "a545a04d-5380-4d9c-bca8-37f20936e942",
      createdAt: "2026-08-25T00:00:00.000Z",
    } : {};
    const serialize = (note: string) => JSON.stringify({
      ...envelope, eventType: "invoice.created", data: { note },
    });
    const available = limit + offset - Buffer.byteLength(serialize(""));
    const unitBytes = Buffer.byteLength(unit);
    const note = unit.repeat(Math.floor(available / unitBytes)) + "a".repeat(available % unitBytes);
    const payload = serialize(note);

    expect(Buffer.byteLength(payload)).toBe(limit + offset);
    if (unitBytes > 1) expect(payload.length).toBeLessThan(Buffer.byteLength(payload));
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(offset > 0 ? 413 : successStatus);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBeTruthy();
    if (url === "/events" && offset <= 0) {
      expect(deliver).toHaveBeenCalledOnce();
    } else {
      expect(deliver).not.toHaveBeenCalled();
    }
    if (offset > 0) {
      expect(response.json()).toMatchObject({ statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" });
    }
  }, 15_000);
});
