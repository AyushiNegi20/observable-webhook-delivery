import { describe, expect, it, vi } from "vitest";

import { shutdownResources } from "../src/lifecycle.js";

describe("resource shutdown", () => {
  it("waits for the server to close before flushing telemetry", async () => {
    let finishClose!: () => void;
    const closeServer = vi.fn(() => new Promise<void>((resolve) => {
      finishClose = resolve;
    }));
    const flushTelemetry = vi.fn(async () => {});
    const shutdown = shutdownResources(closeServer, flushTelemetry);

    try {
      await Promise.resolve();
      expect(closeServer).toHaveBeenCalledOnce();
      expect(flushTelemetry).not.toHaveBeenCalled();
    } finally {
      finishClose();
      await shutdown;
    }
    expect(flushTelemetry).toHaveBeenCalledOnce();
  });

  it.each(["rejection", "synchronous exception"])(
    "still flushes telemetry after a server cleanup %s",
    async (failureType) => {
      const failure = new Error("Server close failed");
      const closeServer = vi.fn(() => {
        if (failureType === "synchronous exception") {
          throw failure;
        }
        return Promise.reject(failure);
      });
      const flushTelemetry = vi.fn(async () => {});

      await expect(shutdownResources(closeServer, flushTelemetry)).rejects.toBe(failure);
      expect(flushTelemetry).toHaveBeenCalledOnce();
    },
  );

  it("reports a telemetry flush failure after closing the server", async () => {
    const failure = new Error("Exporter unavailable");
    const closeServer = vi.fn(async () => {});
    const flushTelemetry = vi.fn().mockRejectedValue(failure);

    await expect(shutdownResources(closeServer, flushTelemetry)).rejects.toBe(failure);
    expect(closeServer).toHaveBeenCalledOnce();
    expect(flushTelemetry).toHaveBeenCalledOnce();
  });

  it("preserves both errors when server cleanup and the flush fail", async () => {
    const closeFailure = new Error("Server close failed");
    const flushFailure = new Error("Exporter unavailable");
    const closeServer = vi.fn().mockRejectedValue(closeFailure);
    const flushTelemetry = vi.fn().mockRejectedValue(flushFailure);

    await expect(shutdownResources(closeServer, flushTelemetry)).rejects.toMatchObject({
      name: "AggregateError",
      errors: [closeFailure, flushFailure],
    });
    expect(closeServer).toHaveBeenCalledOnce();
    expect(flushTelemetry).toHaveBeenCalledOnce();
  });
});
