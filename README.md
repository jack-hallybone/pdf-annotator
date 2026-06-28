<img src="./src/browserapp/assets/title.svg" alt="PDF Annotator" width="400">

A lightweight client-side PDF viewer and annotation tool built with React, PDF.js, pdf-lib and [Lucide icons](https://lucide.dev/).

[Try out the web version](https://jack-hallybone.github.io/pdf-annotator/) :rocket:

The whole project, except this first section of the readme, has been written by Codex :sparkles:

## What It Does

PDF Annotator opens local PDFs, displays them crisply, and saves interoperable annotations back into the PDF. Editable annotations include text highlights, freehand ink, freehand highlights, text annotations, sticky notes and image stamps. Other annotation types from external tools are preserved and shown read-only where PDF.js can render them.

It also supports page add/delete/rotate/merge, blank/lined/Cornell templates, printing, Save, Save As and Download copy.

## Privacy

The app is client-side. This project does not upload PDFs, filenames, annotations or passwords. Browser file handles are limited to user-selected files and kept in memory for the current session. Saves use the browser File System Access write stream, are serialised across app windows, checked for external changes and verified byte-for-byte after saving. PDF scripting and XFA are disabled, the offline cache contains only static app assets, and external PDF links are confirmed before opening.

## Development

```powershell
docker compose up
```

Open `http://127.0.0.1:5173/`.

The Docker dev container installs dependencies only when `package.json` or `package-lock.json` changes.
Run `docker compose exec app npm test` for the protected-file and annotation round-trip fixture tests.

Generated files are kept under the ignored `out/renderer` directory.
Dependency-derived renderer assets are staged under the ignored `.generated` directory.

## Browser PWA

The production browser build is an installable PWA with offline app assets. Installed Chrome and Edge desktop apps can register as a PDF file handler: opening a PDF launches the app or adds it to the existing window as a new internal tab. Other browsers retain the normal Open and drag-and-drop flows. User PDF contents are never placed in the offline cache.

The service worker is generated at build time as `out/renderer/sw.js` by `scripts/generate-service-worker.mjs`; it is not kept as a source file.

SVG favicons adapt to light/dark mode. Installed PWA and Apple touch icons are solid-background PNGs because desktop and mobile launchers do not reliably support colour-scheme-specific app icons.

## Project Layers

- `src/annotator`: reusable single-PDF workspace component.
- `src/tabbedapp`: reusable multi-PDF tab shell.
- `src/browserapp`: browser/GitHub Pages host wiring.

The reusable layers expose capabilities upward. `PdfWorkspace` owns PDF rendering, annotation editing and PDF mutation. `TabbedPdfShell` owns tab lifecycle and passes host capabilities through. `browserapp` owns browser/PWA file access. A button appears only when the host supplies the matching callback or target, for example `printTarget`, `pickMergePdfFile`, `pickImageFile`, `saveAsTarget` or `downloadTarget`.

## `PdfWorkspace`

Use this when a host app already owns document selection and wants one PDF viewer/editor.

```tsx
import { PdfWorkspace, readPdfFile } from './annotator';

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

- `confirmDiscardChanges`, `initialSession`
- `onOpenExternalLink`
- `pickImageFile`, `pickMergePdfFile`, `printTarget`
- `allowEditing`, `readOnlyMessage`, `allowImageAnnotations`, `showCloseButton`
- `theme`, `className`, `style`

Save and download capabilities live on `source`: `saveTarget`, `saveAsTarget`, `downloadTarget`.

The ref exposes `save()`, `saveAs()`, `downloadCopy()`, `print()`, `releaseRenderResources()` and `captureSessionForTabCache()`.

`captureSessionForTabCache()` is for short-lived in-memory tab offloading only. It contains full PDF bytes and annotation state, so host apps should not log it, send it over a network, or persist it to browser storage.

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
- `enableCloseTabShortcut`, `newTabMenuActions`, `theme`

`fileAdapter` can provide:

- `pickPdfDocuments`
- `pdfDocumentsFromDrop`, `pdfDocumentsFromFileInput`, `fileInput`
- `pickImageFile`, `pickMergePdfFile`
- `saveAsTarget`, `downloadTarget`, `printTarget`

The ref exposes `openDocument()`, `openDocuments()`, `openSource()`, `focusHome()`, `getDocuments()`, `closeAllDocuments()` and `confirmWindowClose()`.

Individual `PdfHostDocument` values can set `readOnly` and `readOnlyMessage` without changing other tabs.
