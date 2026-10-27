import {
  AggregationTemporality,
  ConsoleMetricExporter,
  DataPointType,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

const spans = new InMemorySpanExporter();
const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const originalSpanExport = ConsoleSpanExporter.prototype.export;
const originalMetricExport = ConsoleMetricExporter.prototype.export;
ConsoleSpanExporter.prototype.export = spans.export.bind(spans);
ConsoleMetricExporter.prototype.export = metrics.export.bind(metrics);

try {
  await import("../../scripts/demo.js");
  // The command must flush its own exporters before this snapshot is taken.
  console.log("DEMO_TELEMETRY=" + JSON.stringify({
    spans: spans.getFinishedSpans().map((span) => ({
      name: span.name, traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId, attributes: span.attributes,
    })),
    metrics: metrics.getMetrics().at(-1)?.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => ({
      name: metric.descriptor.name,
      points: metric.dataPoints.map((point) => ({
        attributes: point.attributes,
        value: point.value,
      })),
      histogram: metric.dataPointType === DataPointType.HISTOGRAM,
    }))) ?? [],
  }));
} finally {
  ConsoleSpanExporter.prototype.export = originalSpanExport;
  ConsoleMetricExporter.prototype.export = originalMetricExport;
}
