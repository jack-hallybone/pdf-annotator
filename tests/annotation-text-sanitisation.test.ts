import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";

// The visible text of a free-text box or a sticky note is a /Contents string and
// did not go through `untrustedText.ts`, so a note reading `<RLO>txt.exe<PDF>`
// reached the sidebar as the file wrote it.

// annotationImport reaches PDF.js's browser entry, which touches these globals
// while the module is evaluated.
installPdfJsGlobals();
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { importExistingAnnotationsForPage } =
  await import("../src/pdfdocumenteditor/annotationImport");
const { writePdfAnnotations } =
  await import("../src/pdfdocumenteditor/pdfWriter");

const RLO = "\u202e";
const POP = "\u202c";
const NUL = "\u0000";
const BEL = "\u0007";

async function pdfWithNoteAndFreeText(text: string) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  page.node.set(
    PDFName.of("Annots"),
    context.obj([
      context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [72, 700, 92, 720],
        Contents: PDFHexString.fromText(text),
        C: [1, 0.9, 0.25],
        Name: "Note",
      }),
      context.obj({
        Type: "Annot",
        Subtype: "FreeText",
        Rect: [200, 600, 400, 700],
        Contents: PDFHexString.fromText(text),
        DA: PDFString.of("0 0 0 rg /Helv 12 Tf"),
      }),
    ]),
  );
  return pdfDoc.save({ useObjectStreams: false });
}

async function importedAnnotations(bytes: Uint8Array) {
  const loadingTask = getDocument({ data: bytes.slice() });
  try {
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(1);
    const { annotations } = await importExistingAnnotationsForPage(
      page,
      0,
      bytes,
    );
    return annotations;
  } finally {
    await loadingTask.destroy();
  }
}

async function importedTexts(bytes: Uint8Array) {
  return (await importedAnnotations(bytes)).map((annotation) =>
    annotation.kind === "freeText" || annotation.kind === "stickyNote"
      ? annotation.text
      : null,
  );
}

test("a note's own text loses the bidi overrides and control characters", async () => {
  const hostile = `safe${RLO}txt.exe${POP} a${NUL}b${BEL}c`;
  const texts = await importedTexts(await pdfWithNoteAndFreeText(hostile));

  assert.equal(texts.length, 2, `expected both kinds, got ${texts.length}`);
  for (const text of texts) {
    assert.ok(typeof text === "string");
    assert.equal(text, "safetxt.exe abc");
    assert.ok(
      !/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(text),
      "a bidi control survived the import",
    );
    assert.ok(
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f-\u009f]/.test(text),
      "a control character survived the import",
    );
  }
});

// The rule above was written as a list, and the list was Unicode's minus U+061C
// ARABIC LETTER MARK: ten invisible code points reached the sidebar through a
// hostile PDF. `tests/hidden-characters.test.ts` is the sweep over Unicode; this
// is the end of the real path, so the sweep cannot pass while this route is open.
test("a note's own text loses every invisible code point, not a listed few", async () => {
  const invisibles =
    "\u061c\u200b\u200d\u2060\ufeff\u2028\u2029\u00ad\ufff9\u{e0041}";
  const texts = await importedTexts(
    await pdfWithNoteAndFreeText(`Pay${invisibles} 100 to ACME`),
  );

  assert.equal(texts.length, 2, `expected both kinds, got ${texts.length}`);
  for (const text of texts) {
    assert.equal(
      text,
      "Pay 100 to ACME",
      "an invisible code point reached the annotations sidebar",
    );
  }
});

test("U+061C beside Arabic text does not survive the import", async () => {
  const texts = await importedTexts(
    await pdfWithNoteAndFreeText(
      "\u0627\u0644\u0645\u0628\u0644\u063a \u061c100 USD",
    ),
  );

  for (const text of texts) {
    assert.equal(text, "\u0627\u0644\u0645\u0628\u0644\u063a 100 USD");
  }
});

test("and keeps every character of a long note, because that text is the annotation", async () => {
  const long = "x".repeat(9000);
  const texts = await importedTexts(await pdfWithNoteAndFreeText(long));

  for (const text of texts) {
    assert.equal(
      text?.length,
      9000,
      "the note's own text was truncated: that deletes a reader's own writing",
    );
  }
});

test("a long note survives a save unchanged, in both shapes", async () => {
  const long = `start ${"x".repeat(100_000)} end`;
  const bytes = await pdfWithNoteAndFreeText(long);
  const imported = await importedAnnotations(bytes);
  assert.equal(imported.length, 2);

  const written = await writePdfAnnotations(bytes, imported, {
    replaceAnnotationSourceIds: imported.map(
      (annotation) => annotation.sourceId!,
    ),
    replacePageIndexes: [0],
  });

  const readBack = await importedTexts(written);
  assert.equal(readBack.length, 2);
  for (const text of readBack) {
    assert.equal(text, long);
  }
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
