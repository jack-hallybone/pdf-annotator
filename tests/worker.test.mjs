// The caches this project's worker sweeps must stay its own, because `caches.keys()` is origin-wide and several projects share this origin.

//   Run:  node tests/worker.test.mjs   (builds the site; needs playwright's chromium)

import assert from "node:assert/strict";
import { after, test } from "node:test";

// From @playwright/test, which is what package.json declares: `playwright` resolves only because it is installed underneath it, so naming it here would be an undeclared dependency and declaring it a second version pin.
import { chromium } from "@playwright/test";
import { serveBuiltSite } from "./site.mjs";

const site = await serveBuiltSite("sw.js");
const APP = site.url;

const browser = await chromium.launch({ headless: true });

const APP_READY = ".browserapp-home-card";

// Matched rather than named: its hash changes every time the source does.
const ENTRY = /\/assets\/index-[A-Za-z0-9_-]+\.js$/u;

// Activated is not the same as controlling: with no `clientsClaim` the page that installs the worker is not controlled by it, so waiting for a `controllerchange` on that first load waits forever.
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

// Found by asking rather than by rebuilding Workbox's naming rule: a name derived here would stop matching the moment Workbox changed it, and the case would pass having planted nothing.
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

// A page the worker actually serves, asserted rather than assumed: an uncontrolled page reads straight from the network and would pass every case below while proving nothing about the cache.
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
  // Eleven projects share this origin, and `cleanupOutdatedCaches()` deletes caches that look like older versions of its own. Workbox's default cache suffix is `registration.scope`, which differs per project.
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

// The first load in a fresh context is never controlled (no clientsClaim, see `activated` above); a reload past activation is.
async function controlledPage(context) {
  const page = await installer(context);
  await page.reload({ waitUntil: "networkidle" });
  assert.ok(
    await page.evaluate(() => !!navigator.serviceWorker.controller),
    "the page is still not controlled after a reload past activation",
  );
  return page;
}

// Polls inside the page, since page.waitForFunction settles at once on an async predicate; update() is re-issued because a lone call can stall.
async function waitForWaitingWorker(page, timeoutMs) {
  return page.evaluate(async (timeout) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const registration = await navigator.serviceWorker.getRegistration();
      registration?.update().catch(() => {});
      if (registration?.waiting?.state === "installed") return true;
      await new Promise((done) => setTimeout(done, 200));
    }
    return false;
  }, timeoutMs);
}

async function registrationState(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      active: registration?.active?.state ?? null,
      waiting: registration?.waiting?.state ?? null,
      controller: !!navigator.serviceWorker.controller,
    };
  });
}

async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  return false;
}

test("a reload after an update has downloaded switches to the new worker, alone in the app", async (t) => {
  const context = await browser.newContext();
  t.after(async () => await context.close());

  site.reset();
  const page = await controlledPage(context);

  site.redeploy();
  assert.ok(
    await waitForWaitingWorker(page, 60_000),
    "a redeployed sw.js never reached the waiting state",
  );

  let loads = 0;
  // DOMContentLoaded, not load: the self-reload can replace the reloaded document before its load event fires.
  page.on("domcontentloaded", () => loads++);
  await page.reload();
  // The page's own second load, once the new worker takes over (see applyWaitingUpdate in src/browserapp/pwa.ts).
  assert.ok(
    await waitFor(() => loads >= 2, 20_000),
    `the page did not self-reload a second time after the takeover (loads=${loads})`,
  );

  const state = await registrationState(page);
  assert.equal(state.waiting, null, "the waiting worker is still there");
  assert.equal(state.active, "activated", "no worker ended up in charge");
  assert.ok(state.controller, "the reloaded page is not controlled");
});

test("a second open window blocks the takeover until it closes", async (t) => {
  const context = await browser.newContext();
  t.after(async () => await context.close());

  site.reset();
  const page1 = await controlledPage(context);

  // A fresh navigation after activation is controlled immediately, with no clientsClaim needed for that.
  const page2 = await context.newPage();
  await page2.goto(APP, { waitUntil: "networkidle" });
  assert.ok(
    await page2.evaluate(() => !!navigator.serviceWorker.controller),
    "the second window is not controlled",
  );

  site.redeploy();
  assert.ok(
    await waitForWaitingWorker(page1, 60_000),
    "a redeployed sw.js never reached the waiting state",
  );

  let loads1 = 0;
  // DOMContentLoaded, not load: the self-reload can replace the reloaded document before its load event fires.
  page1.on("domcontentloaded", () => loads1++);
  await page1.reload();
  // Given time to prove nothing happens, rather than only that it hasn't happened yet.
  await new Promise((done) => setTimeout(done, 3_000));
  assert.equal(
    loads1,
    1,
    "the page self-reloaded although a second window is still open",
  );
  let state = await registrationState(page1);
  assert.equal(
    state.waiting,
    "installed",
    "the waiting worker was consumed although a second window is still open",
  );
  assert.equal(
    state.active,
    "activated",
    "the old worker is no longer in charge",
  );

  await page2.close();
  assert.ok(
    await waitFor(
      async () =>
        (await page1.evaluate(
          async () =>
            (await navigator.locks.query()).held.filter(
              (lock) => lock.name === "pdf-annotator-window",
            ).length,
        )) <= 1,
      5_000,
    ),
    "the closed window still holds its lock",
  );
  loads1 = 0;
  await page1.reload();
  assert.ok(
    await waitFor(() => loads1 >= 2, 20_000),
    `the page did not self-reload after the last other window closed (loads=${loads1})`,
  );
  state = await registrationState(page1);
  assert.equal(
    state.waiting,
    null,
    "the waiting worker is still there once the other window is gone",
  );
  assert.equal(state.active, "activated", "no worker ended up in charge");
});

after(async () => {
  await browser.close();
  site.close();
});
