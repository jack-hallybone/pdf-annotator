// main.tsx imports this module, so it must not import PDF.js code: `?url`
// resolves to a build-time string and keeps the library out of the initial
// chunk.
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

export { pdfWorkerUrl };

// PDF.js appends filenames to this base, so those files cannot carry a content
// hash of their own: the digest is in the directory name, written by
// scripts/prepare-renderer-assets.mjs.
declare const __PDFJS_ASSET_DIR__: string;

// The name the build substitutes; the fallback is for `node --test` only.
const PDFJS_ASSET_DIR: string =
  typeof __PDFJS_ASSET_DIR__ === "string" ? __PDFJS_ASSET_DIR__ : "pdfjs";

export const pdfjsAssetBase = (): string =>
  `${import.meta.env?.BASE_URL ?? "/"}${PDFJS_ASSET_DIR}/`;

const preloadedLinks = new Set<string>();

// Anything added here must check both the preload credentials mode and whether
// the service worker already precaches the file, or it fetches the same bytes
// twice on every cold load.
export function warmPdfRuntimeCaches() {
  preloadModule(pdfWorkerUrl);
}

function preloadModule(href: string) {
  appendPreloadLink(`module:${href}`, (link) => {
    link.href = href;
    link.rel = "modulepreload";
  });
}

function appendPreloadLink(
  key: string,
  configure: (link: HTMLLinkElement) => void,
) {
  if (preloadedLinks.has(key)) {
    return;
  }

  const link = document.createElement("link");
  configure(link);
  document.head.append(link);
  preloadedLinks.add(key);
}
