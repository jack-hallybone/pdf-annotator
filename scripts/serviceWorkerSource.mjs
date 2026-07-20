// Builds the service worker source string. Kept as a pure function (no file
// I/O) so it can be unit-tested without a build - the generator script does the
// disk work and calls this. Navigations are cache-first: the cached shell is
// served immediately (instant, works offline), and picking up a new deploy is
// handled separately by the browser's own SW update check plus the in-page
// "update available" prompt (see registerBrowserServiceWorker in pwa.ts),
// not by racing the network on every navigation. The network path here is
// only a fallback for the rare case nothing is cached yet (e.g. a corrupted
// cache), so it still gets a timeout to avoid hanging on a stalled connection.
export const NAVIGATION_NETWORK_TIMEOUT_MS = 3000;

export function buildServiceWorkerSource(
  cacheVersion,
  precacheUrls,
  { navigationTimeoutMs = NAVIGATION_NETWORK_TIMEOUT_MS } = {}
) {
  return `const CACHE_NAMESPACE =
  'pdf-annotator:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_NAMESPACE + ${JSON.stringify(cacheVersion)};
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};
const PRECACHE_URL_SET = new Set(
  PRECACHE_URLS.map((url) => new URL(url, self.registration.scope).href)
);
const OFFLINE_URL = new URL('./index.html', self.registration.scope).href;
const NAVIGATION_NETWORK_TIMEOUT_MS = ${JSON.stringify(navigationTimeoutMs)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) =>
              name.startsWith(CACHE_NAMESPACE) && name !== CACHE_NAME
            )
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// The page posts this once the user accepts the "update available" prompt,
// so the new worker (parked in the waiting state after installing) takes
// over immediately instead of waiting for every tab of the old version to
// close. See applyAvailableServiceWorkerUpdate() in pwa.ts.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigateCacheFirst(request));
    return;
  }

  if (!PRECACHE_URL_SET.has(request.url)) {
    return;
  }

  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(request))
      .then((cached) => cached ?? fetch(request))
  );
});

async function navigateCacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(OFFLINE_URL);
  if (cached) {
    return cached;
  }

  // Nothing cached yet (first install still in flight, or a wiped cache) -
  // fall back to the network, but don't let a stalled connection hang the
  // launch indefinitely.
  try {
    return await fetchWithTimeout(request, NAVIGATION_NETWORK_TIMEOUT_MS);
  } catch {
    return new Response('PDF Annotator is unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() =>
    clearTimeout(timeout)
  );
}
`;
}
