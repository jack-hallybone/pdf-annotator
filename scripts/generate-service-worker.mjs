import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(root, 'out', 'renderer');
const indexPath = join(outputRoot, 'index.html');

if (!existsSync(indexPath)) {
  throw new Error('Build the renderer before generating its service worker.');
}

const files = listFiles(outputRoot)
  .filter((filePath) => !filePath.endsWith(`${sep}sw.js`))
  .sort();
const versionHash = createHash('sha256');
const assetUrls = ['./'];

for (const filePath of files) {
  const relativePath = relative(outputRoot, filePath).split(sep).join('/');
  assertPrecacheableOutput(relativePath);
  versionHash.update(relativePath);
  versionHash.update(readFileSync(filePath));
  assetUrls.push(`./${relativePath}`);
}

const cacheVersion = versionHash.digest('hex').slice(0, 16);
const serviceWorker = `const CACHE_NAMESPACE =
  'pdf-annotator:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_NAMESPACE + ${JSON.stringify(cacheVersion)};
const PRECACHE_URLS = ${JSON.stringify(Array.from(new Set(assetUrls)), null, 2)};
const PRECACHE_URL_SET = new Set(
  PRECACHE_URLS.map((url) => new URL(url, self.registration.scope).href)
);
const OFFLINE_URL = new URL('./index.html', self.registration.scope).href;

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
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(OFFLINE_URL);
        return cached ?? new Response('PDF Annotator is unavailable offline.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
    );
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
`;

writeFileSync(join(outputRoot, 'sw.js'), serviceWorker);

function listFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = join(directory, entry);
    return statSync(filePath).isDirectory() ? listFiles(filePath) : [filePath];
  });
}

function assertPrecacheableOutput(relativePath) {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  if (isSuspiciousOutputFile(normalizedPath)) {
    throw new Error(
      `Refusing to precache suspicious build output: ${normalizedPath}`
    );
  }

  if (isAllowedPrecacheFile(normalizedPath)) {
    return;
  }

  throw new Error(`Unexpected build output file: ${normalizedPath}`);
}

function isSuspiciousOutputFile(relativePath) {
  return (
    /\.map$/i.test(relativePath) ||
    /\.pdf$/i.test(relativePath) ||
    /(^|\/)\.env(\.|$)/i.test(relativePath) ||
    /(^|\/)(fixture|fixtures|test_pdfs?)(\/|$)/i.test(relativePath)
  );
}

function isAllowedPrecacheFile(relativePath) {
  if (
    [
      'apple-touch-icon.png',
      'favicon.ico',
      'favicon.svg',
      'index.html',
      'LUCIDE-LICENSE.txt',
      'maskable-icon-192x192.png',
      'maskable-icon-512x512.png',
      'site.webmanifest',
      'title.svg',
      'web-app-manifest-192x192.png',
      'web-app-manifest-512x512.png'
    ].includes(relativePath)
  ) {
    return true;
  }

  return (
    /^assets\/.+\.(css|js|mjs|svg)$/i.test(relativePath) ||
    /^pdfjs\/LICENSE$/i.test(relativePath) ||
    /^pdfjs\/cmaps\/(?:LICENSE|.+\.bcmap)$/i.test(relativePath) ||
    /^pdfjs\/iccs\/(?:LICENSE|.+\.icc)$/i.test(relativePath) ||
    /^pdfjs\/standard_fonts\/(?:LICENSE_[A-Z]+|.+\.(pfb|ttf))$/i.test(
      relativePath
    ) ||
    /^pdfjs\/wasm\/(?:LICENSE_[A-Z0-9_]+|.+\.(js|wasm))$/i.test(relativePath)
  );
}
