// A check that skipped over a missing artefact would read exactly like a clean
// one, so the absence of a build is a failure here.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { OUT_DIR } from "../../scripts/precache.mjs";

export { OUT_DIR };

if (!existsSync(join(OUT_DIR, "index.html"))) {
  throw new Error(
    "dist holds no build, so nothing here can read what shipped. " +
      "Run `npm run build` first (`npm run verify` does).",
  );
}
