import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("application configuration", () => {
  it("uses local defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 3000,
      deliveryTargetUrl: "http://127.0.0.1:3000/mock/webhooks",
      deliveryTimeoutMs: 3000,
    });
  });

  it("rejects an invalid timeout", () => {
    expect(() => loadConfig({ DELIVERY_TIMEOUT_MS: "zero" })).toThrow(
      "Expected a positive integer",
    );
  });
});
