import "./environment.js";

import { randomUUID } from "node:crypto";

import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { serviceVersion } from "./service-metadata.js";

const maxMetricExportIntervalMs = 2_147_483_647;

function readTraceHealthChecks(): boolean {
  const value = (process.env.OTEL_TRACE_HEALTHCHECKS ?? "false").trim();
  if (value !== "true" && value !== "false") {
    throw new Error("Expected OTEL_TRACE_HEALTHCHECKS to be true or false");
  }
  return value === "true";
}

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

const traceHealthChecks = readTraceHealthChecks();
const sdk = new NodeSDK({
  serviceName: readServiceName(),
  // Receivers need trace context, not arbitrary baggage from API callers.
  textMapPropagator: new W3CTraceContextPropagator(),
  resource: resourceFromAttributes({
    [ATTR_SERVICE_INSTANCE_ID]: randomUUID(),
    [ATTR_SERVICE_VERSION]: serviceVersion,
  }),
  traceExporter: new ConsoleSpanExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter(),
    exportIntervalMillis: readMetricExportInterval(),
  }),
  logRecordProcessors: [],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        !traceHealthChecks
        && (request.method === "GET" || request.method === "HEAD")
        && request.url?.split("?", 1)[0] === "/health",
    }),
    new UndiciInstrumentation(),
  ],
});

sdk.start();

let shutdownPromise: Promise<void> | undefined;

export function shutdownTelemetry(): Promise<void> {
  shutdownPromise ??= sdk.shutdown();
  return shutdownPromise;
}
