// The caches this project's worker sweeps must stay its own, because
// `caches.keys()` is origin-wide and several projects share this origin.

//   Run:  node tests/worker.test.mjs   (builds the site; needs playwright's chromium)

import assert from "node:assert/strict";
import { after, test } from "node:test";

// From @playwright/test, which is what package.json declares: `playwright`
// resolves only because it is installed underneath it, so naming it here would
// be an undeclared dependency and declaring it a second version pin.
import { chromium } from "@playwright/test";
import { serveBuiltSite } from "./site.mjs";

const site = await serveBuiltSite("sw.js");
const APP = site.url;

const browser = await chromium.launch({ headless: true });

const APP_READY = ".browserapp-home-card";

// Matched rather than named: its hash changes every time the source does.
const ENTRY = /\/assets\/index-[A-Za-z0-9_-]+\.js$/u;

// Activated is not the same as controlling: with no `clientsClaim` the page that
// installs the worker is not controlled by it, so waiting for a
// `controllerchange` on that first load waits forever.
const activated = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active?.state === "activated") return;
    await new Promise((done) => {
      registration.active?.addEventListener("statechange", function settled() {
        if (registration.active?.state === "activated") {
          registration.active.removeEventListener("statechange", settled);
          done();
        }
      });
    });
  });

// Found by asking rather than by rebuilding Workbox's naming rule: a name
// derived here would stop matching the moment Workbox changed it, and the case
// would pass having planted nothing.
const precacheName = (page) =>
  page.evaluate(async () => {
    const names = await caches.keys();
    return names.find((name) => name.includes("precache")) ?? null;
  });

async function installer(context) {
  const page = await context.newPage();
  await page.goto(APP, { waitUntil: "networkidle" });
  await activated(page);
  return page;
}

// A page the worker actually serves, asserted rather than assumed: an
// uncontrolled page reads straight from the network and would pass every case
// below while proving nothing about the cache.
async function served(context, { offline = false } = {}) {
  const page = await context.newPage();
  await page.goto(APP, { waitUntil: "domcontentloaded" }).catch(() => {});
  const controller = await page
    .evaluate(() => !!navigator.serviceWorker.controller)
    .catch(() => false);
  if (!offline) {
    assert.ok(
      controller,
      "this page is not controlled by the worker, so nothing it sees came from the cache",
    );
  }
  return page;
}

test("the app installs a worker and opens with the network dead", async (t) => {
  const context = await browser.newContext();
  t.after(async () => {
    site.kill(false);
    await context.close();
  });

  const page = await installer(context);
  const name = await precacheName(page);
  assert.ok(
    name,
    `no precache after activation: ${await page.evaluate(() => caches.keys())}`,
  );

  const keys = await page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  }, name);
  assert.ok(
    keys.some((key) => ENTRY.test(key)),
    `the entry bundle is not precached: ${keys.length} keys`,
  );
  assert.ok(
    keys.filter((key) => /\/pdfjs-[0-9a-f]{12}\//u.test(key)).length >= 100,
    "the PDF.js runtime assets are not precached, so an offline document would " +
      "render without its CMaps, fonts or wasm",
  );

  site.kill(true);
  const offline = await served(context, { offline: true });
  await offline.waitForSelector(APP_READY, { timeout: 15_000 });
});

test("the precache is namespaced to this deployment, so a sibling's sweep cannot reach it", async (t) => {
  // Eleven projects share this origin, and `cleanupOutdatedCaches()` deletes
  // caches that look like older versions of its own. Workbox's default cache
  // suffix is `registration.scope`, which differs per project.
  const context = await browser.newContext();
  t.after(async () => await context.close());

  const page = await installer(context);
  const name = await precacheName(page);
  const scope = await page.evaluate(
    async () => (await navigator.serviceWorker.ready).scope,
  );

  assert.ok(
    name.includes(scope),
    `the precache name (${name}) does not carry this deployment's scope (${scope}), ` +
      "so a sibling project on this origin could match and delete it",
  );
});

test("the predecessor's caches are swept, and only this project's", async (t) => {
  const context = await browser.newContext();
  t.after(async () => await context.close());

  const page = await installer(context);
  await page.evaluate(async () => {
    for (const name of [
      "pdf-annotator-shell-abc123456789",
      "other-app-shell-abc123456789",
      "pdf-annotator-two-shell-abc123456789",
    ]) {
      const cache = await caches.open(name);
      await cache.put("./probe", new Response("probe"));
    }
    await (await navigator.serviceWorker.getRegistration())?.unregister();
  });

  const again = await installer(context);
  const names = await again.evaluate(() => caches.keys());

  assert.ok(
    !names.includes("pdf-annotator-shell-abc123456789"),
    `the predecessor's shell cache survived activation: ${names.join(", ")}`,
  );
  assert.ok(
    names.includes("other-app-shell-abc123456789") &&
      names.includes("pdf-annotator-two-shell-abc123456789"),
    `the sweep reached a sibling project on this shared origin: ${names.join(", ")}`,
  );
});

after(async () => {
  await browser.close();
  site.close();
});
