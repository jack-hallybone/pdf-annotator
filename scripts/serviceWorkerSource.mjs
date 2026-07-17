// Builds the service worker source string. Kept as a pure function (no file
// I/O) so it can be unit-tested without a build - the generator script does the
// disk work and calls this. Navigations are network-first *with a timeout*:
// a weak connection that stalls without erroring must not hang the app launch,
// so we fall back to the cached shell once the timeout elapses.
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigateWithCacheFallback(request));
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

async function navigateWithCacheFallback(request) {
  try {
    // Network-first, but don't let a stalled connection hang the launch: if the
    // network doesn't answer within the timeout (or errors), serve the cached
    // app shell instead of waiting indefinitely.
    return await fetchWithTimeout(request, NAVIGATION_NETWORK_TIMEOUT_MS);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(OFFLINE_URL);
    return (
      cached ??
      new Response('PDF Annotator is unavailable offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    );
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
