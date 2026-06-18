<img src="./public/title.svg" alt="PDF Annotator" width="400">

A lightweight client-side PDF viewer and annotation tool built with React, PDF.js, pdf-lib, [Lucide icons](https://lucide.dev/) and Electron.

[Try out the web version](https://jackhallybone.github.io/pdf-annotator/) :rocket:

The whole project, except this first section of the readme, has been written by Codex :sparkles:

## What It Does

PDF Annotator opens local PDFs, displays them crisply, and saves interoperable annotations back into the PDF. Editable annotations include text highlights, freehand ink, freehand highlights, text annotations, sticky notes and image stamps. Other annotation types from external tools are preserved and shown read-only where PDF.js can render them.

It also supports page add/delete/rotate/merge, blank/lined/Cornell templates, printing, Save, Save As and Download copy.

## Privacy

The app is client-side. This project does not upload PDFs, filenames, annotations or passwords. Browser file handles are limited to user-selected files, kept in memory for the current session, and writes are verified after saving. External PDF links are confirmed before opening.

## Development

```powershell
docker compose up
```

Open `http://127.0.0.1:5173/`.

The Docker dev container installs dependencies only when `package.json` or `package-lock.json` changes.

## Project Layers

- `src/annotator`: reusable single-PDF workspace component.
- `src/tabbedapp`: reusable multi-PDF tab shell.
- `src/browserapp`: browser/GitHub Pages host wiring.
- `src/electronapp`: Electron host wiring.

The reusable layers expose capabilities upward. A button appears only when the host supplies the matching callback or target, for example `printTarget`, `pickMergePdfFile`, `pickImageFile`, `saveAsTarget` or `downloadTarget`.

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

- `confirmDiscardChanges`, `initialSession`, `onSessionChange`
- `onOpenExternalLink`
- `pickImageFile`, `pickMergePdfFile`, `printTarget`
- `allowEditing`, `allowImageAnnotations`, `showCloseButton`
- `theme`, `className`, `style`

Save and download capabilities live on `source`: `saveTarget`, `saveAsTarget`, `downloadTarget`.

The ref exposes `save()`, `saveAs()`, `downloadCopy()`, `print()`, `snapshot()` and `releaseRenderResources()`.

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

## Desktop

Electron reuses `TabbedPdfShell` and provides native file dialogs, verified save/write operations, external-link opening and window-close confirmation through a sandboxed preload bridge.

```powershell
docker compose exec app npm run desktop:build
docker compose exec app npm run desktop:package:win
docker compose exec app npm run desktop:package:win:installer
```

The renderer has Node integration disabled, context isolation enabled, sandboxing enabled, and no direct filesystem paths exposed to React.
