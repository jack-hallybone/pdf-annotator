import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFHexString, PDFName, PDFRef } from "pdf-lib";
import { ANNOTATION_BOOKMARK_KEY } from "../src/pdfdocumenteditor/annotationBookmarkKey";
import { writePdfAnnotations } from "../src/pdfdocumenteditor/pdfWriter";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";

// A bookmark is a flag in a private key, which pdf.js never reports, so it has
// to be read back out of the raw document.

// annotationImport reaches PDF.js's browser entry, which touches these while the
// module is evaluated even though nothing here renders to a canvas.
installPdfJsGlobals();
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { importExistingAnnotationsForPage } =
  await import("../src/pdfdocumenteditor/annotationImport");

async function blankPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]);
  return pdfDoc.save({ useObjectStreams: false });
}

// Everything this app writes is registered as an indirect object, so a round
// trip starting at writePdfAnnotations never reaches a direct dictionary in
// /Annots.
async function pdfWithDirectHighlight({ starred }: { starred: boolean }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  page.drawText("Alpha Bravo Charlie", { size: 16, x: 72, y: 706 });
  page.node.set(
    PDFName.of("Annots"),
    pdfDoc.context.obj([
      pdfDoc.context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: [72, 702, 300, 722],
        QuadPoints: [72, 722, 300, 722, 72, 702, 300, 702],
        C: [1, 0.9, 0.2],
        CA: 0.4,
        F: 4,
        ...(starred ? { [ANNOTATION_BOOKMARK_KEY]: true } : {}),
      }),
    ]),
  );
  return pdfDoc.save({ useObjectStreams: false });
}

async function annotsStorageShapes(bytes: Uint8Array) {
  const pdfDoc = await PDFDocument.load(bytes);
  const annots = pdfDoc.getPage(0).node.Annots();
  assert.ok(annots, "expected the page to still have annotations");
  return Array.from({ length: annots.size() }, (_, index) =>
    annots.get(index) instanceof PDFRef ? "reference" : "direct",
  );
}

function starredHighlight(bookmarked: boolean, comment = ""): PdfAnnotation {
  return {
    bookmarked: bookmarked || undefined,
    color: [1, 0.9, 0.2],
    comment,
    id: "starred-highlight",
    kind: "textHighlight",
    opacity: 0.4,
    pageIndex: 0,
    quadPoints: [[72, 720, 180, 720, 72, 704, 180, 704]],
    rects: [{ x1: 72, x2: 180, y1: 704, y2: 720 }],
  };
}

async function reimport(bytes: Uint8Array) {
  const options = {
    data: bytes.slice(),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  };
  const loadingTask = getDocument(options);
  try {
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(1);
    return (await importExistingAnnotationsForPage(page, 0, bytes)).annotations;
  } finally {
    await loadingTask.destroy();
  }
}

test("a starred annotation is still starred after a save and reload", async () => {
  const saved = await writePdfAnnotations(await blankPdf(), [
    starredHighlight(true, "worth another look"),
  ]);

  const [reloaded] = await reimport(saved);
  assert.ok(reloaded && reloaded.kind === "textHighlight");
  assert.equal(reloaded.bookmarked, true);
  assert.equal(reloaded.comment, "worth another look");

  const resaved = await writePdfAnnotations(
    saved,
    [{ ...reloaded, comment: "still here" }],
    {
      replaceAnnotationSourceIds: [reloaded.sourceId!],
      replacePageIndexes: [0],
    },
  );
  const [twiceReloaded] = await reimport(resaved);
  assert.ok(twiceReloaded && twiceReloaded.kind === "textHighlight");
  assert.equal(twiceReloaded.bookmarked, true);
  assert.equal(twiceReloaded.comment, "still here");
});

test("a star on a directly-stored annotation dictionary is read back", async () => {
  const bytes = await pdfWithDirectHighlight({ starred: true });
  assert.deepEqual(await annotsStorageShapes(bytes), ["direct"]);

  const [reloaded] = await reimport(bytes);
  assert.ok(reloaded && reloaded.kind === "textHighlight");
  assert.equal(reloaded.bookmarked, true);
});

test("starring a directly-stored annotation survives a save and reload", async () => {
  const original = await pdfWithDirectHighlight({ starred: false });
  const [imported] = await reimport(original);
  assert.ok(imported);
  assert.equal(imported.bookmarked, undefined);

  const starred = await writePdfAnnotations(
    original,
    [{ ...imported, bookmarked: true as const }],
    {
      replaceAnnotationSourceIds: [imported.sourceId!],
      replacePageIndexes: [0],
    },
  );
  assert.deepEqual(await annotsStorageShapes(starred), ["direct"]);

  const [reloaded] = await reimport(starred);
  assert.ok(reloaded);
  assert.equal(reloaded.bookmarked, true);

  const cleared = await writePdfAnnotations(
    starred,
    [{ ...reloaded, bookmarked: undefined }],
    {
      replaceAnnotationSourceIds: [reloaded.sourceId!],
      replacePageIndexes: [0],
    },
  );
  const [unstarred] = await reimport(cleared);
  assert.ok(unstarred);
  assert.equal(unstarred.bookmarked, undefined);
});

