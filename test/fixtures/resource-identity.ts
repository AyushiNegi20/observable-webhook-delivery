import {
  AggregationTemporality,
  ConsoleMetricExporter,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

async function inspectResourceIdentity() {
  const spans = new InMemorySpanExporter();
  const measurements = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const originalSpanExport = ConsoleSpanExporter.prototype.export;
  const originalMetricExport = ConsoleMetricExporter.prototype.export;
  // Keep the production providers and resource detection, but capture their exports.
  ConsoleSpanExporter.prototype.export = spans.export.bind(spans);
  ConsoleMetricExporter.prototype.export = measurements.export.bind(measurements);
  const { shutdownTelemetry } = await import("../../src/instrumentation.js");

  try {
    const { OpenTelemetryDeliveryTelemetry } = await import("../../src/telemetry.js");
    const { DeliveryError } = await import("../../src/delivery.js");
    const telemetry = new OpenTelemetryDeliveryTelemetry();
    await telemetry.trackDelivery("invoice.created", async () => {});
    const failure = new DeliveryError("Synthetic receiver failure", {
      reason: "http_status", statusCode: 503,
    });
    await telemetry.trackDelivery("invoice.created", async () => { throw failure; })
      .catch((error: unknown) => { if (error !== failure) throw error; });
    await shutdownTelemetry();

    return {
      spans: spans.getFinishedSpans().map((span) => ({
        resource: span.resource.attributes,
        attributes: span.attributes,
      })),
      batches: measurements.getMetrics().map((batch) => ({
        resource: batch.resource.attributes,
        metrics: batch.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => ({
          name: metric.descriptor.name,
          attributes: metric.dataPoints.map((point) => point.attributes),
        }))),
      })),
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

export type ResourceIdentityResult = Awaited<ReturnType<typeof inspectResourceIdentity>>;

console.log("RESOURCE_IDENTITY=" + JSON.stringify(await inspectResourceIdentity()));
