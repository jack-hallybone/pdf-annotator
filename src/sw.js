// The service worker, as Workbox builds it: `vite.config.ts` injects the
// precache manifest.
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { PACKAGE_NAME } from "./packageName";

// `cleanupOutdatedCaches()` knows only Workbox's precache names, so the caches
// of the worker this replaced would be left behind for good.
const shellPrefix = `${PACKAGE_NAME}-shell-`;
const sweepPredecessor = async () => {
  for (const name of await caches.keys()) {
    if (name.startsWith(shellPrefix)) await caches.delete(name);
  }
};
self.addEventListener("activate", (event) =>
  event.waitUntil(sweepPredecessor()),
);

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
