import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  NAVIGATION_NETWORK_TIMEOUT_MS,
  buildServiceWorkerSource
} from '../scripts/serviceWorkerSource.mjs';

const SCOPE = 'https://app.example/pdf/';
const OFFLINE_URL = new URL('./index.html', SCOPE).href;
const TEST_TIMEOUT_MS = 30;

type FetchInit = { signal?: AbortSignal };
type SwRequest = { method: string; mode: string; url: string };
type FetchImpl = (request: SwRequest, init?: FetchInit) => Promise<Response>;
type FetchEvent = {
  request: SwRequest;
  respondWith: (response: Promise<Response>) => void;
};
type MessageEvent = { data: unknown };

// Loads the generated service-worker source into a sandbox with mocked SW
// globals and returns a way to fire fetch events at it. This exercises the real
// generated code (navigation timeout, cache fallback) rather than asserting on
// the template string.
function instantiateServiceWorker(options: {
  fetchImpl: FetchImpl;
  cache: Map<string, Response>;
  fetchCalls?: { count: number };
  skipWaiting?: () => void;
}) {
  const { fetchImpl, cache } = options;
  const listeners: Record<
    string,
    ((event: FetchEvent) => void) | ((event: MessageEvent) => void)
  > = {};

  const cachesMock = {
    open: async () => ({
      // Real Cache.match accepts a URL string or a Request; normalise both.
      match: async (key: string | SwRequest) =>
        cache.get(typeof key === 'string' ? key : key.url),
      addAll: async () => undefined
    }),
    keys: async () => [],
    delete: async () => undefined
  };

  const sandbox: Record<string, unknown> = {
    self: {
      registration: { scope: SCOPE },
      addEventListener: (
        type: string,
        handler: ((event: FetchEvent) => void) | ((event: MessageEvent) => void)
      ) => {
        listeners[type] = handler;
      },
      clients: { claim: () => undefined },
      skipWaiting: options.skipWaiting ?? (() => undefined)
    },
    caches: cachesMock,
    fetch: (request: SwRequest, init?: FetchInit) => {
      if (options.fetchCalls) {
        options.fetchCalls.count += 1;
      }
      return fetchImpl(request, init);
    },
    Response,
    AbortController,
    URL,
    Set,
    Promise,
    console,
    setTimeout,
    clearTimeout
  };

  const source = buildServiceWorkerSource('v-test', ['./', './index.html'], {
    navigationTimeoutMs: TEST_TIMEOUT_MS
  });
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const dispatch = (request: SwRequest) => {
    let captured: Promise<Response> | undefined;
    (listeners.fetch as (event: FetchEvent) => void)({
      request,
      respondWith: (response) => {
        captured = response;
      }
    });
    return captured;
  };

  return {
    navigate: (url = `${SCOPE}some/route`) =>
      dispatch({ method: 'GET', mode: 'navigate', url }),
    requestAsset: (url: string) =>
      dispatch({ method: 'GET', mode: 'cors', url }),
    sendMessage: (data: unknown) =>
      (listeners.message as (event: MessageEvent) => void)?.({ data })
  };
}

// A network that connects but never answers - the weak-Wi-Fi case. Rejects only
// when the request is aborted, so without a timeout it would hang forever.
const hangingFetch: FetchImpl = (_request, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

test('navigation is served from the cached shell instantly, without hitting the network', async () => {
  const shell = new Response('<!doctype html>shell', { status: 200 });
  const fetchCalls = { count: 0 };
  const sw = instantiateServiceWorker({
    // A newer deploy on the network must not win a race against the cache -
    // cache-first means this fetchImpl should never even be called.
    fetchImpl: async () => new Response('fresh from network', { status: 200 }),
    cache: new Map([[OFFLINE_URL, shell]]),
    fetchCalls
  });

  const response = await sw.navigate();
  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), '<!doctype html>shell');
  assert.equal(fetchCalls.count, 0);
});

test('navigation falls back to the network when nothing is cached yet', async () => {
  const network = new Response('fresh from network', { status: 200 });
  const sw = instantiateServiceWorker({
    fetchImpl: async () => network,
    cache: new Map()
  });

  const response = await sw.navigate();
  assert.equal(await response?.text(), 'fresh from network');
});

test('navigation falls back to a stalled-network timeout when nothing is cached', async () => {
  const sw = instantiateServiceWorker({
    fetchImpl: hangingFetch,
    cache: new Map()
  });

  const response = await sw.navigate();
  assert.equal(response?.status, 503);
});

test('navigation returns 503 when offline and no shell is cached', async () => {
  const sw = instantiateServiceWorker({
    fetchImpl: () => Promise.reject(new Error('offline')),
    cache: new Map()
  });

  const response = await sw.navigate();
  assert.equal(response?.status, 503);
});

test('a SKIP_WAITING message activates the waiting worker immediately', () => {
  let skipWaitingCalled = false;
  const sw = instantiateServiceWorker({
    fetchImpl: async () => new Response('unused'),
    cache: new Map(),
    skipWaiting: () => {
      skipWaitingCalled = true;
    }
  });

  sw.sendMessage('SKIP_WAITING');
  assert.equal(skipWaitingCalled, true);
});

test('a precached asset is served from cache without hitting the network', async () => {
  const asset = new Response('cached asset', { status: 200 });
  const fetchCalls = { count: 0 };
  const sw = instantiateServiceWorker({
    fetchImpl: async () => new Response('network asset'),
    cache: new Map([[OFFLINE_URL, asset]]),
    fetchCalls
  });

  const response = await sw.requestAsset(OFFLINE_URL);
  assert.equal(await response?.text(), 'cached asset');
  assert.equal(fetchCalls.count, 0);
});

test('the shipped default navigation timeout is a sane, non-zero value', () => {
  assert.ok(NAVIGATION_NETWORK_TIMEOUT_MS >= 1000);
  assert.ok(NAVIGATION_NETWORK_TIMEOUT_MS <= 10000);
});
