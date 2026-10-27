import { execFile } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { FailedStartupResult } from "./fixtures/failed-startup.js";

const require = createRequire(import.meta.url);
const loaderUrl = pathToFileURL(require.resolve("tsx")).href;
const fixture = fileURLToPath(new URL("./fixtures/failed-startup.ts", import.meta.url));
const appVariables = [
  "HOST", "PORT", "DELIVERY_TARGET_URL", "DELIVERY_TIMEOUT_MS",
  "MOCK_RECEIVER_STATUS_CODE", "MOCK_RECEIVER_DELAY_MS", "LOG_LEVEL",
];

async function runFailedStartup(overrides: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(join(tmpdir(), "webhook-startup-failure-"));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OTEL_") || appVariables.includes(key) || key === "NODE_OPTIONS") {
      delete environment[key];
    }
  }

  try {
    const output = await new Promise<{
      exitCode: string | number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(process.execPath, ["--import", loaderUrl, fixture], {
        cwd: directory,
        env: {
          ...environment,
          HOST: "127.0.0.1",
          PORT: "3000",
          OTEL_SERVICE_NAME: "startup-test",
          OTEL_TRACES_SAMPLER: "always_on",
          OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
          OTEL_BSP_SCHEDULE_DELAY: "60000",
          ...overrides,
        },
        timeout: 30_000,
      }, (error, stdout, stderr) => resolve({ exitCode: error?.code ?? 0, stdout, stderr }));
    });

    expect(output.exitCode, output.stderr).toBe(1);
    const prefix = "FAILED_STARTUP=";
    const line = output.stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
    if (line === undefined) throw new Error(`Missing startup report: ${output.stderr}`);
    const result = JSON.parse(line.slice(prefix.length)) as FailedStartupResult;
    expect(result).toEqual({
      beforeStartup: { spans: 0, metricBatches: 0 },
      exitCode: 1,
      importError: null,
      spanNames: ["startup.probe"],
      counterValues: [1],
    });
    return output;
  } finally {
    await rmdir(directory);
  }
}

describe("failed startup with the application SDK", () => {
  it.each([
    { variable: "PORT", value: "0", message: "Expected a positive integer" },
    { variable: "HOST", value: "   ", message: "Expected HOST to be a non-empty value" },
    { variable: "LOG_LEVEL", value: "verbose", message: "Expected LOG_LEVEL to be" },
    {
      variable: "DELIVERY_TARGET_URL", value: "ftp://example.invalid/webhooks",
      message: "Expected DELIVERY_TARGET_URL to be a valid HTTP URL",
    },
  ])("flushes buffered telemetry before exiting for invalid $variable", async ({ variable, value, message }) => {
    const output = await runFailedStartup({ [variable]: value });

    expect(output.stderr).toContain("Server failed to start");
    expect(output.stderr).toContain(message);
    expect(output.stderr).not.toContain("Startup cleanup failed");
  }, 40_000);

  it("flushes buffered telemetry when the listen port is already occupied", async () => {
    const blocker = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          blocker.off("error", reject);
          resolve();
        });
      });
      const address = blocker.address();
      if (address === null || typeof address === "string") throw new Error("Expected a local TCP port");
      const output = await runFailedStartup({ PORT: String(address.port) });

      expect(output.stdout).toContain('"msg":"Server failed to start"');
      expect(output.stdout).toContain('"code":"EADDRINUSE"');
      expect(output.stdout).not.toContain('"msg":"Startup cleanup failed"');
    } finally {
      if (blocker.listening) {
        await new Promise<void>((resolve, reject) => {
          blocker.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  }, 40_000);
});
