import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

function readMetricExportInterval(): number {
  const value = process.env.OTEL_METRIC_EXPORT_INTERVAL_MS;
  if (value === undefined) {
    return 5000;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Expected OTEL_METRIC_EXPORT_INTERVAL_MS to be a positive integer but received: ${value}`,
    );
  }

  return parsed;
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "webhook-api",
    [ATTR_SERVICE_VERSION]: "0.2.0",
  }),
  traceExporter: new ConsoleSpanExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter(),
    exportIntervalMillis: readMetricExportInterval(),
  }),
  logRecordProcessors: [],
  instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
});

sdk.start();

let shutdownStarted = false;

export async function shutdownTelemetry(): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  await sdk.shutdown();
}
