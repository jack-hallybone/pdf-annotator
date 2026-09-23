// One property, read from `dist/` rather than from the sources: every
// precached file carries its identity in its path, which Workbox states itself -
// `revision` is null exactly when the path is already the identity.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { join, relative, sep } from "node:path";

import {
  builtFiles,
  sourceMapReferences,
} from "../../scripts/strip-dangling-source-maps.mjs";

import { getManifest } from "workbox-build";

import { PAGES, PDFJS_DIR, PRECACHE } from "../../scripts/precache.mjs";
import { OUT_DIR } from "./builtSite.mjs";

const PRODUCT_NAME = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).productName;

const { manifestEntries, warnings } = await getManifest(PRECACHE);
const precached = new Set(manifestEntries.map(({ url }) => url));

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? walk(path)
      : [relative(OUT_DIR, path).split(sep).join("/")];
  });

test("the build precaches something at all", () => {
  assert.ok(
    manifestEntries.length > 0,
    "the precache manifest is empty, so every assertion below is vacuous",
  );
});

test("workbox reported nothing about the manifest it built", () => {
  // An oversize file is dropped with a warning rather than an error: the PDF.js
  // worker is 2.33 MB and Workbox's default ceiling is 2 MiB.
  assert.deepEqual(warnings, []);
});

test("every precached file carries its identity in its path", () => {
  for (const { url, revision } of manifestEntries) {
    if (PAGES.includes(url)) continue;
    assert.equal(
      revision,
      null,
      `${url} is precached by revision, not by path. Pages selects by path and ignores ` +
        `the query, so a request for it can be answered with a previous deployment's ` +
        `bytes and stored as this one. Hash it, or take it out of the precache - the web ` +
        `manifest and the install icons are read by the operating system, never from ` +
        `this cache, and are already outside it.`,
    );
  }
});

test("the set of precached files without an identity in their path is unchanged", () => {
  const unhashed = manifestEntries
    .filter(({ revision }) => revision !== null)
    .map(({ url }) => url)
    .sort();
  assert.deepEqual(unhashed, [...PAGES].sort());
});

test("nothing the build emitted under a hashed path was left out", () => {
  // Derived rather than declared: a file of an unclassified shape fails the build
  // naming itself instead of being absorbed into the cache or silently skipped.
  const pdfjs = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PDFJS_DIR.test(entry.name))
    .map((entry) => entry.name);
  assert.equal(
    pdfjs.length,
    1,
    `expected exactly one pdfjs-<digest> directory, found ${pdfjs.join(", ") || "none"}`,
  );

  const emitted = [
    ...walk(join(OUT_DIR, "assets")),
    ...walk(join(OUT_DIR, pdfjs[0])),
  ];
  // An empty walk would pass this rule on an artefact with nothing in it.
  assert.ok(
    emitted.filter((url) => url.startsWith(`${pdfjs[0]}/`)).length >= 100,
    `only ${emitted.length} hashed files found; this check is reading the wrong tree`,
  );

  const missing = emitted.filter((url) => !precached.has(url));
  assert.deepEqual(
    missing,
    [],
    `${missing[0]} was emitted under a content-hashed path and is not precached, so an ` +
      `offline launch would 404 on it. Classify it in scripts/precache.mjs, or stop ` +
      `emitting it.`,
  );
});

