<img src="./public/title.svg" alt="PDF Annotator" width="400">

A lightweight client-side PDF viewer and annotation tool.

*All the code has been written by [Codex](https://openai.com/codex/).*

----

The idea is to create a lightweight and fast tool using [PDF.js](https://mozilla.github.io/pdf.js/) and [pdf-lib](https://pdf-lib.js.org/) for reading PDFs, and making highlight and freehand annotations.

It also includes some basic document management operations: add blank page, delete page and merge.

Local files can be opened, edited and modifications saved back to the original file or downloaded as a copy.

[Try it out](https://jackhallybone.github.io/pdf-annotator/)

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
    <PdfWorkspace source={source} onClose={() => setSource(null)} />
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

Style it by overriding CSS variables and, if needed, passing `className`/`style` to control size.

```css
.pdf-annotator {
  --pdfa-bg: #f3f3f3;
  --pdfa-ui: #ffffff;
  --pdfa-ink: #171c1c;
  --pdfa-accent: #cc41bf;
}
```
