import {
  isSpanContextValid,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type Tracer,
  type UpDownCounter,
} from "@opentelemetry/api";

import { DeliveryError } from "./delivery.js";

const instrumentationName = "observable-webhook-delivery";

export interface DeliveryTelemetry {
  trackDelivery<T>(eventType: string, operation: () => Promise<T>): Promise<T>;
}

export class OpenTelemetryDeliveryTelemetry implements DeliveryTelemetry {
  private readonly attempts: Counter;
  private readonly failures: Counter;
  private readonly active: UpDownCounter;
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
    this.active = meter.createUpDownCounter("webhook.delivery.active", {
      description: "Number of webhook deliveries currently in progress",
      unit: "{delivery}",
    });
    this.duration = meter.createHistogram("webhook.delivery.duration", {
      description: "Time spent delivering a webhook",
      unit: "ms",
      advice: {
        explicitBucketBoundaries: [
          0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2000, 2500, 3000,
          5000, 7500, 10000, 30000, 60000,
        ],
      },
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
        this.active.add(1, attributes);

        try {
          return await operation();
        } catch (error) {
          result = "failure";
          const failureReason = error instanceof DeliveryError ? error.reason : "unexpected";
          span.setAttribute("webhook.delivery.failure_reason", failureReason);
          if (error instanceof DeliveryError && error.statusCode !== undefined) {
            span.setAttribute("http.response.status_code", error.statusCode);
          }
          this.failures.add(1, {
            ...attributes,
            "webhook.delivery.failure_reason": failureReason,
          });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Webhook delivery failed",
          });

          if (error instanceof Error) {
            span.recordException(error);
          }

          throw error;
        } finally {
          this.active.add(-1, attributes);
          span.setAttribute("webhook.delivery.result", result);
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
  if (!isSpanContextValid(context)) {
    return {};
  }

  return {
    traceId: context.traceId,
    spanId: context.spanId,
  };
}
