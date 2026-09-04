export interface WebhookEvent {
  id: string;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface DeliveryClient {
  deliver(event: WebhookEvent): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeliveryError";
  }
}

export class HttpDeliveryClient implements DeliveryClient {
  constructor(
    private readonly targetUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async deliver(event: WebhookEvent): Promise<void> {
    let response: Response;

    try {
      response = await fetch(this.targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-event": event.eventType,
          "x-webhook-id": event.id,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DeliveryError("Webhook destination could not be reached", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new DeliveryError(
        `Webhook destination responded with status ${response.status}`,
      );
    }
  }
}
