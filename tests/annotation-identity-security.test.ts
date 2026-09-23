import assert from "node:assert/strict";
import test from "node:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";
import {
  PdfAnnotationIntegrityError,
  writePdfAnnotations,
} from "../src/pdfdocumenteditor/pdfWriter";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import { loadTestPdf } from "./pdfTestUtils";

// annotationImport imports PDF.js's browser entry, which reads these globals
// while the module is evaluated.
installPdfJsGlobals();
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { importExistingAnnotationsForPage } =
  await import("../src/pdfdocumenteditor/annotationImport");

test("PDF.js highlight arrays and third-party metadata survive an in-place edit", async () => {
  const bytes = await buildIndirectHighlightPdf();
  const imported = await importPageAnnotations(bytes);
  const highlight = imported.find(
    (annotation) => annotation.kind === "textHighlight",
  );

  assert.ok(highlight && highlight.kind === "textHighlight");
  assert.equal(highlight.sourceId, "50R1");
  assert.equal(highlight.comment, "original highlight text");
  assert.ok(highlight.quadPoints.every((quad) => Array.isArray(quad)));
  assert.ok(
    highlight.quadPoints.every((quad) => !ArrayBuffer.isView(quad)),
    "typed arrays must not leak into serializable session state",
  );

  const edited: PdfAnnotation = {
    ...highlight,
    color: [0.2, 0.7, 0.3],
    comment: "edited highlight text",
  };
  const output = await writePdfAnnotations(bytes, [edited], {
    replaceAnnotationSourceIds: [highlight.sourceId!],
    replacePageIndexes: [0],
  });
  const pdfDoc = await loadTestPdf(output);
  const annots = pdfDoc.getPage(0).node.Annots();
  assert.ok(annots);

  const highlightEntries = annotationEntriesOfSubtype(annots, "Highlight");
  assert.equal(highlightEntries.length, 1);
  assert.ok(highlightEntries[0].entry instanceof PDFRef);
  assert.equal(highlightEntries[0].entry.toString(), "50 1 R");

  const dict = highlightEntries[0].dict;
  assert.equal(textEntry(dict, "Contents"), "edited highlight text");
  assert.equal(textEntry(dict, "NM"), "third-party-highlight");
  assert.equal(textEntry(dict, "T"), "External reviewer");
  assert.equal(textEntry(dict, "Subj"), "Review highlight");
  assert.equal(textEntry(dict, "CreationDate"), "D:20260810120000Z");
  assert.equal(textEntry(dict, "AuditTag"), "retain-me");
  assert.equal(dict.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber(), 28);
  assert.ok(dict.get(PDFName.of("Popup")) instanceof PDFRef);

  const quads = dict.lookupMaybe(PDFName.of("QuadPoints"), PDFArray);
  assert.equal(quads?.size(), 8);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) =>
      quads?.lookupMaybe(index, PDFNumber)?.asNumber(),
    ),
    [72, 720, 180, 720, 72, 704, 180, 704],
  );
});

test("a direct annotation dictionary is updated rather than duplicated", async () => {
  const bytes = await buildDirectNotePdf();
  const imported = await importPageAnnotations(bytes);
  const note = imported.find((annotation) => annotation.kind === "stickyNote");

  assert.ok(note && note.kind === "stickyNote");
  assert.equal(note.sourceId, "direct:0:0");

  const output = await writePdfAnnotations(
    bytes,
    [{ ...note, text: "edited direct note" }],
    {
      replaceAnnotationSourceIds: [note.sourceId!],
      replacePageIndexes: [0],
    },
  );
  const pdfDoc = await loadTestPdf(output);
  const annots = pdfDoc.getPage(0).node.Annots();

  assert.equal(annots?.size(), 1);
  assert.ok(annots?.get(0) instanceof PDFDict);
  assert.equal(
    textEntry(annots?.lookupMaybe(0, PDFDict), "Contents"),
    "edited direct note",
  );
});

test("ambiguous duplicate annotation names stop replacement", async () => {
  const bytes = await buildDuplicateNamedNotesPdf();

  await assert.rejects(
    () =>
      writePdfAnnotations(bytes, [], {
        replaceAnnotationSourceIds: ["duplicate-name"],
        replacePageIndexes: [0],
      }),
    (error) => error instanceof PdfAnnotationIntegrityError,
  );
});

