import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpDeliveryClient } from "./delivery.js";
import { shutdownTelemetry } from "./instrumentation.js";

const config = loadConfig();
const deliveryClient = new HttpDeliveryClient(
  config.deliveryTargetUrl,
  config.deliveryTimeoutMs,
);
const app = buildApp({
  deliveryClient,
  mockReceiverStatusCode: config.mockReceiverStatusCode,
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  try {
    app.log.info({ signal }, "Server shutdown started");
    await app.close();
    await shutdownTelemetry();
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
}
