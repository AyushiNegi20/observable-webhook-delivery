import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpDeliveryClient, type WebhookEvent } from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";

const event: WebhookEvent = {
  id: "a545a04d-5380-4d9c-bca8-37f20936e942",
  eventType: "invoice.created",
  data: { invoiceId: "inv_123" },
  createdAt: "2026-08-25T00:00:00.000Z",
};

interface ReceivedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

describe("delivery over real HTTP", () => {
  let receiver: Server;
  let baseUrl: string;
  let requests: ReceivedRequest[];
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let telemetry: OpenTelemetryDeliveryTelemetry;

  beforeEach(async () => {
    requests = [];
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    telemetry = new OpenTelemetryDeliveryTelemetry(provider.getTracer("http-test"));
    receiver = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          headers: request.headers,
          body,
        });

        if (request.url === "/slow") {
          // Leave the response pending so the real delivery deadline expires.
          return;
        }

        const statuses: Record<string, number> = {
          "/accepted": 200,
          "/empty": 204,
          "/unavailable": 503,
        };
        response.writeHead(statuses[request.url ?? ""] ?? 404, {
          "content-type": "text/plain",
        });
        response.end(request.url === "/empty" ? undefined : "Receiver response");
      });
    });

    await new Promise<void>((resolve, reject) => {
      receiver.once("error", reject);
      receiver.listen(0, "127.0.0.1", () => {
        receiver.off("error", reject);
        resolve();
      });
    });
    const address = receiver.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the test receiver to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 15_000);

  afterEach(async () => {
    try {
      if (receiver.listening) {
        await new Promise<void>((resolve, reject) => {
          receiver.close((error) => (error ? reject(error) : resolve()));
          receiver.closeAllConnections();
        });
      }
    } finally {
      await provider.shutdown();
    }
  });

  function deliver(path: string, timeoutMs = 5000): Promise<void> {
    const client = new HttpDeliveryClient(`${baseUrl}${path}`, timeoutMs);
    return telemetry.trackDelivery(event.eventType, () => client.deliver(event));
  }

  function expectRequest(path: string): void {
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "observable-webhook-delivery",
        "x-webhook-id": event.id,
        "x-webhook-event": event.eventType,
        "x-webhook-created-at": event.createdAt,
        "x-webhook-attempt": "1",
        "x-webhook-schema-version": "1",
      },
      body: JSON.stringify(event),
    });
  }

  async function expectSpan(
    result: "success" | "failure",
    reason?: string,
    statusCode?: number,
  ): Promise<void> {
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("webhook.deliver");
    expect(spans[0]?.status.code).toBe(
      result === "failure" ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
    );
    expect(spans[0]?.attributes["webhook.delivery.result"]).toBe(result);
    expect(spans[0]?.attributes["webhook.delivery.failure_reason"]).toBe(reason);
    expect(spans[0]?.attributes["http.response.status_code"]).toBe(statusCode);
  }

  it.each(["/accepted", "/empty"])(
    "delivers an event to %s and completes the span",
    async (path) => {
      await expect(deliver(path)).resolves.toBeUndefined();
      expectRequest(path);
      await expectSpan("success");
    },
    15_000,
  );

  it("records a receiver's 503 response on the failed span", async () => {
    await expect(deliver("/unavailable")).rejects.toMatchObject({
      name: "DeliveryError",
      reason: "http_status",
      statusCode: 503,
    });
    expectRequest("/unavailable");
    await expectSpan("failure", "http_status", 503);
  }, 15_000);

  it("ends the span when the receiver never responds", async () => {
    await expect(deliver("/slow", 1000)).rejects.toMatchObject({
      name: "DeliveryError",
      reason: "timeout",
      statusCode: undefined,
    });
    expectRequest("/slow");
    await expectSpan("failure", "timeout");
  }, 15_000);
});