// pdf.js reports a /Text annotation's rectangle as a fixed icon box anchored to
// the stored rectangle's top-left corner, so the confirmation has to reduce both
// sides the same way rather than comparing the raw numbers.
test("a star on a directly-stored sticky note is read back", async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  page.node.set(
    PDFName.of("Annots"),
    pdfDoc.context.obj([
      pdfDoc.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [72, 72, 92, 92],
        Contents: PDFHexString.fromText("a third-party note"),
        C: [1, 0.9, 0.2],
        [ANNOTATION_BOOKMARK_KEY]: true,
      }),
    ]),
  );
  const bytes = await pdfDoc.save({ useObjectStreams: false });
  assert.deepEqual(await annotsStorageShapes(bytes), ["direct"]);

  const [reloaded] = await reimport(bytes);
  assert.ok(reloaded && reloaded.kind === "stickyNote");
  assert.equal(reloaded.sourceId, "direct:0:0");
  assert.equal(reloaded.bookmarked, true);
});

// A direct dictionary is found by its position in /Annots, and pdf.js's array is
// not always that array, because it drops what it cannot display.
test("a star is not read off the neighbour when pdf.js's array is shifted", async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const highlight = (
    rect: number[],
    flags: number,
    extra: Record<string, unknown> = {},
  ) =>
    pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Highlight",
      Rect: rect,
      QuadPoints: [
        rect[0],
        rect[3],
        rect[2],
        rect[3],
        rect[0],
        rect[1],
        rect[2],
        rect[1],
      ],
      C: [1, 0.9, 0.2],
      CA: 0.4,
      F: flags,
      ...extra,
    });
  page.node.set(
    PDFName.of("Annots"),
    pdfDoc.context.obj([
      highlight([72, 702, 300, 722], 32, { [ANNOTATION_BOOKMARK_KEY]: true }),
      highlight([72, 602, 300, 622], 4),
    ]),
  );
  const bytes = await pdfDoc.save({ useObjectStreams: false });

  const imported = await reimport(bytes);
  assert.equal(
    imported.length,
    1,
    "expected pdf.js to report only the visible annotation",
  );
  assert.equal(imported[0].bookmarked, undefined);
});

test("an unstarred annotation does not come back starred", async () => {
  const saved = await writePdfAnnotations(await blankPdf(), [
    starredHighlight(false),
  ]);

  const [reloaded] = await reimport(saved);
  assert.ok(reloaded && reloaded.kind === "textHighlight");
  assert.equal(reloaded.bookmarked, undefined);
});

test("a comment mentioning highlighting does not turn a pen stroke into a highlighter", async () => {
  const pen: PdfAnnotation = {
    color: [0.1, 0.2, 0.8],
    comment: "highlight the next paragraph too",
    id: "pen-with-comment",
    kind: "draw",
    opacity: 1,
    pageIndex: 0,
    paths: [
      [
        { x: 100, y: 100 },
        { x: 200, y: 160 },
        { x: 300, y: 120 },
      ],
    ],
    width: 2,
  };

  const saved = await writePdfAnnotations(await blankPdf(), [pen]);
  const [reloaded] = await reimport(saved);

  assert.ok(reloaded);
  assert.equal(reloaded.kind, "draw");
});

test("the text a highlight covers is recovered from the page, not from /Contents", async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  page.drawText("Alpha Bravo Charlie", { size: 16, x: 72, y: 706 });
  const withText = await pdfDoc.save({ useObjectStreams: false });

  const saved = await writePdfAnnotations(withText, [
    {
      color: [1, 0.9, 0.2],
      comment: "",
      id: "covering-highlight",
      kind: "textHighlight",
      opacity: 0.4,
      pageIndex: 0,
      quadPoints: [[72, 722, 300, 722, 72, 702, 300, 702]],
      rects: [{ x1: 72, x2: 300, y1: 702, y2: 722 }],
    },
  ]);

  const [reloaded] = await reimport(saved);
  assert.ok(reloaded && reloaded.kind === "textHighlight");
  assert.equal(reloaded.comment, "");
  assert.match(reloaded.coveredText ?? "", /Alpha/);
});

function installPdfJsGlobals() {
  class FakeDOMMatrix {}
  class FakeImageData {}
  class FakePath2D {}
  const globals = globalThis as {
    DOMMatrix?: unknown;
    ImageData?: unknown;
    Path2D?: unknown;
  };
  globals.DOMMatrix ??= FakeDOMMatrix;
  globals.ImageData ??= FakeImageData;
  globals.Path2D ??= FakePath2D;
}