// The position pdf.js reports for a direct dictionary can belong to a different
// annotation, and the writer identifies a direct dictionary by that position;
// the neighbour here is flagged NoView (bit 6).
test("an edit is not written to the entry ahead of it when pdf.js's array is shifted", async () => {
  const bytes = await buildShiftedAnnotsPdf({ neighbourSubtype: "Highlight" });
  const imported = await importPageAnnotations(bytes);

  assert.equal(imported.length, 1, "pdf.js reports only the visible note");
  const [note] = imported;
  assert.ok(note.kind === "stickyNote");
  assert.equal(note.sourceId, "unresolved:shifted:0:0");

  await assert.rejects(
    () =>
      writePdfAnnotations(bytes, [{ ...note, text: "edited direct note" }], {
        replaceAnnotationSourceIds: [note.sourceId!],
        replacePageIndexes: [0],
      }),
    (error) =>
      error instanceof PdfAnnotationIntegrityError &&
      /could not be located in the file/.test(error.message),
  );
});

test("a same-subtype neighbour does not confirm a shifted position", async () => {
  const bytes = await buildShiftedAnnotsPdf({ neighbourSubtype: "Text" });
  const [note] = await importPageAnnotations(bytes);

  assert.ok(note?.kind === "stickyNote");
  assert.equal(note.sourceId, "unresolved:shifted:0:0");
  await assert.rejects(
    () =>
      writePdfAnnotations(bytes, [{ ...note, text: "edited direct note" }], {
        replaceAnnotationSourceIds: [note.sourceId!],
        replacePageIndexes: [0],
      }),
    (error) => error instanceof PdfAnnotationIntegrityError,
  );
});

test("an aligned direct dictionary is still updated in place", async () => {
  const bytes = await buildShiftedAnnotsPdf({
    neighbourFirst: false,
    neighbourSubtype: "Highlight",
  });
  const [note] = await importPageAnnotations(bytes);

  assert.ok(note?.kind === "stickyNote");
  assert.equal(note.sourceId, "direct:0:0");

  const output = await writePdfAnnotations(
    bytes,
    [{ ...note, text: "edited direct note" }],
    {
      replaceAnnotationSourceIds: [note.sourceId!],
      replacePageIndexes: [0],
    },
  );
  const annots = (await loadTestPdf(output)).getPage(0).node.Annots();

  assert.equal(annots?.size(), 2);
  assert.equal(
    textEntry(annots?.lookupMaybe(0, PDFDict), "Contents"),
    "edited direct note",
  );
  assert.equal(
    textEntry(annots?.lookupMaybe(1, PDFDict), "Contents"),
    "neighbour must not be touched",
  );
});

test("an ambiguous direct position stops the save rather than picking one", async () => {
  const bytes = await buildDuplicateDirectNotesPdf();
  const imported = await importPageAnnotations(bytes);

  assert.equal(imported.length, 2);
  assert.deepEqual(
    imported.map((annotation) => annotation.sourceId),
    ["unresolved:ambiguous:0:0", "unresolved:ambiguous:0:1"],
  );

  const [note] = imported;
  assert.ok(note.kind === "stickyNote");
  await assert.rejects(
    () =>
      writePdfAnnotations(bytes, [{ ...note, text: "edited direct note" }], {
        replaceAnnotationSourceIds: [note.sourceId!],
        replacePageIndexes: [0],
      }),
    (error) =>
      error instanceof PdfAnnotationIntegrityError &&
      /More than one annotation in the file matches an edit on page 1/.test(
        error.message,
      ),
  );
});

test("removing an annotation whose position is unconfirmed stops the save", async () => {
  const bytes = await buildShiftedAnnotsPdf({ neighbourSubtype: "Highlight" });
  const [note] = await importPageAnnotations(bytes);

  assert.ok(note);
  await assert.rejects(
    () =>
      writePdfAnnotations(bytes, [], {
        replaceAnnotationSourceIds: [note.sourceId!],
        replacePageIndexes: [0],
      }),
    (error) =>
      error instanceof PdfAnnotationIntegrityError &&
      /could not be located in the file/.test(error.message),
  );
});

