import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpDeliveryClient } from "./delivery.js";
import { shutdownTelemetry } from "./instrumentation.js";
import { shutdownResources } from "./lifecycle.js";

const config = loadConfig();
const deliveryClient = new HttpDeliveryClient(
  config.deliveryTargetUrl,
  config.deliveryTimeoutMs,
);
const app = buildApp({
  deliveryClient,
  mockReceiverStatusCode: config.mockReceiverStatusCode,
});

let resourceShutdown: Promise<void> | undefined;
let shutdownStarted = false;

function stopResources(): Promise<void> {
  resourceShutdown ??= shutdownResources(() => app.close(), shutdownTelemetry);
  return resourceShutdown;
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  try {
    app.log.info({ signal }, "Server shutdown started");
    await stopResources();
  } catch (error) {
    app.log.error(error, "Server shutdown failed");
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, "Server failed to start");
  process.exitCode = 1;

  try {
    await stopResources();
  } catch (cleanupError) {
    app.log.error(cleanupError, "Startup cleanup failed");
  }
}
