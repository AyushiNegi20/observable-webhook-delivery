import { execFile } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { SpanKind } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import type { HttpTraceScenarioResult } from "./fixtures/http-trace-scenario.js";

const runNode = promisify(execFile);
const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const fixture = fileURLToPath(new URL("./fixtures/http-trace-scenario.ts", import.meta.url));
const remoteTraceId = "0123456789abcdef0123456789abcdef";
const remoteSpanId = "0123456789abcdef";

describe("health probes with the application SDK", () => {
  it.each([false, true])("preserves request handling with health tracing enabled=%s", async (enabled) => {
    const directory = await mkdtemp(join(tmpdir(), "webhook-health-trace-"));
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("OTEL_") || key === "NODE_OPTIONS") delete environment[key];
    }
    let result: HttpTraceScenarioResult;
    try {
      const { stdout } = await runNode(process.execPath, [
        "--import", loaderUrl, fixture,
        JSON.stringify({
          receiverStatus: 200, healthProbes: true,
          traceparent: `00-${remoteTraceId}-${remoteSpanId}-01`,
        }),
      ], {
        cwd: directory,
        env: {
          ...environment,
          OTEL_SERVICE_NAME: "health-trace-test",
          OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
          OTEL_TRACES_SAMPLER: "parentbased_always_on",
          OTEL_PROPAGATORS: "tracecontext,baggage",
          ...(enabled ? { OTEL_TRACE_HEALTHCHECKS: "true" } : {}),
        },
        timeout: 30_000,
      });
      const prefix = "TRACE_SCENARIO=";
      const output = stdout.split(/\r?\n/).find((line) => line.startsWith(prefix));
      if (output === undefined) throw new Error("Child process did not report its health probes");
      result = JSON.parse(output.slice(prefix.length)) as HttpTraceScenarioResult;
    } finally {
      await rmdir(directory);
    }

    expect(result.probes).toHaveLength(8);
    expect(result.requests).toHaveLength(10);
    expect(result.responseStatus).toBe(201);
    expect(result.spans).toHaveLength(enabled ? 12 : 8);
    for (const probe of result.probes) {
      const isHealthProbe = (probe.method === "GET" || probe.method === "HEAD")
        && probe.path.split("?", 1)[0] === "/health";
      expect(probe.status).toBe(isHealthProbe ? 200 : 404);
      const request = result.requests.find(
        (entry) => entry.path === probe.path && entry.method === probe.method,
      );
      expect(request).toBeDefined();
      if (isHealthProbe && !enabled) {
        expect(request?.traceId).toBeUndefined();
        expect(request?.spanId).toBeUndefined();
      } else {
        expect(request?.traceId).toBe(remoteTraceId);
        const span = result.spans.find((entry) => entry.spanId === request?.spanId);
        expect(span).toMatchObject({ kind: SpanKind.SERVER, parentSpanId: remoteSpanId });
      }
      const incoming = result.requestLogs.filter((record) => {
        const req = record.req as { method?: string; url?: string } | undefined;
        return record.msg === "incoming request" && req?.method === probe.method && req.url === probe.path;
      });
      expect(incoming).toHaveLength(1);
      expect(result.requestLogs).toContainEqual(expect.objectContaining({
        msg: "request completed", reqId: incoming[0]?.reqId,
        res: expect.objectContaining({ statusCode: probe.status }),
      }));
    }

    // Suppressing probe spans must not leak into the subsequent delivery.
    const api = result.requests.find((request) => request.path === "/events");
    const receiver = result.requests.find((request) => request.path === "/mock/webhooks");
    const deliveries = result.spans.filter((span) => span.name === "webhook.deliver");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      traceId: remoteTraceId,
      parentSpanId: api?.spanId,
      attributes: { "webhook.delivery.result": "success" },
    });
    const client = result.spans.find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.parentSpanId).toBe(deliveries[0]?.spanId);
    expect(result.spans.find((span) => span.spanId === receiver?.spanId)?.parentSpanId)
      .toBe(client?.spanId);
    expect(result.logs).toHaveLength(3);
    expect(result.logs.every((record) => record.traceId === remoteTraceId)).toBe(true);
  }, 40_000);
});
