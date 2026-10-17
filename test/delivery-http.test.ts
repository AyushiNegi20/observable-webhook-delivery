import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HttpDeliveryClient,
  type DeliveryFailureReason,
  type WebhookEvent,
} from "../src/delivery.js";
import { OpenTelemetryDeliveryTelemetry } from "../src/telemetry.js";

const event: WebhookEvent = {
  id: "a545a04d-5380-4d9c-bca8-37f20936e942",
  eventType: "invoice.created",
  data: { invoiceId: "inv_123" },
  createdAt: "2026-08-25T00:00:00.000Z",
};

const redirectCases = [301, 302, 303, 307, 308].flatMap((statusCode) => [
  { statusCode, locationType: "relative" },
  { statusCode, locationType: "absolute" },
]);

interface ReceivedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

describe("delivery over real HTTP", () => {
  let receiver: Server;
  let streamingResponse: ServerResponse | undefined;
  let recoveryStatus: number;
  let baseUrl: string;
  let requests: ReceivedRequest[];
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let metricExporter: InMemoryMetricExporter;
  let meterProvider: MeterProvider;
  let telemetry: OpenTelemetryDeliveryTelemetry;

  beforeEach(async () => {
    requests = [];
    streamingResponse = undefined;
    recoveryStatus = 503;
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60_000,
      })],
    });
    telemetry = new OpenTelemetryDeliveryTelemetry(
      provider.getTracer("http-test"),
      meterProvider.getMeter("http-test"),
    );
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

        if (request.url === "/streaming/200" || request.url === "/streaming/503") {
          streamingResponse = response;
          response.writeHead(request.url === "/streaming/200" ? 200 : 503, {
            "content-type": "text/plain",
          });
          // Send a status and a partial body, but never finish the response.
          response.write("private-receiver-response-marker");
          return;
        }

        const redirect = redirectCases.find(
          ({ statusCode, locationType }) =>
            request.url === `/redirect/${statusCode}/${locationType}`,
        );
        if (redirect !== undefined) {
          response.writeHead(redirect.statusCode, {
            location: redirect.locationType === "relative"
              ? "/accepted"
              : `${baseUrl}/accepted`,
          });
          response.end();
          return;
        }

        const statuses: Record<string, number> = {
          "/accepted": 200,
          "/empty": 204,
          "/unavailable": 503,
          "/recovery": recoveryStatus,
        };
        response.writeHead(statuses[request.url ?? ""] ?? 404, {
          "content-type": "text/plain",
        });
        response.end(response.statusCode === 204 ? undefined : "Receiver response");
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
      await Promise.all([provider.shutdown(), meterProvider.shutdown()]);
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
    reason?: DeliveryFailureReason,
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
    await expectMetrics(result === "success" ? 1 : 0, reason === undefined ? {} : { [reason]: 1 });
  }

  async function expectMetrics(
    successes: number,
    failuresByReason: Partial<Record<DeliveryFailureReason, number>>,
  ): Promise<void> {
    await meterProvider.forceFlush();
    const exported = metricExporter.getMetrics().at(-1);
    expect(exported).toBeDefined();
    const metrics = exported?.scopeMetrics.flatMap((scope) => scope.metrics);
    const attributes = {
      "webhook.event.type": event.eventType,
      "webhook.delivery.system": "http",
    };
    const failures = Object.values(failuresByReason).reduce((total, count) => total + count, 0);
    for (const { name, value, monotonic } of [
      { name: "webhook.delivery.attempts", value: successes + failures, monotonic: true },
      { name: "webhook.delivery.active", value: 0, monotonic: false },
    ]) {
      const metric = metrics?.find((entry) => entry.descriptor.name === name);
      expect(metric?.dataPointType).toBe(DataPointType.SUM);
      expect(metric?.dataPoints).toEqual([expect.objectContaining({ attributes, value })]);
      if (metric?.dataPointType === DataPointType.SUM) {
        expect(metric.isMonotonic).toBe(monotonic);
      }
    }

    const failed = metrics?.find((entry) => entry.descriptor.name === "webhook.delivery.failures");
    if (failures > 0) {
      expect(failed?.dataPointType).toBe(DataPointType.SUM);
      if (failed?.dataPointType === DataPointType.SUM) expect(failed.isMonotonic).toBe(true);
    }
    const expectedFailures = Object.entries(failuresByReason).map(([reason, value]) =>
      expect.objectContaining({
        attributes: { ...attributes, "webhook.delivery.failure_reason": reason },
        value,
      }),
    );
    expect(failed?.dataPoints ?? []).toHaveLength(expectedFailures.length);
    expect(failed?.dataPoints ?? []).toEqual(expect.arrayContaining(expectedFailures));

    const duration = metrics?.find((entry) => entry.descriptor.name === "webhook.delivery.duration");
    if (duration?.dataPointType !== DataPointType.HISTOGRAM) {
      throw new Error("Expected an exported delivery duration histogram");
    }
    expect(duration.descriptor.unit).toBe("ms");
    expect(duration.dataPoints).toHaveLength(Number(successes > 0) + Number(failures > 0));
    for (const [result, count] of [["success", successes], ["failure", failures]] as const) {
      const point = duration.dataPoints.find(
        (entry) => entry.attributes["webhook.delivery.result"] === result,
      );
      if (count === 0) {
        expect(point).toBeUndefined();
        continue;
      }
      expect(point?.attributes).toEqual({ ...attributes, "webhook.delivery.result": result });
      expect(point?.value.count).toBe(count);
      expect(Number.isFinite(point?.value.sum)).toBe(true);
      expect(point?.value.sum).toBeGreaterThanOrEqual(0);
      expect(point?.value.buckets.counts.reduce((total, bucket) => total + bucket, 0)).toBe(count);
    }
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

  it.each([200, 503])(
    "uses status %i and closes an unfinished receiver response",
    async (statusCode) => {
      const path = `/streaming/${statusCode}`;
      // Keep the delivery deadline beyond the test so it cannot mask missing cleanup.
      const delivery = deliver(path, 60_000);
      if (statusCode === 200) {
        await expect(delivery).resolves.toBeUndefined();
        await expectSpan("success");
      } else {
        await expect(delivery).rejects.toMatchObject({
          reason: "http_status", statusCode,
        });
        await expectSpan("failure", "http_status", statusCode);
      }
      expectRequest(path);
      await vi.waitFor(() => {
        expect(streamingResponse?.destroyed).toBe(true);
      }, { timeout: 5000 });
      expect(streamingResponse?.writableEnded).toBe(false);
      const span = exporter.getFinishedSpans()[0];
      expect(JSON.stringify({ attributes: span?.attributes, events: span?.events }))
        .not.toContain("private-receiver-response-marker");
    },
    15_000,
  );

  it.each(redirectCases)(
    "blocks a $statusCode redirect with a $locationType location without forwarding the event",
    async ({ statusCode, locationType }) => {
      const path = `/redirect/${statusCode}/${locationType}`;

      await expect(deliver(path)).rejects.toMatchObject({
        name: "DeliveryError",
        reason: "network",
        statusCode: undefined,
      });
      // Only the configured endpoint may receive a request, never /accepted.
      expectRequest(path);
      await expectSpan("failure", "network");
    },
    15_000,
  );

  it("ends the span when the receiver never responds", async () => {
    await expect(deliver("/slow", 1000)).rejects.toMatchObject({
      name: "DeliveryError",
      reason: "timeout",
      statusCode: undefined,
    });
    expectRequest("/slow");
    await expectSpan("failure", "timeout");
  }, 15_000);

  it("keeps cumulative metrics consistent when the receiver recovers", async () => {
    await expect(deliver("/recovery")).rejects.toMatchObject({ reason: "http_status" });
    await expectMetrics(0, { http_status: 1 });

    recoveryStatus = 200;
    await expect(deliver("/recovery")).resolves.toBeUndefined();
    await expectMetrics(1, { http_status: 1 });

    recoveryStatus = 204;
    await expect(deliver("/recovery")).resolves.toBeUndefined();
    await expectMetrics(2, { http_status: 1 });
    expect(requests.map((request) => request.path)).toEqual(["/recovery", "/recovery", "/recovery"]);
    await provider.forceFlush();
    expect(exporter.getFinishedSpans().map((span) => span.attributes["webhook.delivery.result"]))
      .toEqual(["failure", "success", "success"]);
  }, 15_000);
});
