import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("application configuration", () => {
  it("uses local defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 3000,
      logLevel: "info",
      deliveryTargetUrl: "http://127.0.0.1:3000/mock/webhooks",
      deliveryTimeoutMs: 3000,
      mockReceiverStatusCode: 200,
      mockReceiverDelayMs: 0,
    });
  });

  it.each(["trace", "debug", "info", "warn", "error", "fatal", "silent"])(
    "loads log level %s", (level) => {
      expect(loadConfig({ LOG_LEVEL: level }).logLevel).toBe(level);
    },
  );

  it("trims whitespace around the log level", () => {
    expect(loadConfig({ LOG_LEVEL: " warn " }).logLevel).toBe("warn");
  });

  it.each(["", " ", "INFO", "warning", "verbose", "30"])(
    "rejects invalid log level %j", (level) => {
      expect(() => loadConfig({ LOG_LEVEL: level })).toThrow("Expected LOG_LEVEL to be");
    },
  );

  it("rejects an invalid timeout", () => {
    expect(() => loadConfig({ DELIVERY_TIMEOUT_MS: "zero" })).toThrow(
      "Expected a positive integer",
    );
  });

  it.each([
    { host: "0.0.0.0", targetHost: "127.0.0.1" },
    { host: "127.0.0.1", targetHost: "127.0.0.1" },
    { host: "192.0.2.10", targetHost: "192.0.2.10" },
    { host: "localhost", targetHost: "localhost" },
    { host: "::", targetHost: "[::1]" },
    { host: "0:0:0:0:0:0:0:0", targetHost: "[::1]" },
    { host: " ::1 ", targetHost: "[::1]" },
    { host: "2001:db8::10", targetHost: "[2001:db8::10]" },
  ])("derives the local receiver from HOST=$host and PORT", ({ host, targetHost }) => {
    expect(loadConfig({ HOST: host, PORT: "4312" })).toMatchObject({
      host: host.trim(),
      port: 4312,
      deliveryTargetUrl: `http://${targetHost}:4312/mock/webhooks`,
    });
  });

  it("keeps an explicit receiver independent of the bind address", () => {
    expect(loadConfig({
      HOST: "::1", PORT: "4312", DELIVERY_TARGET_URL: "https://receiver.test/events",
    }).deliveryTargetUrl).toBe("https://receiver.test/events");
  });

  it("rejects an excessive delivery timeout", () => {
    expect(() => loadConfig({ DELIVERY_TIMEOUT_MS: "60001" })).toThrow(
      "Expected DELIVERY_TIMEOUT_MS to be at most 60000",
    );
  });

  it("rejects a port outside the TCP range", () => {
    expect(() => loadConfig({ PORT: "65536" })).toThrow(
      "Expected PORT to be at most 65535",
    );
  });

  it.each(["", "   ", "\t\n"])("rejects an empty host: %j", (host) => {
    expect(() => loadConfig({ HOST: host })).toThrow(
      "Expected HOST to be a non-empty value",
    );
  });

  it.each([
    { value: " 127.0.0.1 ", expected: "127.0.0.1" },
    { value: "\tlocalhost\n", expected: "localhost" },
    { value: " ::1 ", expected: "::1" },
    { value: "0.0.0.0", expected: "0.0.0.0" },
  ])("normalizes host $value to $expected", ({ value, expected }) => {
    expect(loadConfig({ HOST: value }).host).toBe(expected);
  });

  it("rejects a non-HTTP delivery target", () => {
    expect(() => loadConfig({ DELIVERY_TARGET_URL: "ftp://receiver.test" })).toThrow(
      "Expected DELIVERY_TARGET_URL to be a valid HTTP URL",
    );
  });

  it("rejects a malformed delivery target", () => {
    expect(() => loadConfig({ DELIVERY_TARGET_URL: "not a URL" })).toThrow(
      "Expected DELIVERY_TARGET_URL to be a valid HTTP URL",
    );
  });

  it("rejects credentials in the delivery target", () => {
    expect(() =>
      loadConfig({ DELIVERY_TARGET_URL: "https://user:secret@receiver.test" }),
    ).toThrow("DELIVERY_TARGET_URL must not contain credentials");
  });

  it("rejects a fragment in the delivery target", () => {
    expect(() =>
      loadConfig({ DELIVERY_TARGET_URL: "https://receiver.test/webhooks#events" }),
    ).toThrow("DELIVERY_TARGET_URL must not contain a fragment");
  });

  it("loads a mock receiver failure status", () => {
    expect(loadConfig({ MOCK_RECEIVER_STATUS_CODE: "503" })).toMatchObject({
      mockReceiverStatusCode: 503,
    });
  });

  it("rejects an invalid mock receiver status", () => {
    expect(() => loadConfig({ MOCK_RECEIVER_STATUS_CODE: "700" })).toThrow(
      "Expected an HTTP status from 200 to 599",
    );
  });

  it.each(["0", "250", "60000"])("loads mock receiver delay %s", (value) => {
    expect(loadConfig({ MOCK_RECEIVER_DELAY_MS: value }).mockReceiverDelayMs).toBe(Number(value));
  });

  it.each(["", " ", "-1", "1.5", "60001", "NaN", "Infinity", "slow"])(
    "rejects invalid mock receiver delay %j",
    (value) => {
      expect(() => loadConfig({ MOCK_RECEIVER_DELAY_MS: value })).toThrow(
        "Expected MOCK_RECEIVER_DELAY_MS to be an integer between 0 and 60000",
      );
    },
  );
});
