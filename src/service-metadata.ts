import { createRequire } from "node:module";

const packageMetadata = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const serviceVersion = packageMetadata.version;
