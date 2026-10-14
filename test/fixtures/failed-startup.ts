import { metrics, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  DataPointType,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

async function inspectFailedStartup() {
  const spans = new InMemorySpanExporter();
  const measurements = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const originalSpanExport = ConsoleSpanExporter.prototype.export;
  const originalMetricExport = ConsoleMetricExporter.prototype.export;
  // Keep the real SDK lifecycle, but capture its exports inside this child process.
  ConsoleSpanExporter.prototype.export = spans.export.bind(spans);
  ConsoleMetricExporter.prototype.export = measurements.export.bind(measurements);
  const { shutdownTelemetry } = await import("../../src/instrumentation.js");

  try {
    trace.getTracer("startup-test").startSpan("startup.probe").end();
    metrics.getMeter("startup-test").createCounter("startup.probe").add(1);
    const beforeStartup = {
      spans: spans.getFinishedSpans().length,
      metricBatches: measurements.getMetrics().length,
    };
    let importError: string | null = null;
    try {
      await import("../../src/server.js");
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    }

    // Take a snapshot before fallback cleanup so it cannot hide a missing flush.
    return {
      beforeStartup,
      exitCode: process.exitCode ?? null,
      importError,
      spanNames: spans.getFinishedSpans().map((span) => span.name),
      counterValues: measurements.getMetrics().flatMap((batch) =>
        batch.scopeMetrics.flatMap((scope) => scope.metrics.flatMap((metric) =>
          metric.descriptor.name === "startup.probe" && metric.dataPointType === DataPointType.SUM
            ? metric.dataPoints.map((point) => point.value)
            : [],
        )),
      ),
    };
  } finally {
    try {
      await shutdownTelemetry();
    } finally {
      ConsoleSpanExporter.prototype.export = originalSpanExport;
      ConsoleMetricExporter.prototype.export = originalMetricExport;
    }
  }
}

export type FailedStartupResult = Awaited<ReturnType<typeof inspectFailedStartup>>;

console.log("FAILED_STARTUP=" + JSON.stringify(await inspectFailedStartup()));