test("no built file points at a source map that did not ship", () => {
  const files = builtFiles(OUT_DIR);
  // A walk that found nothing would pass this on an artefact full of dangling
  // references.
  assert.ok(files.length > 0, "the build output was walked and held no files");

  const bad = [];
  for (const file of files) {
    for (const reference of sourceMapReferences(OUT_DIR, file)) {
      if (reference.inline) {
        bad.push(`${file} inlines its source map as a data: URI`);
      } else if (!reference.shipped) {
        bad.push(`${file} points at ${reference.target}, which was not built`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

const builtBrowserScripts = (dir = OUT_DIR, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const where = prefix ? `${prefix}${sep}${entry.name}` : entry.name;
    return entry.isDirectory()
      ? builtBrowserScripts(join(dir, entry.name), where)
      : /\.(?:[cm]?js|html)$/.test(entry.name)
        ? [where]
        : [];
  });

test("the app's own bundles fetch PDF.js from the hashed directory", () => {
  const hashed = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PDFJS_DIR.test(entry.name))
    .map((entry) => entry.name);
  assert.equal(hashed.length, 1, `expected one pdfjs-<digest> directory`);
  assert.equal(
    readdirSync(OUT_DIR).includes("pdfjs"),
    false,
    "an unhashed pdfjs/ directory shipped alongside the hashed one",
  );

  const bundles = builtBrowserScripts().filter(
    (where) => where.split(sep)[0] === "assets",
  );
  assert.ok(bundles.length > 0, "no built app bundles to scan");
  assert.ok(
    bundles.some((where) =>
      readFileSync(join(OUT_DIR, where), "utf8").includes(hashed[0]),
    ),
    `no app bundle names ${hashed[0]}, so vite.config.ts substituted nothing ` +
      `and src/pdfRuntime.ts's test-only fallback has shipped. PDF.js would ` +
      `fetch its cmaps, fonts and wasm from an unhashed path - the one whose ` +
      `identity lives in a cache key this host ignores.`,
  );
});

// Not "no field called undoStack is written" - a spelling, and the next spelling
// passes it - but that the shipped code has no way to write to a store.

const STORAGE_WRITE_APIS = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "openDatabase",
  "document.cookie",
  "navigator.storage",
  "caches.open",
  "caches.match",
];

test("the shipped app reaches no browser store", () => {
  const scripts = builtBrowserScripts().filter((where) => where !== "sw.js");
  assert.ok(scripts.length > 0, "no built scripts to scan");

  const found = [];
  for (const where of scripts) {
    const text = readFileSync(join(OUT_DIR, where), "utf8");
    for (const api of STORAGE_WRITE_APIS) {
      if (text.includes(api)) found.push(`${where} reaches ${api}`);
    }
  }
  assert.deepEqual(
    found,
    [],
    "nothing in this app is persisted, and the undo/redo stacks least of all: " +
      "they hold the annotations and the pages the reader DELETED, so a store " +
      "the app can write is a store they can end up in",
  );
});

test("no build-time name token survived into the shipped files", () => {
  const found = [];
  for (const where of ["index.html", "site.webmanifest"]) {
    const path = join(OUT_DIR, where);
    if (!existsSync(path)) {
      found.push(`${where} was not emitted`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    // A file that never carried a token proves nothing, so require the substituted
    // value to be there before trusting its absence.
    if (!text.includes(PRODUCT_NAME)) {
      found.push(`${where} does not name the product at all`);
    }
    for (const token of text.match(/%[A-Z_]+%/g) ?? []) {
      found.push(`${where} still carries ${token}`);
    }
  }
  assert.deepEqual(found, []);
});

// The browser's chrome and the installed app's splash cannot read a custom
// property, so index.html's two `theme-color` metas and the manifest's two
// colours are hand-copied hexes. A manifest carries no media query, so its value
// is the light half, and conditional at-rule blocks are dropped before resolving.

const hex = (value) => {
  const text = String(value).toLowerCase();
  return /^#[0-9a-f]{3}$/.test(text)
    ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
    : text;
};

const shippedStyles = () => {
  const sheets = walk(join(OUT_DIR, "assets")).filter((url) =>
    url.endsWith(".css"),
  );
  const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
  const order = [
    ...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/giu),
  ].flatMap((tag) => {
    const name = /href="([^"]+)"/iu.exec(tag[0])?.[1].split("/").pop();
    return sheets.filter((url) => url.endsWith(`/${name}`));
  });
  order.push(...sheets.filter((url) => !order.includes(url)).sort());
  return order
    .map((url) => readFileSync(join(OUT_DIR, url), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(
      /@(?:media|supports|container)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gu,
      "",
    );
};

// The light/dark pair a token resolves to, or null. The second spelling is what
// Lightning CSS downlevels `light-dark()` to when it minifies this build.
const lightDark = (css, token) => {
  const HEX = "#[0-9a-f]{3}(?:[0-9a-f]{3})?";
  const pattern = new RegExp(
    `${token}\\s*:\\s*(?:light-dark\\(\\s*(${HEX})\\s*,\\s*(${HEX})\\s*\\)` +
      `|var\\(\\s*--lightningcss-light\\s*,\\s*(${HEX})\\s*\\)\\s*` +
      `var\\(\\s*--lightningcss-dark\\s*,\\s*(${HEX})\\s*\\))`,
    "giu",
  );
  let last = null;
  for (const hit of css.matchAll(pattern)) last = hit;
  return (
    last && { light: hex(last[1] ?? last[3]), dark: hex(last[2] ?? last[4]) }
  );
};

const bodyGround = (css) => {
  let token = null;
  for (const [, selectors, block] of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (!selectors.split(",").some((one) => one.trim() === "body")) continue;
    for (const hit of block.matchAll(
      /background(?:-color)?\s*:\s*var\(\s*(--[\w-]+)/giu,
    )) {
      token = hit[1];
    }
  }
  return token;
};

test("the colours declared outside the stylesheet are the ones the app paints", () => {
  const css = shippedStyles();

  // A ground that could not be read would leave the splash colour compared
  // against nothing.
  const ground = bodyGround(css);
  assert.ok(
    ground,
    "no shipped rule paints `body` from a custom property, so the manifest's " +
      "background_color has nothing to be held to",
  );

  const splash = lightDark(css, ground);
  const chrome = lightDark(css, "--theme-surface");
  for (const [token, pair] of [
    [ground, splash],
    ["--theme-surface", chrome],
  ]) {
    assert.ok(
      pair,
      `${token} is not a light-dark() pair in the shipped stylesheets, so the ` +
        `four hand-copied literals would be compared against nothing`,
    );
  }

  const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
  const metas = Object.fromEntries(
    [...html.matchAll(/<meta\b[^>]*name="theme-color"[^>]*>/giu)].map((tag) => [
      /media="\(prefers-color-scheme:\s*(light|dark)\)"/iu.exec(tag[0])?.[1],
      /content="(#[0-9a-f]{3,8})"/iu.exec(tag[0])?.[1],
    ]),
  );
  assert.deepEqual(
    Object.keys(metas).sort(),
    ["dark", "light"],
    "index.html no longer ships exactly one theme-color meta per scheme, so " +
      "the browser is tinting its chrome from something this case cannot see",
  );

  const manifest = JSON.parse(
    readFileSync(join(OUT_DIR, "site.webmanifest"), "utf8"),
  );
  const declared = {
    "the light theme-color meta": [metas.light, chrome.light],
    "the dark theme-color meta": [metas.dark, chrome.dark],
    "the manifest's theme_color": [manifest.theme_color, chrome.light],
    "the manifest's background_color": [
      manifest.background_color,
      splash.light,
    ],
  };
  const wrong = Object.entries(declared)
    .filter(([, [is, want]]) => hex(is) !== want)
    .map(([what, [is, want]]) => `${what} is ${is}, the token says ${want}`);
  assert.deepEqual(
    wrong,
    [],
    `a retint moved the theme and left the browser chrome or the install ` +
      `splash on the old colour: ${wrong.join("; ")}`,
  );
});
