import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpDeliveryClient } from "./delivery.js";

const config = loadConfig();
const deliveryClient = new HttpDeliveryClient(
  config.deliveryTargetUrl,
  config.deliveryTimeoutMs,
);
const app = buildApp({ deliveryClient });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, "Server failed to start");
  process.exitCode = 1;
}
