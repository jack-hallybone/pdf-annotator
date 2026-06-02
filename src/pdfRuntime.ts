import { GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

let configured = false;
let warmFetchStarted = false;
const preloadedLinks = new Set<string>();
const pdfJsWasmAssetBase = `${import.meta.env.BASE_URL}pdfjs/wasm/`;
const warmablePdfJsAssets = [
  `${pdfJsWasmAssetBase}openjpeg.wasm`,
  `${pdfJsWasmAssetBase}jbig2.wasm`,
  `${pdfJsWasmAssetBase}qcms_bg.wasm`
];

export function configurePdfRuntime() {
  if (configured) {
    return;
  }

  configured = true;
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  warmPdfRuntimeCaches();
}

export function warmPdfRuntimeCaches({
  immediate = false
}: { immediate?: boolean } = {}) {
  preloadModule(pdfWorkerUrl);

  for (const assetUrl of warmablePdfJsAssets) {
    preloadFetch(assetUrl, 'application/wasm');
  }

  if (immediate) {
    fetchWarmAssets(warmablePdfJsAssets);
    return;
  }

  scheduleIdleWork(() => fetchWarmAssets(warmablePdfJsAssets));
}

function preloadModule(href: string) {
  appendPreloadLink(`module:${href}`, (link) => {
    link.href = href;
    link.rel = 'modulepreload';
  });
}

function preloadFetch(href: string, type: string) {
  appendPreloadLink(`fetch:${href}`, (link) => {
    link.as = 'fetch';
    link.crossOrigin = 'anonymous';
    link.href = href;
    link.rel = 'preload';
    link.type = type;
    link.setAttribute('fetchpriority', 'low');
  });
}

function appendPreloadLink(
  key: string,
  configure: (link: HTMLLinkElement) => void
) {
  if (preloadedLinks.has(key)) {
    return;
  }

  const link = document.createElement('link');
  configure(link);
  document.head.append(link);
  preloadedLinks.add(key);
}

function fetchWarmAssets(assetUrls: string[]) {
  if (warmFetchStarted) {
    return;
  }

  warmFetchStarted = true;
  for (const assetUrl of assetUrls) {
    void fetch(assetUrl, { cache: 'force-cache' }).catch(() => undefined);
  }
}

function scheduleIdleWork(task: () => void) {
  if (window.requestIdleCallback) {
    window.requestIdleCallback(task, { timeout: 600 });
    return;
  }

  window.setTimeout(task, 200);
}
