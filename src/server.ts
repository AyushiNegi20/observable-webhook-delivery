import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpDeliveryClient } from "./delivery.js";
import { shutdownTelemetry } from "./instrumentation.js";
import { shutdownResources } from "./lifecycle.js";

let app: FastifyInstance | undefined;
let resourceShutdown: Promise<void> | undefined;
let shutdownStarted = false;

function stopResources(): Promise<void> {
  resourceShutdown ??= shutdownResources(async () => { await app?.close(); }, shutdownTelemetry);
  return resourceShutdown;
}

function reportError(error: unknown, message: string): void {
  if (app === undefined) {
    console.error(message, error);
  } else {
    app.log.error(error, message);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  try {
    app?.log.info({ signal }, "Server shutdown started");
    await stopResources();
  } catch (error) {
    reportError(error, "Server shutdown failed");
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}

try {
  const config = loadConfig();
  const deliveryClient = new HttpDeliveryClient(
    config.deliveryTargetUrl,
    config.deliveryTimeoutMs,
  );
  app = buildApp({
    deliveryClient,
    mockReceiverDelayMs: config.mockReceiverDelayMs,
    mockReceiverStatusCode: config.mockReceiverStatusCode,
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  reportError(error, "Server failed to start");
  process.exitCode = 1;

  try {
    await stopResources();
  } catch (cleanupError) {
    reportError(cleanupError, "Startup cleanup failed");
  }
}
