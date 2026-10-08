import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  listen: vi.fn<() => Promise<string>>(),
  close: vi.fn<() => Promise<void>>(),
  flush: vi.fn<() => Promise<void>>(),
  exit: vi.fn(),
  log: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/app.js", () => ({ buildApp: () => server }));
vi.mock("../src/config.js", () => ({
  loadConfig: () => ({
    host: "127.0.0.1",
    port: 3000,
    deliveryTargetUrl: "http://127.0.0.1:3000/mock/webhooks",
    deliveryTimeoutMs: 3000,
    mockReceiverStatusCode: 200,
  }),
}));
vi.mock("../src/delivery.js", () => ({ HttpDeliveryClient: class {} }));
vi.mock("../src/instrumentation.js", () => ({ shutdownTelemetry: server.flush }));

const signals = ["SIGINT", "SIGTERM"] as const;
const originalListeners = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.resetModules();
  server.listen.mockReset().mockResolvedValue("http://127.0.0.1:3000");
  server.close.mockReset().mockResolvedValue(undefined);
  server.flush.mockReset().mockResolvedValue(undefined);
  server.exit.mockReset();
  server.log.info.mockReset();
  server.log.error.mockReset();
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  for (const signal of signals) {
    originalListeners.set(signal, process.listeners(signal));
  }
  vi.spyOn(process, "exit").mockImplementation((code) => {
    server.exit(code);
    return undefined as never;
  });
});

afterEach(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!originalListeners.get(signal)?.includes(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("server startup cleanup", () => {
  it("leaves resources running after a successful listen", async () => {
    await import("../src/server.js");

    expect(server.listen).toHaveBeenCalledExactlyOnceWith({ host: "127.0.0.1", port: 3000 });
    expect(server.close).not.toHaveBeenCalled();
    expect(server.flush).not.toHaveBeenCalled();
    expect(server.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  }, 15_000);

  it("closes resources and flushes telemetry when listening fails", async () => {
    const failure = new Error("Address already in use");
    server.listen.mockRejectedValue(failure);

    await import("../src/server.js");

    expect(server.log.error).toHaveBeenCalledExactlyOnceWith(failure, "Server failed to start");
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.flush).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(server.exit).not.toHaveBeenCalled();
  }, 15_000);

  it.each(["server", "telemetry"] as const)(
    "preserves the startup error when %s cleanup also fails",
    async (step) => {
      const startupFailure = new Error("Address already in use");
      const cleanupFailure = new Error("Cleanup failed");
      server.listen.mockRejectedValue(startupFailure);
      (step === "server" ? server.close : server.flush).mockRejectedValue(cleanupFailure);

      await import("../src/server.js");

      expect(server.log.error.mock.calls).toEqual([
        [startupFailure, "Server failed to start"],
        [cleanupFailure, "Startup cleanup failed"],
      ]);
      expect(server.close).toHaveBeenCalledOnce();
      expect(server.flush).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(server.exit).not.toHaveBeenCalled();
    },
    15_000,
  );
});
