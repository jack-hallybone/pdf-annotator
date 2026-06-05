<img src="./public/title.svg" alt="PDF Annotator" width="400">

A lightweight client-side PDF viewer and annotation tool.

*All the code has been written by [Codex](https://openai.com/codex/).*

----

The idea is to create a lightweight and fast tool using [PDF.js](https://mozilla.github.io/pdf.js/) and [pdf-lib](https://pdf-lib.js.org/) for reading PDFs, and making highlight and freehand annotations.

It also includes some basic document management operations: add blank page, delete page and merge.

Local files can be opened, edited and modifications saved back to the original file or downloaded as a copy.

[Try it out](https://jackhallybone.github.io/pdf-annotator/)

## Privacy and security model

The app is client-side. PDF bytes, annotations and generated files are processed in the browser with PDF.js, pdf-lib, React and local application code; the app does not upload documents, annotations or filenames to a server.

Runtime network use is intentionally narrow:

- The app fetches its own same-origin static assets, including the PDF.js worker and optional PDF.js WASM assets.
- Development mode uses Vite's local websocket for hot reload.
- External PDF links are opened only after the app's link confirmation flow.

Browser file access uses the File System Access API where available. A writable handle is granted by the browser for the selected file only, is held in memory for the current app session, and JavaScript does not receive the user's full filesystem path. Direct Save and Save As writes are verified by reading the saved handle back and byte-comparing the result. Download a copy uses the browser download flow and does not grant a writable handle.

Password-protected PDFs are unlocked inside the annotator component. Passwords are passed directly to PDF.js, the input is cleared immediately, and this app does not store them in React/app state or persistent browser storage.

Imported editable annotations are tracked by workspace-local IDs plus PDF source identifiers derived from object refs, `/NM`, geometry and page/index fallback data. Page edits remap annotation page indexes, and saves remove/replace only supported annotations on managed pages or with matching source identifiers. Unsupported or flattened annotations remain part of the original PDF content/metadata unless the user edits supported annotations on that page.

Local dev/preview responses include security headers from `vite.config.ts`. The production GitHub Pages build also injects a CSP `<meta>` tag, because GitHub Pages does not support custom response headers. A future desktop wrapper should enforce equivalent CSP/security policy in the wrapper configuration and open external links through the host browser.

## Use the component

Import the reusable annotator from `src/annotator`. It owns its default CSS; pass PDF bytes in a `source`.

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
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void openFile(file);
      }}
      type="file"
    />
  );
}
```

For a PDF already hosted by your site, fetch it and set `bytes: new Uint8Array(await response.arrayBuffer())`.

Required props:

- `source`: a `PdfWorkspaceSource` containing PDF bytes or a loader.
- `onClose`: called when the workspace close button is pressed.

Optional props:

- `className`, `style`: size and style the workspace host element.
- `confirmDiscardChanges(session)`: provide an unsaved-close confirmation. If omitted, unsaved closes are blocked.
- `enableGlobalShortcuts`: enable `Ctrl+S`, undo/redo, zoom shortcuts. Defaults to `true`.
- `enableWheelZoom`: enable `Ctrl+wheel` zoom. Defaults to `true`.
- `initialSession`: restore a previous `PdfWorkspaceSession`.
- `manageDocumentTitle`: let the component update `document.title`. Defaults to `true`.
- `onDirtyChange(isDirty)`: observe unsaved-change state.
- `onDocumentTitleChange(title)`: observe the current document title.
- `onOpenExternalLink(url, context)`: open confirmed external PDF links. If omitted, links open in a new browser tab.
- `onSessionChange(session)`: observe the current workspace session.
- `showCloseButton`: show the workspace close button. Defaults to `true`.

`source` can be:

- `{ bytes, name, sourceId }` for already-loaded PDF bytes.
- `{ kind: 'loader', loadBytes, name, sourceId }` to let the workspace show its loading UI while bytes are fetched.
- Either source may include `saveTarget.save(bytes)` to write back to the original file, and `saveAsTarget.saveAs(bytes, suggestedName)` for explicit Save As behavior.
- Either source may include `initialAnnotations` to open a generated PDF with editable unsaved annotations already on the page.

Style it by overriding CSS variables and, if needed, passing `className`/`style` to control size.

```css
.pdf-annotator {
  --pdfa-bg: #f3f3f3;
  --pdfa-ui: #ffffff;
  --pdfa-ink: #171c1c;
  --pdfa-accent: #cc41bf;
}
```

## Reusable pieces

The code is split into reusable layers:

- `src/annotator`: single-PDF viewer/editor component. It does not know how the host opens files.
- `src/tabbedapp`: reusable multi-PDF tab shell. It owns tabs, snapshots, dirty state and resource cleanup.
- `src/browserapp`: browser/GitHub Pages host. It provides file-system access and the branded home page.

Browser apps can use the default external-link opener. Desktop hosts should pass `onOpenExternalLink` and open confirmed links through the system browser.

Import `TabbedPdfShell` from `src/tabbedapp` and provide a `PdfHostAdapter`. Browser-only file picker and drag/drop code lives in `src/browserapp`; it is not part of the reusable tabbed shell.

```tsx
const shellRef = useRef<TabbedPdfShellHandle>(null);

<TabbedPdfShell
  fileAdapter={myFileAdapter}
  ref={shellRef}
  workspaceOptions={{ onOpenExternalLink: openInHostBrowser }}
/>

shellRef.current?.openDocument({
  fileKey: referenceItem.id,
  source: {
    kind: 'loader',
    loadBytes: () => loadPdfBytesForReference(referenceItem),
    name: referenceItem.pdfName
  }
});
```

The shell also accepts `initialDocuments`, `onDocumentsChange`, `confirmCloseDocuments`, and `renderHome`. The default home tab is intentionally blank; host apps can pass `renderHome` to provide a library, dashboard or landing page inside the home tab. The browser app uses this to supply the current Open PDFs/Create PDF home screen.

## Workspace lifecycle

Desktop-style hosts should keep one workspace mounted for the active tab. Before hiding a tab, call `snapshot()` from the component ref and store the returned `PdfWorkspaceSession`. After hiding it, call `releaseRenderResources()` to discard PDF.js canvases/pages. When showing that tab again, pass the saved session back as `initialSession`.

Ref methods:

- `snapshot()`: returns the current `PdfWorkspaceSession`, or `null` if no PDF is loaded.
- `releaseRenderResources()`: releases PDF.js render resources for a hidden workspace.