test("an edit is not written over a dictionary of a different subtype", async () => {
  const bytes = await buildDirectHighlightPdf();
  const note: PdfAnnotation = {
    ...stickyNote("hand-supplied-note", "edited direct note"),
    sourceId: "direct:0:0",
  };

  await assert.rejects(
    () =>
      writePdfAnnotations(bytes, [note], {
        replaceAnnotationSourceIds: [note.sourceId!],
        replacePageIndexes: [0],
      }),
    (error) =>
      error instanceof PdfAnnotationIntegrityError &&
      /different kind of annotation/.test(error.message),
  );
});

test("annotation identifiers are encoded as data and cannot inject PDF keys", async () => {
  const bytes = await buildBlankPdf();
  const maliciousId =
    ") /A << /S /JavaScript /JS (app.alert(1)) >> /Injected (yes";
  const note = stickyNote(maliciousId, "safe note text");

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0],
  });
  const pdfDoc = await loadTestPdf(output);
  const annots = pdfDoc.getPage(0).node.Annots();
  const dict = annots?.lookupMaybe(0, PDFDict);

  assert.ok(dict);
  assert.equal(textEntry(dict, "NM"), maliciousId);
  assert.equal(
    dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText(),
    "Text",
  );
  assert.equal(dict.has(PDFName.of("A")), false);
  assert.equal(dict.has(PDFName.of("Injected")), false);
  assert.equal(Buffer.from(output).includes(Buffer.from("/JavaScript")), false);
});

test("invalid or duplicate in-memory annotation identifiers stop the save", async () => {
  const bytes = await buildBlankPdf();
  const cases: PdfAnnotation[][] = [
    [stickyNote("duplicate", "one"), stickyNote("duplicate", "two")],
    [stickyNote("e\u0301", "one"), stickyNote("\u00e9", "two")],
    [stickyNote("control\ncharacter", "one")],
    [stickyNote("x".repeat(513), "one")],
    [stickyNote("5R", "one")],
    [stickyNote("direct:0:0", "one")],
    [stickyNote("has|alias", "one")],
    [stickyNote(" leading-space", "one")],
    [{ ...stickyNote("valid", "one"), id: 42 as unknown as string }],
    [
      {
        ...stickyNote("valid", "one"),
        sourceId: 42 as unknown as string,
      },
    ],
  ];

  for (const annotations of cases) {
    await assert.rejects(
      () => writePdfAnnotations(bytes, annotations),
      (error) => error instanceof PdfAnnotationIntegrityError,
    );
  }
});

async function importPageAnnotations(bytes: Uint8Array) {
  // Hoisted rather than inlined: `isEvalSupported` is absent from PDF.js 6's types
  // and an inline literal would trip excess-property checking.
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

async function buildIndirectHighlightPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  const highlightRef = PDFRef.of(50, 1);
  const highlight = context.obj({
    AuditTag: PDFHexString.fromText("retain-me"),
    C: [1, 0.9, 0],
    CA: 0.4,
    Contents: PDFHexString.fromText("original highlight text"),
    CreationDate: PDFString.of("D:20260810120000Z"),
    F: 28,
    NM: PDFHexString.fromText("third-party-highlight"),
    P: page.ref,
    QuadPoints: [72, 720, 180, 720, 72, 704, 180, 704],
    Rect: [72, 704, 180, 720],
    Subj: PDFHexString.fromText("Review highlight"),
    Subtype: "Highlight",
    T: PDFHexString.fromText("External reviewer"),
    Type: "Annot",
  });
  context.assign(highlightRef, highlight);
  const popupRef = context.register(
    context.obj({
      Parent: highlightRef,
      P: page.ref,
      Rect: [190, 650, 390, 750],
      Subtype: "Popup",
      Type: "Annot",
    }),
  );
  highlight.set(PDFName.of("Popup"), popupRef);
  page.node.set(PDFName.of("Annots"), context.obj([highlightRef, popupRef]));
  return rawSave(pdfDoc);
}

