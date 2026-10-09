import { beforeEach, describe, expect, it, vi } from "vitest";

const environment = vi.hoisted(() => ({ load: vi.fn<() => void>() }));

vi.mock("node:process", () => ({ loadEnvFile: environment.load }));

beforeEach(() => {
  vi.resetModules();
  environment.load.mockReset();
});

describe("local environment file", () => {
  it("loads the default .env file", async () => {
    await import("../src/environment.js");

    expect(environment.load).toHaveBeenCalledExactlyOnceWith();
  });

  it("allows startup without an .env file", async () => {
    environment.load.mockImplementation(() => {
      throw Object.assign(new Error("File not found"), { code: "ENOENT" });
    });

    await expect(import("../src/environment.js")).resolves.toBeDefined();
  });

  it.each(["EACCES", "EISDIR", "EIO"])("does not hide a %s error", async (code) => {
    const failure = Object.assign(new Error("Cannot read environment file"), { code });
    environment.load.mockImplementation(() => { throw failure; });

    await expect(import("../src/environment.js")).rejects.toBe(failure);
  });
});
