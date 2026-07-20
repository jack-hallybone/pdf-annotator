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
import { buildServiceWorkerSource } from './serviceWorkerSource.mjs';

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

// On GitHub Pages every deploy is tied 1:1 to a commit, so anchoring the
// cache version to the commit SHA (rather than only a content hash)
// guarantees a cache-busting update on every deploy - even one that happens
// not to change any precached bytes - and it matches the commit already
// shown in the in-app build info (see buildInfo.ts). VITE_BUILD_SHA is set
// by the deploy workflow (.github/workflows/deploy.yml); local builds don't
// have a commit SHA wired in, so they fall back to the content hash.
const commitSha = (process.env.VITE_BUILD_SHA ?? '').trim();
const cacheVersion = commitSha
  ? commitSha.slice(0, 16)
  : versionHash.digest('hex').slice(0, 16);
const serviceWorker = buildServiceWorkerSource(
  cacheVersion,
  Array.from(new Set(assetUrls))
);

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
      'og-image.png',
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
