import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("application configuration", () => {
  it("uses local defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 3000,
      deliveryTargetUrl: "http://127.0.0.1:3000/mock/webhooks",
      deliveryTimeoutMs: 3000,
      mockReceiverStatusCode: 200,
    });
  });

  it("rejects an invalid timeout", () => {
    expect(() => loadConfig({ DELIVERY_TIMEOUT_MS: "zero" })).toThrow(
      "Expected a positive integer",
    );
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
});
