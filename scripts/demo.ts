import { shutdownTelemetry } from "../src/instrumentation.js";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HttpDeliveryClient } from "../src/delivery.js";
import { shutdownResources } from "../src/lifecycle.js";

const scenarios = {
  success: { receiverStatus: 200, delayMs: 0, timeoutMs: 3000, apiStatus: 201 },
  rejected: { receiverStatus: 503, delayMs: 0, timeoutMs: 3000, apiStatus: 502 },
  timeout: { receiverStatus: 200, delayMs: 1500, timeoutMs: 1000, apiStatus: 502 },
} as const;

let app: FastifyInstance | undefined;
let receiverWaitTimer: ReturnType<typeof setTimeout> | undefined;

try {
  const scenario = process.argv[2] ?? "success";
  if (process.argv.length > 3 || (scenario !== "success" && scenario !== "rejected" && scenario !== "timeout")) {
    throw new Error("Usage: pnpm demo [success|rejected|timeout]");
  }
  const settings = scenarios[scenario];
  // Only the logging setting is reused. Demo traffic must stay on loopback.
  const { logLevel } = loadConfig({ LOG_LEVEL: process.env.LOG_LEVEL });
  let receiverFinished!: () => void;
  const receiverCompletion = new Promise<void>((resolve) => { receiverFinished = resolve; });
  app = buildApp({
    logLevel,
    mockReceiverStatusCode: settings.receiverStatus,
    mockReceiverDelayMs: settings.delayMs,
    deliveryClient: {
      async deliver(event) {
        await new HttpDeliveryClient(receiverUrl, settings.timeoutMs).deliver(event);
      },
    },
  });
  app.addHook("onSend", async (request) => {
    if (request.url === "/mock/webhooks") receiverFinished();
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const receiverUrl = `${address}/mock/webhooks`;

  const response = await fetch(`${address}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventType: "invoice.created", data: { invoiceId: "inv_demo", amount: 120 } }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as Record<string, unknown>;
  const expectedStatus = scenario === "success" ? "delivered" : "failed";
  if (response.status !== settings.apiStatus || result.status !== expectedStatus || typeof result.eventId !== "string") {
    throw new Error(`Unexpected demo response: HTTP ${response.status}`);
  }
  // A sender timeout does not cancel the receiver's handler.
  await Promise.race([
    receiverCompletion,
    new Promise<never>((_, reject) => {
      receiverWaitTimer = setTimeout(() => reject(new Error("Demo receiver did not finish")), 10_000);
    }),
  ]);
  console.log("DEMO_RESULT=" + JSON.stringify({
    scenario, statusCode: response.status, eventId: result.eventId, deliveryStatus: result.status,
  }));
} catch (error) {
  console.error("Demo failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(receiverWaitTimer);
  try {
    await shutdownResources(async () => { await app?.close(); }, shutdownTelemetry);
  } catch (error) {
    console.error("Demo cleanup failed:", error);
    process.exitCode = 1;
  }
}
