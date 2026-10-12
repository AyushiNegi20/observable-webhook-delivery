import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { serviceVersion } from "../src/service-metadata.js";

describe("service metadata", () => {
  it("uses the application version from package.json", async () => {
    const contents = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const packageMetadata = JSON.parse(contents) as { version: string };

    expect(serviceVersion).toBe(packageMetadata.version);
  });
});
