// One precache description, read by vite-plugin-pwa and by the build suite.
import { fileURLToPath } from "node:url";

export const OUT_DIR = fileURLToPath(new URL("../dist", import.meta.url));

// PDF.js composes each cmap, font, ICC and wasm URL by appending a filename to
// a base, so those files cannot carry a content hash; the digest is in the
// directory name instead.
export const PDFJS_DIR = /^pdfjs-[0-9a-f]{12}$/;

export const PRECACHE = {
  globDirectory: OUT_DIR,
  // An allowlist by shape, never a glob over the output: a list that absorbs
  // whatever the build emitted is how a source map reaches an offline cache.
  globPatterns: [
    "index.html",
    "assets/**/*-*.{js,mjs,css,svg,ico,png,md}",
    "pdfjs-*/LICENSE",
    "pdfjs-*/cmaps/{LICENSE,*.bcmap}",
    "pdfjs-*/iccs/{LICENSE,*.icc}",
    "pdfjs-*/standard_fonts/{LICENSE_*,*.pfb,*.ttf}",
    "pdfjs-*/wasm/{LICENSE_*,*.js,*.wasm}",
  ],
  // Naming the two shapes whose path is already an identity is what makes
  // `revision` null, and an entry carrying a `revision` is cached under
  // `<url>?__WB_REVISION__=<rev>` while the install request goes to the bare
  // url, so a host that ignores the query files a fresh key against a previous
  // deployment's bytes.
  dontCacheBustURLsMatching:
    /(?:-[A-Za-z0-9_-]{8,}\.[a-z0-9]+|^pdfjs-[0-9a-f]{12}\/.+)$/u,
  // Raised because Workbox's 2 MiB default drops the 2.33 MB PDF.js worker from
  // the manifest with a warning rather than an error.
  maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
};

// The one entry whose name is fixed: a navigation resolves to it.
export const PAGES = ["index.html"];
