export interface WebhookEvent {
  id: string;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface DeliveryClient {
  deliver(event: WebhookEvent): Promise<void>;
}

export type DeliveryFailureReason = "network" | "timeout" | "http_status" | "unknown";

export class DeliveryError extends Error {
  readonly reason: DeliveryFailureReason;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: DeliveryFailureReason;
      statusCode?: number;
    },
  ) {
    super(message, options);
    this.name = "DeliveryError";
    this.reason = options?.reason ?? "unknown";
    this.statusCode = options?.statusCode;
  }
}

export class HttpDeliveryClient implements DeliveryClient {
  constructor(
    private readonly targetUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async deliver(event: WebhookEvent): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;

    try {
      response = await fetch(this.targetUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "observable-webhook-delivery",
          "x-webhook-attempt": "1",
          "x-webhook-created-at": event.createdAt,
          "x-webhook-event": event.eventType,
          "x-webhook-id": event.id,
          "x-webhook-schema-version": "1",
        },
        body: JSON.stringify(event),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw new DeliveryError(
        signal.aborted
          ? `Webhook destination timed out after ${this.timeoutMs} ms`
          : "Webhook destination could not be reached",
        { cause: error, reason: signal.aborted ? "timeout" : "network" },
      );
    }

    await response.body?.cancel().catch(() => {
      // Cleanup must not override the delivery result from the HTTP status.
    });

    if (!response.ok) {
      throw new DeliveryError(
        `Webhook destination responded with status ${response.status}`,
        { reason: "http_status", statusCode: response.status },
      );
    }
  }
}
