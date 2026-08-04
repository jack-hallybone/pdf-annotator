![PDF Annotator - free, client-side PDF viewer and annotation tool](./src/browserapp/assets/og-image.png)

A lightweight client-side PDF viewer and annotation tool built with React,
PDF.js, pdf-lib and [Lucide icons](https://lucide.dev/).

[Try out the web version](https://jack-hallybone.github.io/pdf-annotator/) :rocket:

The whole project has been written by Codex and Claude :sparkles:

## What it does

Opens local PDFs, displays them crisply, and saves interoperable annotations
back into the file: text highlights, freehand ink, freehand highlights, text
annotations, sticky notes and image stamps. Annotations from other tools are
preserved and shown read-only.

It also does page add/delete/rotate/merge, blank/lined/Cornell templates,
printing, Save, Save As and Download copy.

## Privacy

Nothing is uploaded — not PDFs, filenames, annotations or passwords. There is
no backend. File handles cover only the files you pick and live in memory for
the session.

Saves go through the File System Access write stream: serialised across app
windows, checked for external changes first, and verified byte-for-byte
afterwards. PDF scripting and XFA are disabled, the offline cache holds only
static app assets, and links inside a PDF are confirmed before opening.

## Browser support and limits

- Chrome and Edge get the full open-in-place and Save/Save As flow via the File
  System Access API. Other modern browsers fall back to a file input and
  Download copy.
- A PDF must be ≤128 MiB with a header in its first 1 KiB. Imported PNG/JPEG/
  WebP images are capped at 32 MiB and 40 megapixels, then downsampled.
- Password-protected PDFs open read-only and cannot be exported.
  Signed/certified and PDF/A files open read-only too; editing a copy
  deliberately strips the now-invalid signature fields and PDF/A claims.
- Form fields and signature stamps are **displayed** as the document defines
  them, so a page looks the same here as in any other viewer — but they are
  painted as flat appearance streams, never built as HTML controls, so they
  cannot be focused, filled in, or run a script. Interactive forms, XFA and
  embedded PDF JavaScript are not supported or executed.
- Free text uses the built-in Helvetica/WinAnsi font; unsupported characters
  are reported before a save rather than silently corrupting the output.
- Rendering is memory-intensive. Page rendering is capped and caches are
  bounded, but very large or image-heavy documents can still strain the tab.

## Security model

A local, client-only app — not a sandbox for hostile PDFs. PDF scripting, XFA
and eval-backed PDF.js paths are off; links are allowlisted and confirmed;
production ships a restrictive CSP; the service worker refuses PDF, source-map,
environment and fixture files. Serve the production build over HTTPS or
localhost so the local-file APIs work as intended, and keep dependencies
current.

The latest review and its validation record are in
[`AUDIT-REPORT.md`](./AUDIT-REPORT.md).

## Development

Requires Node.js 20.19+, 22.13+ or 24+ (exact ranges in `package.json`).

```bash
npm ci
npm run dev          # http://127.0.0.1:5173/  (or: docker compose up)
```

Before submitting a change:

```bash
npm run lint
npx tsc -b
npm test
npm run build
npm run security:audit
```

The browser smoke tests need Playwright Chromium:

```bash
npx playwright install chromium
npm run test:e2e
```

Generated output lives in the ignored `out/renderer`; dependency-derived
renderer assets are staged in the ignored `.generated`. The service worker is
built at deploy time by `scripts/generate-service-worker.mjs` and is not a
source file.

`CLAUDE.md` documents the invariants and traps for anyone — human or model —
changing this code. `tests/fixtures/README.md` covers the test fixtures.

## Project layers

- `src/workspace` — reusable single-PDF workspace (`PdfWorkspace`). Owns
  rendering, annotation editing and all PDF mutation.
- `src/tabbedapp` — reusable multi-PDF tab shell (`TabbedPdfShell`). Owns tab
  lifecycle.
- `src/browserapp` — the browser/GitHub Pages host. Owns file access, the
  service worker and the PWA.

Capabilities flow upward: a button appears only when the host supplies the
matching callback or target (`printTarget`, `pickImageFile`, `saveAsTarget`,
`downloadTarget`…). Props and handles for both reusable layers are typed in
`src/workspace/host.ts` and `src/tabbedapp/`.

One caveat worth knowing if you embed `PdfWorkspace`:
`captureSessionForTabCache()` returns a `SensitivePdfWorkspaceSession` holding
full PDF bytes, annotation state, undo/redo history and save targets. It is for
short-lived in-memory tab offloading only — never log it, send it anywhere, or
persist it.

## Installing as an app

The production build is an installable PWA with offline app assets. Installed
Chrome and Edge desktop apps register as a PDF file handler, so opening a PDF
launches the app or adds a tab to the existing window. User PDF contents are
never placed in the offline cache.

SVG favicons follow light/dark mode; installed and Apple touch icons are
solid-background PNGs, because launchers don't reliably support
colour-scheme-specific app icons.

## Licence

**No licence is granted for this repository yet — all rights are reserved.**
The source is published so it can be read and audited, not under open-source
terms, so there is no permission to use, copy, modify or redistribute it. If
you want to use any of it, open an issue and ask. Adding a `LICENSE` file is
the one step that changes this.

Third-party components keep their own licences, retained in the repository and
in the built output:

- [Lucide](https://lucide.dev/) icons — ISC, see
  [`LUCIDE-LICENSE.txt`](./src/browserapp/assets/LUCIDE-LICENSE.txt).
- PDF.js ships its own `LICENSE` and per-asset licences under `pdfjs/`.
- Dependencies are listed in `package.json`.

All test fixtures were created for this repository; provenance notes are in
[`tests/fixtures/README.md`](./tests/fixtures/README.md).
