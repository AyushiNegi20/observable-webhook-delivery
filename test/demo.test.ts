import { execFile } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve("tsx")).href;
const fixture = fileURLToPath(new URL("./fixtures/demo-telemetry.ts", import.meta.url));

interface DemoOutput {
  exitCode: string | number;
  stdout: string;
  stderr: string;
}

interface DemoTelemetry {
  spans: { name: string; traceId: string; spanId: string; parentSpanId?: string; attributes: Record<string, unknown> }[];
  metrics: { name: string; histogram: boolean; points: { attributes: Record<string, unknown>; value: number | { count: number } }[] }[];
}

async function runDemo(args: string[]): Promise<DemoOutput> {
  const directory = await mkdtemp(join(tmpdir(), "webhook-demo-test-"));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OTEL_") || key === "NODE_OPTIONS") delete environment[key];
  }
  try {
    return await new Promise<DemoOutput>((resolve) => {
      execFile(process.execPath, ["--import", loader, fixture, ...args], {
        cwd: directory,
        env: {
          ...environment,
          LOG_LEVEL: "info",
          OTEL_TRACES_SAMPLER: "always_on",
          OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
          OTEL_BSP_SCHEDULE_DELAY: "60000",
          // These settings must not redirect or change the isolated demo.
          HOST: "192.0.2.1", PORT: "invalid",
          DELIVERY_TARGET_URL: "not-a-url", DELIVERY_TIMEOUT_MS: "invalid",
          MOCK_RECEIVER_STATUS_CODE: "599", MOCK_RECEIVER_DELAY_MS: "60000",
        },
        timeout: 30_000,
      }, (error, stdout, stderr) => resolve({ exitCode: error?.code ?? 0, stdout, stderr }));
    });
  } finally {
    await rmdir(directory);
  }
}

function readReport<T>(stdout: string, prefix: string): T {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  if (line === undefined) throw new Error(`Missing ${prefix} report`);
  return JSON.parse(line.slice(prefix.length)) as T;
}

describe("local demo command", () => {
  it.each([
    { args: [], scenario: "success", statusCode: 201, failureReason: undefined },
    { args: ["rejected"], scenario: "rejected", statusCode: 502, failureReason: "http_status" },
    { args: ["timeout"], scenario: "timeout", statusCode: 502, failureReason: "timeout" },
    { args: ["disconnected"], scenario: "disconnected", statusCode: 502, failureReason: "network" },
  ])("runs the $scenario scenario and flushes its telemetry", async ({ args, scenario, statusCode, failureReason }) => {
    const output = await runDemo(args);
    expect(output.exitCode, output.stderr).toBe(0);
    const report = readReport<{ eventId: string }>(output.stdout, "DEMO_RESULT=");
    expect(report).toMatchObject({
      scenario, statusCode, deliveryStatus: statusCode === 201 ? "delivered" : "failed",
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const telemetry = readReport<DemoTelemetry>(output.stdout, "DEMO_TELEMETRY=");
    const delivery = telemetry.spans.find((span) => span.name === "webhook.deliver");
    expect(delivery?.attributes).toMatchObject({
      "webhook.event.id": report.eventId,
      "webhook.delivery.result": statusCode === 201 ? "success" : "failure",
    });
    expect(delivery?.attributes["webhook.delivery.failure_reason"]).toBe(failureReason);
    expect(delivery?.attributes["http.response.status_code"]).toBe(scenario === "rejected" ? 503 : undefined);
    expect(telemetry.spans).toHaveLength(5);
    expect(new Set(telemetry.spans.map((span) => span.traceId)).size).toBe(1);
    for (const span of telemetry.spans) {
      for (const key of ["http.url", "url.full"]) {
        const value = span.attributes[key];
        if (typeof value === "string") expect(new URL(value).hostname).toBe("127.0.0.1");
      }
    }
    const logs = output.stdout.split(/\r?\n/).filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs).toContainEqual(expect.objectContaining({
      eventId: report.eventId, traceId: delivery?.traceId, spanId: delivery?.spanId,
      msg: statusCode === 201 ? "Webhook delivery completed" : "Webhook delivery failed",
    }));
    if (scenario === "disconnected") {
      const failure = logs.find((log) => log.msg === "Webhook delivery failed");
      expect(failure?.failureReason).toBe("network");
      expect(failure).not.toHaveProperty("statusCode");
      expect(logs.some((log) => log.msg === "Mock receiver accepted webhook" || log.msg === "Mock receiver rejected webhook"))
        .toBe(false);
      // Even the interrupted HTTP hop keeps the API, delivery, and receiver in one trace.
      const outgoing = telemetry.spans.find((span) => span.parentSpanId === delivery?.spanId);
      expect(outgoing).toBeDefined();
      expect(telemetry.spans.some((span) => span.parentSpanId === outgoing?.spanId)).toBe(true);
    }
    if (scenario === "timeout") {
      expect(logs).toContainEqual(expect.objectContaining({
        eventId: report.eventId, msg: "Mock receiver accepted webhook", delayMs: 1500,
      }));
    }
    expect(JSON.stringify(telemetry)).not.toContain("inv_demo");
    for (const [name, value] of [["attempts", 1], ["active", 0], ["failures", Number(statusCode === 502)]] as const) {
      const metric = telemetry.metrics.find((entry) => entry.name === `webhook.delivery.${name}`);
      expect(metric?.points.reduce((total, point) => total + Number(point.value), 0) ?? 0).toBe(value);
    }
    const duration = telemetry.metrics.find((entry) => entry.name === "webhook.delivery.duration");
    if (failureReason !== undefined) {
      const failures = telemetry.metrics.find((entry) => entry.name === "webhook.delivery.failures");
      expect(failures?.points).toHaveLength(1);
      expect(failures?.points[0]?.attributes["webhook.delivery.failure_reason"]).toBe(failureReason);
    }
    expect(duration?.histogram).toBe(true);
    expect(duration?.points).toHaveLength(1);
    expect(duration?.points[0]?.value).toMatchObject({ count: 1 });
  }, 40_000);

  it.each([["unknown"], ["success", "extra"]])("rejects invalid arguments %j without making a delivery", async (...args) => {
    const output = await runDemo(args);
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain("Usage: pnpm demo [success|rejected|timeout|disconnected]");
    expect(output.stdout).not.toContain("DEMO_RESULT=");
    expect(readReport<DemoTelemetry>(output.stdout, "DEMO_TELEMETRY=")).toEqual({ spans: [], metrics: [] });
  }, 40_000);
});
