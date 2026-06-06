<img src="./public/title.svg" alt="PDF Annotator" width="400">

A lightweight, local-first PDF reader and annotator built with PDF.js, pdf-lib and React.

----

The idea is to create a lightweight and fast tool using [PDF.js](https://mozilla.github.io/pdf.js/) and [pdf-lib](https://pdf-lib.js.org/) for reading PDFs, and making highlight and freehand annotations.

It also includes some basic document management operations: add blank page, delete page and merge.

Local files can be opened, edited and modifications saved back to the original file or downloaded as a copy.

[Try it out](https://jackhallybone.github.io/pdf-annotator/)

*All the code in the repo except what is above here has been written by [Codex](https://openai.com/codex/).*


## What It Does

PDF Annotator opens local PDFs, displays them crisply, and saves interoperable annotations back into the PDF. It supports text highlights, freehand ink, freehand highlights, text notes, sticky notes, page add/delete/merge/rotate, printing, Save/Save As, and downloading a copy.

Supported annotations are imported as editable where possible. Other annotations from external PDF tools are shown as read-only annotation content and preserved on save unless the user edits supported annotations on that page.

## Privacy

The app runs client-side. PDF bytes, filenames, annotations and passwords are not uploaded by this app. Browser file handles are scoped to the user-selected file, kept in memory for the current session, and save writes are verified after writing. External PDF links use the app confirmation flow before opening.

## Development

```powershell
docker compose up
```

Open `http://127.0.0.1:5173/`.

Useful commands inside the container:

```powershell
docker compose exec app npm run build
docker compose exec app npm run security:audit
```

## Reusable Components

This repo has two reusable layers:

- `src/annotator`: `PdfWorkspace`, a single-PDF viewer/editor component.
- `src/tabbedapp`: `TabbedPdfShell`, a multi-document tab shell that hosts `PdfWorkspace`.

`src/browserapp` is the GitHub Pages/browser integration. It wires the reusable shell to browser file picking, drag/drop, templates and the landing page.

### PdfWorkspace

Use `PdfWorkspace` when another app already owns document selection and only needs one PDF workspace.

```tsx
import { useState } from 'react';
import { PdfWorkspace, readPdfFile } from './annotator';
import type { PdfWorkspaceSource } from './annotator';

export function PdfView() {
  const [source, setSource] = useState<PdfWorkspaceSource | null>(null);

  async function openFile(file: File) {
    setSource({
      bytes: await readPdfFile(file),
      name: file.name,
      sourceId: file.name
    });
  }

  return source ? (
    <PdfWorkspace
      source={source}
      onClose={() => setSource(null)}
      onOpenExternalLink={(url) =>
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    />
  ) : (
    <input
      accept="application/pdf"
      type="file"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void openFile(file);
      }}
    />
  );
}
```

Key props:

- `source`: PDF bytes or a loader, with `name` and optional save/download targets.
- `onClose`: called when the workspace close button is pressed.
- `confirmDiscardChanges`: host-provided unsaved-close confirmation.
- `onOpenExternalLink`: host-provided external link opener.
- `initialSession` / `onSessionChange`: restore and observe workspace state.
- `showCloseButton`, `className`, `style`: integration and layout controls.

The component ref exposes document commands for host shells: `save()`, `saveAs()`, `downloadCopy()`, `print()`, `snapshot()` and `releaseRenderResources()`.

Override component styling with CSS variables:

```css
.pdf-annotator {
  --pdfa-bg: #f3f3f3;
  --pdfa-ui: #ffffff;
  --pdfa-ink: #171c1c;
  --pdfa-accent: #cc41bf;
}
```

### TabbedPdfShell

Use `TabbedPdfShell` when an app needs Chrome-style PDF tabs and workspace lifecycle handling.

```tsx
import { useRef } from 'react';
import { TabbedPdfShell } from './tabbedapp';
import type { TabbedPdfShellHandle } from './tabbedapp';

const shellRef = useRef<TabbedPdfShellHandle>(null);

<TabbedPdfShell
  ref={shellRef}
  fileAdapter={myFileAdapter}
  renderHome={({ openPdfDocuments, templateActions }) => (
    <HomePage
      onOpen={openPdfDocuments}
      templateActions={templateActions}
    />
  )}
  workspaceOptions={{ onOpenExternalLink: openInHostBrowser }}
/>;

shellRef.current?.openSource({
  kind: 'loader',
  loadBytes: () => loadPdfBytes(),
  name: 'paper.pdf'
});

const canCloseWindow = await shellRef.current?.closeAllDocuments();
```

Key props:

- `fileAdapter`: host file picking, drag/drop, Save As and download behavior.
- `renderHome`: optional home tab renderer supplied by the host app.
- `workspaceOptions`: selected `PdfWorkspace` options passed to each tab.
- `confirmCloseDocuments`: optional host override for dirty-tab confirmation; otherwise the shell shows its built-in modal.
- `initialDocuments` / `onDocumentsChange`: restore and observe open tabs.

Tabbed hosts should snapshot hidden workspaces and call `releaseRenderResources()` so inactive tabs keep unsaved edits without keeping PDF.js render resources alive. Desktop wrappers can call `closeAllDocuments()` during native window close; it shows the shell's dirty-close modal and resolves `false` if the user cancels. The built-in tab menu routes active-tab Save, Save As, Download copy and Print commands through the mounted `PdfWorkspace`.
