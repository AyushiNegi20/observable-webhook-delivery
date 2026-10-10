import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { HttpDeliveryClient } from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";
import { captureLogger } from "./helpers/capture-logger.js";

describe("slow receiver delivery", () => {
  it.each([
    { name: "a slow success", delayMs: 25, timeoutMs: 5000, timedOut: false },
    { name: "a timeout", delayMs: 1500, timeoutMs: 1000, timedOut: true },
  ])("records $name through the API and real HTTP receiver", async ({ delayMs, timeoutMs, timedOut }) => {
    const captured = captureLogger();
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    let receiverUrl: string;
    const app = buildApp({
      logger: captured.logger,
      mockReceiverDelayMs: delayMs,
      telemetry: new OpenTelemetryDeliveryTelemetry(provider.getTracer("slow-receiver-test")),
      deliveryClient: {
        async deliver(event) {
          await new HttpDeliveryClient(receiverUrl, timeoutMs).deliver(event);
        },
      },
    });

    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      receiverUrl = `${address}/mock/webhooks`;
      const response = await app.inject({
        method: "POST",
        url: "/events",
        payload: { eventType: "invoice.created", data: { invoiceId: "inv_123" } },
      });
      const body = response.json<{ eventId: string; status: string }>();

      expect(response.statusCode).toBe(timedOut ? 502 : 201);
      expect(body.status).toBe(timedOut ? "failed" : "delivered");
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe("webhook.deliver");
      expect(spans[0]?.status.code).toBe(timedOut ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
      expect(spans[0]?.attributes["webhook.delivery.result"]).toBe(timedOut ? "failure" : "success");
      expect(spans[0]?.attributes["webhook.delivery.failure_reason"]).toBe(timedOut ? "timeout" : undefined);
      expect(spans[0]?.attributes["http.response.status_code"]).toBeUndefined();

      const deliveryLogs = captured.records.filter(
        (record) => record.eventId === body.eventId &&
          (record.msg === "Webhook delivery failed" || record.msg === "Webhook delivery completed"),
      );
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0]).toMatchObject({
        reqId: response.headers["x-request-id"],
        msg: timedOut ? "Webhook delivery failed" : "Webhook delivery completed",
      });
      if (timedOut) {
        expect(deliveryLogs[0]).toMatchObject({ err: { reason: "timeout" } });
      }

      // A receiver may finish processing after the sender stops waiting.
      await vi.waitFor(() => {
        const receiverLogs = captured.records.filter(
          (record) => record.eventId === body.eventId && record.msg === "Mock receiver accepted webhook",
        );
        expect(receiverLogs).toHaveLength(1);
        expect(receiverLogs[0]).toMatchObject({ statusCode: 200, received: true, delayMs });
      }, { timeout: 5000 });
    } finally {
      try {
        await app.close();
      } finally {
        await Promise.all([provider.shutdown(), captured.close()]);
      }
    }
  }, 20_000);
});
