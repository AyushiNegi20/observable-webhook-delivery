import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const maxMetricExportIntervalMs = 2_147_483_647;

function readServiceName(): string {
  const name = (process.env.OTEL_SERVICE_NAME ?? "webhook-api").trim();
  if (name === "") {
    throw new Error("Expected OTEL_SERVICE_NAME to be a non-empty value");
  }

  return name;
}

function readMetricExportInterval(): number {
  const value = process.env.OTEL_METRIC_EXPORT_INTERVAL_MS;
  if (value === undefined) {
    return 5000;
  }

  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > maxMetricExportIntervalMs
  ) {
    throw new Error(
      `Expected OTEL_METRIC_EXPORT_INTERVAL_MS to be an integer between 1 and ${maxMetricExportIntervalMs} but received: ${value}`,
    );
  }

  return parsed;
}

const sdk = new NodeSDK({
  serviceName: readServiceName(),
  resource: resourceFromAttributes({
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

let shutdownPromise: Promise<void> | undefined;

export function shutdownTelemetry(): Promise<void> {
  shutdownPromise ??= sdk.shutdown();
  return shutdownPromise;
}
