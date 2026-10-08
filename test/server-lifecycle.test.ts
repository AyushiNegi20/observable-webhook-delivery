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

function pendingStep() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function invokeSignalHandler(signal: (typeof signals)[number]): void {
  const listeners = process.listeners(signal).filter(
    (listener) => !originalListeners.get(signal)?.includes(listener),
  );
  expect(listeners).toHaveLength(1);
  listeners[0]?.(signal);
}

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

describe("shutdown signals", () => {
  it("runs cleanup once and waits for the flush when both signals arrive", async () => {
    const closing = pendingStep();
    const flushing = pendingStep();
    server.close.mockReturnValue(closing.promise);
    server.flush.mockReturnValue(flushing.promise);
    await import("../src/server.js");

    invokeSignalHandler("SIGTERM");
    invokeSignalHandler("SIGINT");
    try {
      expect(server.close).toHaveBeenCalledOnce();
      expect(server.flush).not.toHaveBeenCalled();
      expect(server.exit).not.toHaveBeenCalled();
      closing.finish();
      await vi.waitFor(() => expect(server.flush).toHaveBeenCalledOnce());
      expect(server.exit).not.toHaveBeenCalled();

      flushing.finish();
      await vi.waitFor(() => expect(server.exit).toHaveBeenCalledExactlyOnceWith(0));
      expect(server.log.info).toHaveBeenCalledExactlyOnceWith(
        { signal: "SIGTERM" }, "Server shutdown started",
      );
    } finally {
      closing.finish();
      flushing.finish();
      await vi.waitFor(() => expect(server.exit).toHaveBeenCalled());
    }
  }, 15_000);

  it.each(["server", "telemetry"] as const)(
    "does not repeat failed %s cleanup for a later signal",
    async (step) => {
      const failure = new Error("Shutdown failed");
      (step === "server" ? server.close : server.flush).mockRejectedValue(failure);
      await import("../src/server.js");

      invokeSignalHandler("SIGINT");
      await vi.waitFor(() => expect(server.exit).toHaveBeenCalledWith(1));
      invokeSignalHandler("SIGTERM");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(server.close).toHaveBeenCalledOnce();
      expect(server.flush).toHaveBeenCalledOnce();
      expect(server.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(server.log.error).toHaveBeenCalledExactlyOnceWith(failure, "Server shutdown failed");
    },
    15_000,
  );

  it("shares cleanup with a failed startup when a signal arrives", async () => {
    const closing = pendingStep();
    server.listen.mockRejectedValue(new Error("Address already in use"));
    server.close.mockReturnValue(closing.promise);
    const starting = import("../src/server.js");

    try {
      await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce());
      invokeSignalHandler("SIGTERM");
      expect(server.close).toHaveBeenCalledOnce();
      expect(server.exit).not.toHaveBeenCalled();

      closing.finish();
      await starting;
      await vi.waitFor(() => expect(server.exit).toHaveBeenCalledExactlyOnceWith(1));
      expect(server.flush).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    } finally {
      closing.finish();
      await starting;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }, 15_000);
});
