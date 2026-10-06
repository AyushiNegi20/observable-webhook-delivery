import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("request identifiers", () => {
  const apps: FastifyInstance[] = [];

  function createApp(failDelivery = false): FastifyInstance {
    const app = buildApp({
      logger: false,
      deliveryClient: {
        async deliver() {
          if (failDelivery) {
            throw new Error("Receiver unavailable");
          }
        },
      },
    });
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("generates distinct UUIDs across requests and application instances", async () => {
    const instances = [createApp(), createApp()];
    const responses = await Promise.all(
      instances.flatMap((app) =>
        Array.from({ length: 3 }, () => app.inject({ method: "GET", url: "/health" })),
      ),
    );
    const ids = responses.map((response) => response.headers["x-request-id"]);

    for (const id of ids) {
      expect(id).toMatch(uuidPattern);
    }
    expect(new Set(ids).size).toBe(6);
  }, 15_000);

  it.each([
    {
      name: "health response",
      request: { method: "GET", url: "/health" },
      statusCode: 200,
    },
    {
      name: "successful delivery",
      request: {
        method: "POST",
        url: "/events",
        payload: { eventType: "invoice.created", data: {} },
      },
      statusCode: 201,
    },
    {
      name: "validation error",
      request: { method: "POST", url: "/events", payload: { eventType: 123, data: {} } },
      statusCode: 400,
    },
    {
      name: "missing route",
      request: { method: "GET", url: "/missing" },
      statusCode: 404,
    },
    {
      name: "failed delivery",
      request: {
        method: "POST",
        url: "/events",
        payload: { eventType: "invoice.created", data: {} },
      },
      statusCode: 502,
    },
  ] as const)("returns a server-generated ID for a $name", async ({ request, statusCode }) => {
    const app = createApp(statusCode === 502);
    const suppliedId = "client-controlled-id";
    const response = await app.inject({
      ...request,
      headers: { "x-request-id": suppliedId },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.headers["x-request-id"]).toMatch(uuidPattern);
    expect(response.headers["x-request-id"]).not.toBe(suppliedId);
  }, 15_000);
});
