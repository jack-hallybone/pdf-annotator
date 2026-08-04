![PDF Annotator - free, client-side PDF viewer and annotation tool](./src/browserapp/assets/og-image.png)

A lightweight client-side PDF viewer and annotation tool built with React, PDF.js, pdf-lib and [Lucide icons](https://lucide.dev/).

[Try out the web version](https://jack-hallybone.github.io/pdf-annotator/) :rocket:

The whole project has been written by Codex and Claude :sparkles:

## What It Does

PDF Annotator opens local PDFs, displays them crisply, and saves interoperable annotations back into the PDF. Editable annotations include text highlights, freehand ink, freehand highlights, text annotations, sticky notes and image stamps. Other annotation types from external tools are preserved and shown read-only where PDF.js can render them.

It also supports page add/delete/rotate/merge, blank/lined/Cornell templates, printing, Save, Save As and Download copy.

## Privacy

The app is client-side. This project does not upload PDFs, filenames, annotations or passwords. Browser file handles are limited to user-selected files and kept in memory for the current session. Saves use the browser File System Access write stream, are serialised across app windows, checked for external changes and verified byte-for-byte after saving. PDF scripting and XFA are disabled, the offline cache contains only static app assets, and external PDF links are confirmed before opening.

## Development

Requires Node.js 20.19+, 22.13+, or 24+ (see `package.json` for the exact supported ranges).

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/`.

The Docker workflow is also available:

```bash
docker compose up
```

The Docker dev container installs dependencies only when `package.json` or `package-lock.json` changes.

Before submitting a change, run:

```bash
npm run lint
npx tsc -b
npm test
npm run build
npm run security:audit
```

The browser smoke tests additionally require Playwright Chromium:

```bash
npx playwright install chromium
npm run test:e2e
```

Use `tests/fixtures/compatibility-checklist.md` when adding real-world PDF compatibility fixtures.

Generated files are kept under the ignored `out/renderer` directory.
Dependency-derived renderer assets are staged under the ignored `.generated` directory.

## Browser PWA

The production browser build is an installable PWA with offline app assets. Installed Chrome and Edge desktop apps can register as a PDF file handler: opening a PDF launches the app or adds it to the existing window as a new internal tab. Other browsers retain the normal Open and drag-and-drop flows. User PDF contents are never placed in the offline cache.

The service worker is generated at build time as `out/renderer/sw.js` by `scripts/generate-service-worker.mjs`; it is not kept as a source file.

SVG favicons adapt to light/dark mode. Installed PWA and Apple touch icons are solid-background PNGs because desktop and mobile launchers do not reliably support colour-scheme-specific app icons.

## Browser support and current limits

- Chrome and Edge provide the full open-in-place and Save/Save As flow through the File System Access API. Other modern browsers use the file-input and Download-copy fallbacks.
- A PDF must be no larger than 128 MiB and must contain a PDF header in its first 1 KiB. Imported PNG, JPEG and WebP images are limited to 32 MiB and 40 megapixels, then downsampled for annotation use.
- Password-protected PDFs can be unlocked for viewing but remain read-only and cannot be exported. Signed/certified and PDF/A files initially open read-only; editing a copy deliberately removes invalid signature fields and PDF/A claims.
- Form fields and signature stamps are **displayed** as the document defines them, so a page looks the same here as in other viewers, but they are never interactive: they are painted as flat appearance streams, not built as HTML controls, so they cannot be focused, filled in, or run a script. Interactive forms, XFA and embedded PDF JavaScript are not supported or executed. Other unsupported annotation kinds are likewise preserved and rendered read-only.
- Free-text appearance streams use the built-in Helvetica/WinAnsi font. The editor identifies unsupported characters before an edit is committed or saved instead of producing a corrupt or misleading PDF.
- PDF rendering and editing are memory-intensive. Page rendering is capped and page/history caches are bounded, but very large or image-heavy documents can still be constrained by the browser process.

## Security model

This is a local, client-only application, not a sandbox for arbitrary hostile PDFs. The renderer disables PDF scripting, XFA and eval-backed PDF.js paths; external links are allowlisted and require confirmation; production uses a restrictive CSP; and the service worker refuses PDF, source-map, environment and fixture files. Keep dependencies current and serve the production build over HTTPS or localhost so browser security features and local-file APIs work as intended.

The latest repository review and its validation record are in [`AUDIT-REPORT.md`](./AUDIT-REPORT.md).

## Licence

**No licence is granted for this repository yet — all rights are reserved.**
The source is published so it can be read and audited; it is not yet offered
under open-source terms, so there is no permission to use, copy, modify or
redistribute it. If you want to use any of it, open an issue and ask. Adding a
`LICENSE` file is the one step that would change this.

Third-party components keep their own licences and those files are retained in
the repository and in the built output:

- [Lucide](https://lucide.dev/) icons — ISC, see [`LUCIDE-LICENSE.txt`](./src/browserapp/assets/LUCIDE-LICENSE.txt).
- PDF.js ships its own `LICENSE` and per-asset licences under `pdfjs/` in the build.
- Runtime and build dependencies are listed in `package.json`.

All test fixtures were created for this repository; their provenance notes are
in [`tests/fixtures/README.md`](./tests/fixtures/README.md).

## Project Layers

- `src/workspace`: reusable single-PDF workspace component.
- `src/tabbedapp`: reusable multi-PDF tab shell.
- `src/browserapp`: browser/GitHub Pages host wiring.

The reusable layers expose capabilities upward. `PdfWorkspace` owns PDF rendering, annotation editing and PDF mutation. `TabbedPdfShell` owns tab lifecycle and passes host capabilities through. `browserapp` owns browser/PWA file access. A button appears only when the host supplies the matching callback or target, for example `printTarget`, `pickMergePdfFile`, `pickImageFile`, `saveAsTarget` or `downloadTarget`.

## `PdfWorkspace`

Use this when a host app already owns document selection and wants one PDF viewer/editor.

```tsx
import { PdfWorkspace, readPdfFile } from './workspace';

const bytes = await readPdfFile(file);

<PdfWorkspace
  source={{ bytes, name: file.name, sourceId: file.name }}
  onClose={() => setOpen(false)}
  onOpenExternalLink={(url) =>
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  theme={{ accent: '#cc41bf' }}
/>;
```

Required props:

- `source`: PDF bytes or a loader, plus `name` and `sourceId`.
- `onClose`: called by the workspace close button.

Useful optional props:

- `confirmDiscardChanges`, `initialSession` (`SensitivePdfWorkspaceSession`)
- `onOpenExternalLink`
- `pickImageFile`, `pickMergePdfFile`, `printTarget`
- `allowEditing`, `readOnlyMessage`, `allowImageAnnotations`, `showCloseButton`
- `theme`, `className`, `style`

Save and download capabilities live on `source`: `saveTarget`, `saveAsTarget`, `downloadTarget`.

The ref exposes `save()`, `saveAs()`, `downloadCopy()`, `print()`, `releaseRenderResources()` and `captureSessionForTabCache()`.

`captureSessionForTabCache()` returns a `SensitivePdfWorkspaceSession` for short-lived in-memory tab offloading only. It contains full PDF bytes, annotation state, undo/redo history and save targets, so host apps must not log it, send it over a network, or persist it to browser storage.

## `TabbedPdfShell`

Use this when a host app wants Chrome-style tabs around `PdfWorkspace`.

```tsx
import { TabbedPdfShell } from './tabbedapp';

<TabbedPdfShell
  fileAdapter={myFileAdapter}
  workspaceOptions={{ onOpenExternalLink: openInHostBrowser }}
/>;
```

Required props:

- `fileAdapter`: host file operations and optional capabilities.

Useful optional props:

- `renderHome`: override the built-in Open/New home tab.
- `workspaceOptions`: props passed to each `PdfWorkspace`.
- `initialDocuments`, `onDocumentsChange`
- `confirmCloseDocuments`
- `newTabMenuActions`, `theme`

`fileAdapter` can provide:

- `pickPdfDocuments`
- `pdfDocumentsFromDrop`, `pdfDocumentsFromFileInput`, `fileInput`
- `pickImageFile`, `pickMergePdfFile`
- `saveAsTarget`, `downloadTarget`, `printTarget`

The ref exposes `openDocument()`, `openDocuments()`, `openSource()`, `focusHome()`, `getDocuments()`, `closeAllDocuments()` and `confirmWindowClose()`.

Individual `PdfHostDocument` values can set `readOnly` and `readOnlyMessage` without changing other tabs.
