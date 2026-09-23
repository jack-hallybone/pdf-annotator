import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererOutput = join(root, "dist");

// Removing this one exact build directory first keeps obsolete hashed bundles
// out of a later precache manifest.
rmSync(rendererOutput, {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
});
