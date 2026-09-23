// The code-splitting boundary, measured against the built output: one static
// import of the tabbedapp barrel pulls the lazily imported PDF stack back into
// the entry (rolldown only warns), and it looks fine on the dev server, whose
// module graph is unbundled.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { OUT_DIR } from "./builtSite.mjs";

const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");

const referenced = [
  ...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g),
].map((match) => match[1].split("/").pop());

const sizeOf = (file) => {
  try {
    return readFileSync(join(OUT_DIR, "assets", file)).length;
  } catch {
    return 0;
  }
};

test("the deferred PDF code is not in the initial bundle", () => {
  // An index.html this pattern read nothing out of would pass whatever the build
  // put in it.
  assert.ok(
    referenced.length > 0,
    "index.html references no built asset at all; this case is reading the wrong file",
  );

  // pdf.worker is a URL preloaded on purpose to warm the cache, never imported
  // as code, so it does not count against the boundary.
  const deferred = /(pdfjs|TabbedAppDocument|pdfTemplates|^es-)/;
  const leaked = referenced.filter(
    (file) => deferred.test(file) && !/pdf\.worker/.test(file),
  );

  assert.deepEqual(
    leaked,
    [],
    "index.html references deferred PDF code. Something statically imports the " +
      "tabbedapp, or a manual chunk group was hoisted into the entry. See " +
      "build.chunkSizeWarningLimit in vite.config.ts for the history.",
  );
});

test("the initial bundle is inside its budget", () => {
  const BUDGET = 400 * 1024;
  const initialBytes = referenced.reduce(
    (total, file) => total + sizeOf(file),
    0,
  );

  assert.ok(
    initialBytes > 0,
    "the referenced entry files measured zero bytes; this case is reading the wrong tree",
  );
  assert.ok(
    initialBytes <= BUDGET,
    `${(initialBytes / 1024).toFixed(1)} kB of JS+CSS before first paint, over ` +
      `the ${BUDGET / 1024} kB budget:\n` +
      readdirSync(join(OUT_DIR, "assets"))
        .filter((file) => referenced.includes(file))
        .map((file) => `  ${file} ${(sizeOf(file) / 1024).toFixed(1)} kB`)
        .join("\n"),
  );
});
