import { execFile } from "node:child_process";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";

const runNode = promisify(execFile);
const require = createRequire(import.meta.url);
const loaderUrl = pathToFileURL(require.resolve("tsx")).href;
const instrumentationUrl = new URL("../src/instrumentation.ts", import.meta.url).href;
const configUrl = new URL("../src/config.ts", import.meta.url).href;
const outputPrefix = "STARTUP_CONFIG=";
const appVariables = [
  "HOST", "PORT", "DELIVERY_TARGET_URL", "DELIVERY_TIMEOUT_MS", "MOCK_RECEIVER_STATUS_CODE",
];
const localSettings = [
  'HOST=" 127.0.0.1 "',
  "PORT=3100",
  "DELIVERY_TIMEOUT_MS=1250",
  "MOCK_RECEIVER_STATUS_CODE=503",
  "OTEL_SERVICE_NAME=local-test-api",
  "OTEL_METRIC_EXPORT_INTERVAL_MS=60000",
].join("\n");

interface StartupSettings {
  config: AppConfig;
  serviceName?: string;
  metricInterval?: string;
}

describe("environment settings in a fresh process", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "webhook-env-test-"));
  });

  afterEach(async () => {
    await rm(join(directory, ".env"), { force: true });
    await rmdir(directory);
  });

  async function readStartup(overrides: NodeJS.ProcessEnv = {}): Promise<StartupSettings> {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("OTEL_") || appVariables.includes(key) || key === "NODE_OPTIONS") {
        delete environment[key];
      }
    }
    const script = [
      `const { shutdownTelemetry } = await import(${JSON.stringify(instrumentationUrl)});`,
      "try {",
      `  const { loadConfig } = await import(${JSON.stringify(configUrl)});`,
      `  console.log(${JSON.stringify(outputPrefix)} + JSON.stringify({`,
      "    config: loadConfig(),",
      "    serviceName: process.env.OTEL_SERVICE_NAME,",
      "    metricInterval: process.env.OTEL_METRIC_EXPORT_INTERVAL_MS,",
      "  }));",
      "} finally { await shutdownTelemetry(); }",
    ].join("\n");
    const { stdout } = await runNode(
      process.execPath,
      ["--import", loaderUrl, "--input-type=module", "--eval", script],
      { cwd: directory, env: { ...environment, ...overrides }, timeout: 30_000 },
    );
    const output = stdout.split(/\r?\n/).find((line) => line.startsWith(outputPrefix));
    if (output === undefined) {
      throw new Error("Startup did not report its configuration");
    }
    return JSON.parse(output.slice(outputPrefix.length)) as StartupSettings;
  }

  it("starts with defaults when there is no .env file", async () => {
    expect(await readStartup()).toEqual({
      config: {
        host: "0.0.0.0",
        port: 3000,
        deliveryTargetUrl: "http://127.0.0.1:3000/mock/webhooks",
        deliveryTimeoutMs: 3000,
        mockReceiverStatusCode: 200,
      },
    });
  }, 40_000);

  it("loads app and telemetry settings from the working directory", async () => {
    await writeFile(join(directory, ".env"), localSettings);

    expect(await readStartup()).toEqual({
      config: {
        host: "127.0.0.1",
        port: 3100,
        deliveryTargetUrl: "http://127.0.0.1:3100/mock/webhooks",
        deliveryTimeoutMs: 1250,
        mockReceiverStatusCode: 503,
      },
      serviceName: "local-test-api",
      metricInterval: "60000",
    });
  }, 40_000);

  it("keeps process variables ahead of file values", async () => {
    await writeFile(join(directory, ".env"), localSettings);

    expect(await readStartup({ PORT: "3200", OTEL_SERVICE_NAME: "process-test-api" })).toMatchObject({
      config: {
        host: "127.0.0.1",
        port: 3200,
        deliveryTargetUrl: "http://127.0.0.1:3200/mock/webhooks",
      },
      serviceName: "process-test-api",
      metricInterval: "60000",
    });
  }, 40_000);

  it("does not replace an explicitly blank process value with a file value", async () => {
    await writeFile(join(directory, ".env"), localSettings);

    await expect(readStartup({ HOST: "" })).rejects.toThrow(
      "Expected HOST to be a non-empty value",
    );
  }, 40_000);
});
