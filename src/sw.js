// The service worker, as Workbox builds it: `vite.config.ts` injects the precache manifest.
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { setCacheNameDetails } from "workbox-core";
import { PACKAGE_NAME } from "./packageName";

// `cleanupOutdatedCaches()` knows only Workbox's precache names, so the caches of the worker this replaced would be left behind for good.
const shellPrefix = `${PACKAGE_NAME}-shell-`;
const sweepPredecessor = async () => {
  for (const name of await caches.keys()) {
    if (name.startsWith(shellPrefix)) await caches.delete(name);
  }
};
self.addEventListener("activate", (event) =>
  event.waitUntil(sweepPredecessor()),
);

// Explicit and derived from package.json, not Workbox's shared "workbox" default: several of this fleet's projects precache on one shared origin.
setCacheNameDetails({ prefix: PACKAGE_NAME });
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
