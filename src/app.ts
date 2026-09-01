import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { DeliveryClient, WebhookEvent } from "./delivery.js";
import {
  activeTraceFields,
  OpenTelemetryDeliveryTelemetry,
  type DeliveryTelemetry,
} from "./telemetry.js";

interface EventRequestBody {
  eventType: string;
  data: Record<string, unknown>;
}

interface BuildAppOptions {
  deliveryClient: DeliveryClient;
  logger?: boolean | FastifyBaseLogger;
  mockReceiverStatusCode?: number;
  telemetry?: DeliveryTelemetry;
}

const eventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventType", "data"],
  properties: {
    eventType: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
    },
    data: {
      type: "object",
      additionalProperties: true,
    },
  },
} as const;

const webhookEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "eventType", "data", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    eventType: { type: "string" },
    data: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
  },
} as const;

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: 256 * 1024,
    logger: options.logger ?? true,
  });
  const deliveryTelemetry =
    options.telemetry ?? new OpenTelemetryDeliveryTelemetry();
  const mockReceiverStatusCode = options.mockReceiverStatusCode ?? 200;

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: WebhookEvent }>(
    "/mock/webhooks",
    {
      schema: {
        body: webhookEventSchema,
      },
    },
    async (request, reply) => {
      request.log.info(
        {
          ...activeTraceFields(),
          eventId: request.body.id,
          eventType: request.body.eventType,
        },
        "Mock receiver accepted webhook",
      );

      return reply.code(mockReceiverStatusCode).send({
        received:
          mockReceiverStatusCode >= 200 && mockReceiverStatusCode < 300,
      });
    },
  );

  app.post<{ Body: EventRequestBody }>(
    "/events",
    {
      schema: {
        body: eventBodySchema,
      },
    },
    async (request, reply) => {
      const event: WebhookEvent = {
        id: randomUUID(),
        eventType: request.body.eventType,
        data: request.body.data,
        createdAt: new Date().toISOString(),
      };

      try {
        await deliveryTelemetry.trackDelivery(event.eventType, async () => {
          request.log.info(
            {
              ...activeTraceFields(),
              eventId: event.id,
              eventType: event.eventType,
            },
            "Webhook delivery started",
          );

          try {
            await options.deliveryClient.deliver(event);
          } catch (error) {
            request.log.error(
              {
                ...activeTraceFields(),
                err: error,
                eventId: event.id,
                eventType: event.eventType,
              },
              "Webhook delivery failed",
            );
            throw error;
          }

          request.log.info(
            {
              ...activeTraceFields(),
              eventId: event.id,
              eventType: event.eventType,
            },
            "Webhook delivery completed",
          );
        });
      } catch {
        return reply.code(502).send({
          eventId: event.id,
          status: "failed",
          error: "Webhook delivery failed",
        });
      }

      return reply.code(201).send({
        eventId: event.id,
        status: "delivered",
      });
    },
  );

  return app;
}
