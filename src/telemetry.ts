import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";

const instrumentationName = "observable-webhook-delivery";

export interface DeliveryTelemetry {
  trackDelivery<T>(eventType: string, operation: () => Promise<T>): Promise<T>;
}

export class OpenTelemetryDeliveryTelemetry implements DeliveryTelemetry {
  private readonly attempts: Counter;
  private readonly failures: Counter;
  private readonly duration: Histogram;

  constructor(
    private readonly tracer: Tracer = trace.getTracer(instrumentationName),
    meter: Meter = metrics.getMeter(instrumentationName),
  ) {
    this.attempts = meter.createCounter("webhook.delivery.attempts", {
      description: "Number of webhook delivery attempts",
      unit: "{attempt}",
    });
    this.failures = meter.createCounter("webhook.delivery.failures", {
      description: "Number of failed webhook deliveries",
      unit: "{failure}",
    });
    this.duration = meter.createHistogram("webhook.delivery.duration", {
      description: "Time spent delivering a webhook",
      unit: "ms",
    });
  }

  async trackDelivery<T>(
    eventType: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const attributes: Attributes = {
      "webhook.event.type": eventType,
      "webhook.delivery.system": "http",
    };

    this.attempts.add(1, attributes);

    return this.tracer.startActiveSpan(
      "webhook.deliver",
      { attributes },
      async (span) => {
        const startedAt = performance.now();
        let result = "success";

        try {
          return await operation();
        } catch (error) {
          result = "failure";
          this.failures.add(1, attributes);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Webhook delivery failed",
          });

          if (error instanceof Error) {
            span.recordException(error);
          }

          throw error;
        } finally {
          this.duration.record(performance.now() - startedAt, {
            ...attributes,
            "webhook.delivery.result": result,
          });
          span.end();
        }
      },
    );
  }
}

export function activeTraceFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) {
    return {};
  }

  const context = span.spanContext();
  return {
    traceId: context.traceId,
    spanId: context.spanId,
  };
}
