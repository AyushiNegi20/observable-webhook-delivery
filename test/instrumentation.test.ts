import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  start: vi.fn(),
  shutdown: vi.fn<() => Promise<void>>(),
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start = sdk.start;
    shutdown = sdk.shutdown;
  },
}));

vi.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: class {},
}));

vi.mock("@opentelemetry/instrumentation-undici", () => ({
  UndiciInstrumentation: class {},
}));

beforeEach(() => {
  vi.resetModules();
  sdk.start.mockReset();
  sdk.shutdown.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL_MS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("metric export interval", () => {
  it.each(["2147483648", "9007199254740992"])(
    "rejects an interval outside Node's timer range: %s",
    async (value) => {
      vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL_MS", value);

      await expect(import("../src/instrumentation.js")).rejects.toThrow(
        "Expected OTEL_METRIC_EXPORT_INTERVAL_MS to be an integer between 1 and 2147483647",
      );
      expect(sdk.start).not.toHaveBeenCalled();
    },
    15_000,
  );

  it.each(["0", "-1", "1.5", "", "   ", "NaN", "Infinity", "soon"])(
    "rejects an invalid interval: %j",
    async (value) => {
      vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL_MS", value);

      await expect(import("../src/instrumentation.js")).rejects.toThrow(
        "Expected OTEL_METRIC_EXPORT_INTERVAL_MS to be an integer between 1 and 2147483647",
      );
      expect(sdk.start).not.toHaveBeenCalled();
    },
    15_000,
  );

  it.each([undefined, "1", "5000", "2147483647"])(
    "starts telemetry with a valid or default interval: %s",
    async (value) => {
      vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL_MS", value);

      const { shutdownTelemetry } = await import("../src/instrumentation.js");

      expect(sdk.start).toHaveBeenCalledOnce();
      await shutdownTelemetry();
    },
    15_000,
  );
});

describe("telemetry shutdown", () => {
  it("makes concurrent callers wait for the exporter flush", async () => {
    let finishShutdown!: () => void;
    sdk.shutdown.mockReturnValue(
      new Promise<void>((resolve) => {
        finishShutdown = resolve;
      }),
    );
    const { shutdownTelemetry } = await import("../src/instrumentation.js");
    const first = shutdownTelemetry();
    const second = shutdownTelemetry();
    const secondFinished = vi.fn();
    const observedSecond = second.then(secondFinished);

    try {
      await Promise.resolve();
      expect(secondFinished).not.toHaveBeenCalled();
      expect(sdk.shutdown).toHaveBeenCalledOnce();

      finishShutdown();
      await Promise.all([first, observedSecond]);
      expect(secondFinished).toHaveBeenCalledOnce();
    } finally {
      finishShutdown();
      await Promise.all([first, observedSecond]);
    }
  }, 15_000);

  it("does not shut the SDK down again after completion", async () => {
    const { shutdownTelemetry } = await import("../src/instrumentation.js");

    await shutdownTelemetry();
    await shutdownTelemetry();

    expect(sdk.shutdown).toHaveBeenCalledOnce();
  }, 15_000);

  it("reports a shutdown failure to concurrent and later callers", async () => {
    const failure = new Error("Exporter flush failed");
    sdk.shutdown.mockRejectedValue(failure);
    const { shutdownTelemetry } = await import("../src/instrumentation.js");

    const outcomes = await Promise.allSettled([
      shutdownTelemetry(),
      shutdownTelemetry(),
    ]);

    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await expect(shutdownTelemetry()).rejects.toBe(failure);
    expect(sdk.shutdown).toHaveBeenCalledOnce();
  }, 15_000);
});
