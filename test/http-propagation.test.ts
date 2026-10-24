import { execFile } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { SpanKind } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { serviceVersion } from "../src/service-metadata.js";
import type { HttpTraceScenarioResult } from "./fixtures/http-trace-scenario.js";

const runNode = promisify(execFile);
const require = createRequire(import.meta.url);
const loaderUrl = pathToFileURL(require.resolve("tsx")).href;
const fixture = fileURLToPath(new URL("./fixtures/http-trace-scenario.ts", import.meta.url));
const remoteTraceId = "0123456789abcdef0123456789abcdef";
const remoteSpanId = "0123456789abcdef";
const traceState = "vendor=synthetic";
const baggageHeader = "customer.marker=synthetic-incoming-only,tenant=synthetic-tenant";

describe("HTTP trace propagation with the application SDK", () => {
  it.each([
    {
      name: "a sampled delivery", receiverStatus: 200,
      header: `00-${remoteTraceId}-${remoteSpanId}-01`, sampled: true, remote: true,
      propagators: undefined,
    },
    {
      name: "a receiver failure", receiverStatus: 503,
      header: `00-${remoteTraceId}-${remoteSpanId}-01`, sampled: true, remote: true,
      propagators: "tracecontext,baggage",
    },
    {
      name: "a missing trace header", receiverStatus: 200,
      header: undefined, sampled: true, remote: false,
      propagators: "tracecontext,baggage",
    },
    {
      name: "an invalid trace header", receiverStatus: 200,
      header: "not-a-traceparent", sampled: true, remote: false,
      propagators: "tracecontext,baggage",
    },
    {
      name: "an unsampled delivery", receiverStatus: 200,
      header: `00-${remoteTraceId}-${remoteSpanId}-00`, sampled: false, remote: true,
      propagators: "tracecontext,baggage",
    },
    {
      name: "locally created baggage", receiverStatus: 200,
      header: `00-${remoteTraceId}-${remoteSpanId}-01`, sampled: true, remote: true,
      propagators: "tracecontext,baggage", localBaggage: true,
    },
  ])("keeps context across both HTTP hops for $name", async ({ receiverStatus, header, sampled, remote, propagators, localBaggage }) => {
    const directory = await mkdtemp(join(tmpdir(), "webhook-trace-test-"));
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("OTEL_") || key === "NODE_OPTIONS") delete environment[key];
    }

    let result: HttpTraceScenarioResult;
    try {
      const { stdout } = await runNode(process.execPath, [
        "--import", loaderUrl, fixture,
        JSON.stringify({ receiverStatus, traceparent: header, tracestate: traceState, baggage: baggageHeader, localBaggage }),
      ], {
        cwd: directory,
        env: {
          ...environment,
          OTEL_SERVICE_NAME: "propagation-test",
          OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
          OTEL_TRACES_SAMPLER: "parentbased_always_on",
          ...(propagators === undefined ? {} : { OTEL_PROPAGATORS: propagators }),
        },
        timeout: 30_000,
      });
      const prefix = "TRACE_SCENARIO=";
      const output = stdout.split(/\r?\n/).find((line) => line.startsWith(prefix));
      if (output === undefined) throw new Error("Child process did not report its trace scenario");
      result = JSON.parse(output.slice(prefix.length)) as HttpTraceScenarioResult;
    } finally {
      await rmdir(directory);
    }

    expect(result.responseStatus).toBe(receiverStatus === 200 ? 201 : 502);
    expect(result.requests).toHaveLength(2);
    const incoming = result.requests.find((request) => request.path === "/events");
    const receiver = result.requests.find((request) => request.path === "/mock/webhooks");
    expect(incoming?.baggage).toBe(baggageHeader);
    expect(receiver?.baggage).toBeUndefined();
    expect(incoming?.baggageEntries).toEqual([]);
    expect(receiver?.baggageEntries).toEqual([]);
    const exportedTelemetry = JSON.stringify({ spans: result.spans, logs: result.logs, requestLogs: result.requestLogs });
    for (const marker of ["synthetic-incoming-only", "synthetic-tenant", "synthetic-local-only"]) {
      expect(exportedTelemetry).not.toContain(marker);
    }
    expect(incoming?.traceparent).toBe(header);
    expect(incoming?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(incoming?.traceId).not.toBe("0".repeat(32));
    if (remote) expect(incoming?.traceId).toBe(remoteTraceId);
    else expect(incoming?.traceId).not.toBe(remoteTraceId);
    expect(receiver?.traceId).toBe(incoming?.traceId);
    expect(receiver?.spanId).not.toBe(incoming?.spanId);

    const propagated = receiver?.traceparent?.split("-");
    expect(propagated).toEqual([
      "00", incoming?.traceId, expect.stringMatching(/^[0-9a-f]{16}$/), sampled ? "01" : "00",
    ]);
    expect(receiver?.tracestate).toBe(remote ? traceState : undefined);
    expect(result.logs).toHaveLength(3);
    for (const log of result.logs) {
      expect(log.traceId).toBe(incoming?.traceId);
      expect(log.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
    const deliveryLogs = result.logs.filter((log) => String(log.msg).startsWith("Webhook delivery"));
    expect(deliveryLogs).toHaveLength(2);
    expect(deliveryLogs[0]?.spanId).toBe(deliveryLogs[1]?.spanId);
    const receiverLog = result.logs.find((log) => String(log.msg).startsWith("Mock receiver"));
    expect(receiverLog?.spanId).toBe(receiver?.spanId);

    if (!sampled) {
      expect(result.spans).toHaveLength(0);
      return;
    }

    expect(result.spans).toHaveLength(4);
    expect(new Set(result.spans.map((span) => span.spanId)).size).toBe(4);
    expect(result.spans.every((span) => span.traceId === incoming?.traceId)).toBe(true);
    const apiSpan = result.spans.find((span) => span.spanId === incoming?.spanId);
    const deliverySpan = result.spans.find((span) => span.name === "webhook.deliver");
    const clientSpan = result.spans.find((span) => span.spanId === propagated?.[2]);
    const receiverSpan = result.spans.find((span) => span.spanId === receiver?.spanId);
    expect(apiSpan?.kind).toBe(SpanKind.SERVER);
    expect(apiSpan?.parentSpanId).toBe(remote ? remoteSpanId : undefined);
    expect(deliverySpan?.parentSpanId).toBe(apiSpan?.spanId);
    expect(deliverySpan?.spanId).toBe(deliveryLogs[0]?.spanId);
    expect(deliverySpan?.scope).toMatchObject({ name: "observable-webhook-delivery", version: serviceVersion });
    expect(deliverySpan?.attributes["webhook.delivery.result"]).toBe(receiverStatus === 200 ? "success" : "failure");
    expect(clientSpan?.kind).toBe(SpanKind.CLIENT);
    expect(clientSpan?.parentSpanId).toBe(deliverySpan?.spanId);
    expect(receiverSpan?.kind).toBe(SpanKind.SERVER);
    expect(receiverSpan?.parentSpanId).toBe(clientSpan?.spanId);
    for (const span of result.spans) {
      expect(span.traceState).toBe(remote ? traceState : undefined);
    }
  }, 40_000);
});
