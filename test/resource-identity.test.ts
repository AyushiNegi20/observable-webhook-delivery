import { execFile } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { serviceVersion } from "../src/service-metadata.js";
import type { ResourceIdentityResult } from "./fixtures/resource-identity.js";

const runNode = promisify(execFile);
const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const fixture = fileURLToPath(new URL("./fixtures/resource-identity.ts", import.meta.url));

async function inspectProcess(resourceAttributes?: string): Promise<ResourceIdentityResult> {
  const directory = await mkdtemp(join(tmpdir(), "webhook-resource-test-"));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OTEL_") || key === "NODE_OPTIONS") delete environment[key];
  }
  try {
    const { stdout } = await runNode(process.execPath, ["--import", loaderUrl, fixture], {
      cwd: directory,
      env: {
        ...environment,
        OTEL_SERVICE_NAME: "resource-test",
        OTEL_TRACES_SAMPLER: "always_on",
        OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
        OTEL_BSP_SCHEDULE_DELAY: "60000",
        ...(resourceAttributes === undefined ? {} : { OTEL_RESOURCE_ATTRIBUTES: resourceAttributes }),
      },
      timeout: 30_000,
    });
    const prefix = "RESOURCE_IDENTITY=";
    const output = stdout.split(/\r?\n/).find((line) => line.startsWith(prefix));
    if (output === undefined) throw new Error("Child process did not report its resource identity");
    return JSON.parse(output.slice(prefix.length)) as ResourceIdentityResult;
  } finally {
    await rmdir(directory);
  }
}

function expectSharedIdentity(result: ResourceIdentityResult, expectedId?: string): string {
  expect(result.spans).toHaveLength(2);
  expect(result.spans.map((span) => span.attributes["webhook.delivery.result"]))
    .toEqual(["success", "failure"]);
  expect(result.batches.length).toBeGreaterThan(0);
  const instanceId = result.spans[0]?.resource["service.instance.id"];
  if (typeof instanceId !== "string") throw new Error("Expected a string service instance ID");
  if (expectedId === undefined) {
    expect(instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } else {
    expect(instanceId).toBe(expectedId);
  }
  for (const signal of [...result.spans, ...result.batches]) {
    expect(signal.resource).toMatchObject({
      "service.name": "resource-test",
      "service.version": serviceVersion,
      "service.instance.id": instanceId,
    });
  }
  for (const span of result.spans) {
    expect(span.attributes).not.toHaveProperty("service.instance.id");
  }
  const metrics = result.batches.at(-1)?.metrics;
  expect(metrics?.map((metric) => metric.name).sort()).toEqual([
    "webhook.delivery.active", "webhook.delivery.attempts",
    "webhook.delivery.duration", "webhook.delivery.failures",
  ]);
  for (const metric of metrics ?? []) {
    expect(metric.attributes.length).toBeGreaterThan(0);
    for (const attributes of metric.attributes) {
      expect(attributes).not.toHaveProperty("service.instance.id");
    }
  }
  return instanceId;
}

describe("service instance resource identity", () => {
  it("shares one ID across signals and gives separate processes different IDs", async () => {
    // Separate starts also cover a restart without adding two SDKs to peak test load.
    const first = await inspectProcess();
    const second = await inspectProcess();
    expect(expectSharedIdentity(first)).not.toBe(expectSharedIdentity(second));
  }, 40_000);

  it.each([
    { name: "a generated instance ID", instanceId: undefined },
    { name: "an explicit instance ID", instanceId: "synthetic-worker-a" },
  ])("preserves resource attributes alongside $name", async ({ instanceId }) => {
    const attributes = [
      "service.namespace=webhook-demo", "deployment.environment.name=test",
      ...(instanceId === undefined ? [] : [`service.instance.id=${instanceId}`]),
    ].join(",");
    const result = await inspectProcess(attributes);
    expectSharedIdentity(result, instanceId);
    for (const signal of [...result.spans, ...result.batches]) {
      expect(signal.resource).toMatchObject({
        "service.namespace": "webhook-demo",
        "deployment.environment.name": "test",
      });
    }
  }, 40_000);
});