async function buildDirectNotePdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  const note = context.obj({
    C: [1, 0.9, 0],
    Contents: PDFHexString.fromText("original direct note"),
    NM: PDFHexString.fromText("metadata-name-must-not-be-the-locator"),
    P: page.ref,
    Rect: [72, 72, 92, 92],
    Subtype: "Text",
    Type: "Annot",
  });
  page.node.set(PDFName.of("Annots"), context.obj([note]));
  return rawSave(pdfDoc);
}

async function buildDuplicateNamedNotesPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  const refs = ["first", "second"].map((contents, index) =>
    context.register(
      context.obj({
        Contents: PDFHexString.fromText(contents),
        NM: PDFHexString.fromText("duplicate-name"),
        P: page.ref,
        Rect: [72 + index * 30, 72, 92 + index * 30, 92],
        Subtype: "Text",
        Type: "Annot",
      }),
    ),
  );
  page.node.set(PDFName.of("Annots"), context.obj(refs));
  return rawSave(pdfDoc);
}

async function buildShiftedAnnotsPdf({
  neighbourFirst = true,
  neighbourSubtype,
}: {
  neighbourFirst?: boolean;
  neighbourSubtype: "Highlight" | "Text";
}) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  const neighbour = context.obj(
    neighbourSubtype === "Highlight"
      ? {
          C: [1, 0.9, 0.2],
          CA: 0.4,
          Contents: PDFHexString.fromText("neighbour must not be touched"),
          F: 32,
          P: page.ref,
          QuadPoints: [300, 620, 500, 620, 300, 600, 500, 600],
          Rect: [300, 600, 500, 620],
          Subtype: "Highlight",
          Type: "Annot",
        }
      : {
          C: [1, 0.9, 0],
          Contents: PDFHexString.fromText("neighbour must not be touched"),
          F: 32,
          P: page.ref,
          Rect: [300, 600, 320, 620],
          Subtype: "Text",
          Type: "Annot",
        },
  );
  const note = context.obj({
    C: [1, 0.9, 0],
    Contents: PDFHexString.fromText("original direct note"),
    P: page.ref,
    Rect: [72, 72, 92, 92],
    Subtype: "Text",
    Type: "Annot",
  });
  page.node.set(
    PDFName.of("Annots"),
    context.obj(neighbourFirst ? [neighbour, note] : [note, neighbour]),
  );
  return rawSave(pdfDoc);
}

async function buildDuplicateDirectNotesPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  const note = (contents: string) =>
    context.obj({
      C: [1, 0.9, 0],
      Contents: PDFHexString.fromText(contents),
      P: page.ref,
      Rect: [72, 72, 92, 92],
      Subtype: "Text",
      Type: "Annot",
    });
  page.node.set(
    PDFName.of("Annots"),
    context.obj([note("first"), note("second")]),
  );
  return rawSave(pdfDoc);
}

async function buildDirectHighlightPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  page.node.set(
    PDFName.of("Annots"),
    context.obj([
      context.obj({
        C: [1, 0.9, 0.2],
        CA: 0.4,
        Contents: PDFHexString.fromText("a third-party highlight"),
        P: page.ref,
        QuadPoints: [72, 722, 300, 722, 72, 702, 300, 702],
        Rect: [72, 702, 300, 722],
        Subtype: "Highlight",
        Type: "Annot",
      }),
    ]),
  );
  return rawSave(pdfDoc);
}

async function buildBlankPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]);
  return rawSave(pdfDoc);
}

function stickyNote(id: string, text: string): PdfAnnotation {
  return {
    color: [1, 0.9, 0.25],
    id,
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text,
  };
}

function annotationEntriesOfSubtype(annots: PDFArray, subtype: string) {
  const entries: Array<{ dict: PDFDict; entry: PDFDict | PDFRef }> = [];
  for (let index = 0; index < annots.size(); index += 1) {
    const dict = annots.lookupMaybe(index, PDFDict);
    const entry = annots.get(index);
    if (
      dict?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ===
        subtype &&
      (entry instanceof PDFDict || entry instanceof PDFRef)
    ) {
      entries.push({ dict, entry });
    }
  }
  return entries;
}

function textEntry(dict: PDFDict | undefined, key: string) {
  return dict
    ?.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)
    ?.decodeText();
}

function rawSave(pdfDoc: PDFDocument) {
  return pdfDoc.save({
    objectsPerTick: 500,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

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
