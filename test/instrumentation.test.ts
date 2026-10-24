import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { defaultTextMapGetter, defaultTextMapSetter, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { HttpInstrumentationConfig } from "@opentelemetry/instrumentation-http";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serviceVersion } from "../src/service-metadata.js";

const sdk = vi.hoisted(() => ({
  configure: vi.fn<(options: Partial<NodeSDKConfiguration>) => void>(),
  start: vi.fn(),
  shutdown: vi.fn<() => Promise<void>>(),
}));

const environment = vi.hoisted(() => ({ load: vi.fn<() => void>() }));
const http = vi.hoisted(() => ({ configure: vi.fn<(options: HttpInstrumentationConfig) => void>() }));

vi.mock("node:process", () => ({ loadEnvFile: environment.load }));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor(options: Partial<NodeSDKConfiguration>) {
      sdk.configure(options);
    }

    start = sdk.start;
    shutdown = sdk.shutdown;
  },
}));

vi.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: class {
    constructor(options: HttpInstrumentationConfig) { http.configure(options); }
  },
}));

vi.mock("@opentelemetry/instrumentation-undici", () => ({
  UndiciInstrumentation: class {},
}));

beforeEach(() => {
  vi.resetModules();
  environment.load.mockReset();
  sdk.configure.mockReset();
  sdk.start.mockReset();
  sdk.shutdown.mockReset().mockResolvedValue(undefined);
  http.configure.mockReset();
  vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL_MS", undefined);
  vi.stubEnv("OTEL_SERVICE_NAME", undefined);
  vi.stubEnv("OTEL_TRACE_HEALTHCHECKS", undefined);
  vi.stubEnv("OTEL_PROPAGATORS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trace-only propagation", () => {
  it.each([undefined, "tracecontext,baggage", "baggage", "none"])(
    "keeps the explicit propagation policy with OTEL_PROPAGATORS=%s",
    async (value) => {
      vi.stubEnv("OTEL_PROPAGATORS", value);
      const { shutdownTelemetry } = await import("../src/instrumentation.js");
      const propagator = sdk.configure.mock.calls[0]?.[0].textMapPropagator;
      if (!propagator) throw new Error("SDK must configure a trace-only propagator");

      const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
      const tracestate = "vendor=synthetic";
      const extracted = propagator.extract(ROOT_CONTEXT, {
        traceparent,
        tracestate,
        baggage: "customer.marker=synthetic-incoming-only",
      }, defaultTextMapGetter);
      expect(propagator.fields()).toEqual(["traceparent", "tracestate"]);
      expect(trace.getSpanContext(extracted)).toMatchObject({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: 1,
        isRemote: true,
      });
      expect(propagation.getBaggage(extracted)).toBeUndefined();

      const withLocalBaggage = propagation.setBaggage(extracted, propagation.createBaggage({
        "internal.marker": { value: "synthetic-local-only" },
      }));
      const carrier: Record<string, string> = {};
      propagator.inject(withLocalBaggage, carrier, defaultTextMapSetter);
      expect(carrier).toEqual({ traceparent, tracestate });
      await shutdownTelemetry();
    },
    15_000,
  );
});

describe("health probe tracing", () => {
  it.each([
    { method: "GET", url: "/health", ignored: true },
    { method: "HEAD", url: "/health", ignored: true },
    { method: "GET", url: "/health?probe=ready", ignored: true },
    { method: "HEAD", url: "/health?probe=ready", ignored: true },
    { method: "POST", url: "/health", ignored: false },
    { method: "GET", url: "/health/", ignored: false },
    { method: "GET", url: "/healthy", ignored: false },
    { method: "GET", url: "/missing", ignored: false },
    { method: "POST", url: "/events", ignored: false },
    { method: "POST", url: "/mock/webhooks", ignored: false },
    { method: undefined, url: "/health", ignored: false },
    { method: "GET", url: undefined, ignored: false },
  ])("sets ignored=$ignored for $method $url", async ({ method, url, ignored }) => {
    const { shutdownTelemetry } = await import("../src/instrumentation.js");
    const request = new IncomingMessage(new Socket());
    if (method !== undefined) request.method = method;
    if (url !== undefined) request.url = url;
    expect(http.configure.mock.calls[0]?.[0].ignoreIncomingRequestHook?.(request)).toBe(ignored);
    await shutdownTelemetry();
  }, 15_000);

  it.each([
    { value: "false", ignored: true },
    { value: "true", ignored: false },
    { value: " true ", ignored: false },
  ])("honors OTEL_TRACE_HEALTHCHECKS=$value", async ({ value, ignored }) => {
    vi.stubEnv("OTEL_TRACE_HEALTHCHECKS", value);
    const { shutdownTelemetry } = await import("../src/instrumentation.js");
    const request = new IncomingMessage(new Socket());
    request.method = "GET";
    request.url = "/health";
    expect(http.configure.mock.calls[0]?.[0].ignoreIncomingRequestHook?.(request)).toBe(ignored);
    await shutdownTelemetry();
  }, 15_000);

  it.each(["", " ", "1", "yes", "FALSE"])("rejects invalid health tracing value %j", async (value) => {
    vi.stubEnv("OTEL_TRACE_HEALTHCHECKS", value);
    await expect(import("../src/instrumentation.js")).rejects.toThrow(
      "Expected OTEL_TRACE_HEALTHCHECKS to be true or false",
    );
    expect(sdk.configure).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  }, 15_000);
});

describe("telemetry service name", () => {
  it("assigns one UUID to the SDK resource for the process lifetime", async () => {
    const { shutdownTelemetry } = await import("../src/instrumentation.js");
    const instanceId = sdk.configure.mock.calls[0]?.[0].resource?.attributes["service.instance.id"];
    expect(instanceId).toEqual(expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ));

    await import("../src/instrumentation.js");
    expect(sdk.configure).toHaveBeenCalledOnce();
    expect(sdk.configure.mock.calls[0]?.[0].resource?.attributes["service.instance.id"]).toBe(instanceId);
    await shutdownTelemetry();
  }, 15_000);

  it("reports the application version in the telemetry resource", async () => {
    const { shutdownTelemetry } = await import("../src/instrumentation.js");

    expect(sdk.configure.mock.calls[0]?.[0].resource?.attributes).toMatchObject({
      "service.version": serviceVersion,
    });
    await shutdownTelemetry();
  }, 15_000);

  it("loads local settings before configuring telemetry", async () => {
    environment.load.mockImplementation(() => {
      vi.stubEnv("OTEL_SERVICE_NAME", "local-webhook-api");
    });

    const { shutdownTelemetry } = await import("../src/instrumentation.js");

    expect(environment.load).toHaveBeenCalledOnce();
    expect(sdk.configure.mock.calls[0]?.[0].serviceName).toBe("local-webhook-api");
    await shutdownTelemetry();
  }, 15_000);

  it.each(["", "   ", "\t\n"])(
    "rejects a blank service name: %j",
    async (value) => {
      vi.stubEnv("OTEL_SERVICE_NAME", value);

      await expect(import("../src/instrumentation.js")).rejects.toThrow(
        "Expected OTEL_SERVICE_NAME to be a non-empty value",
      );
      expect(sdk.start).not.toHaveBeenCalled();
    },
    15_000,
  );

  it.each([
    { value: undefined, expected: "webhook-api" },
    { value: "delivery-worker", expected: "delivery-worker" },
    { value: "  delivery-worker  ", expected: "delivery-worker" },
  ])("uses service name $expected for $value", async ({ value, expected }) => {
    vi.stubEnv("OTEL_SERVICE_NAME", value);

    const { shutdownTelemetry } = await import("../src/instrumentation.js");

    expect(sdk.configure).toHaveBeenCalledOnce();
    expect(sdk.configure.mock.calls[0]?.[0].serviceName).toBe(expected);
    expect(sdk.start).toHaveBeenCalledOnce();
    await shutdownTelemetry();
  }, 15_000);
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
