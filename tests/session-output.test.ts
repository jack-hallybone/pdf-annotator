import assert from "node:assert/strict";
import test from "node:test";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import {
  documentEditorSessionAfterSave,
  documentEditorSessionOutput,
} from "../src/pdfdocumenteditor/sessionOutput";
import { createWorkSignature } from "../src/pdfdocumenteditor/annotationState";
import { markNonSerializable } from "../src/pdfdocumenteditor/sensitiveSession";
import type { SensitivePdfDocumentEditorSession } from "../src/pdfdocumenteditor/PdfDocumentEditor";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import { loadTestPdf } from "./pdfTestUtils";

// Save All saves a tab that is not on screen, so it has to serialise one from
// its parked session alone: mounting each tab in turn would put serialisation
// inside React lifecycles at the moment they are torn down.

async function blankPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]);
  return pdfDoc.save({ useObjectStreams: false });
}

function highlight(comment: string): PdfAnnotation {
  return {
    color: [1, 0.9, 0.2],
    comment,
    id: "session-highlight",
    kind: "textHighlight",
    opacity: 0.4,
    pageIndex: 0,
    quadPoints: [[72, 720, 180, 720, 72, 704, 180, 704]],
    rects: [{ x1: 72, x2: 180, y1: 704, y2: 720 }],
  };
}

function session(
  pdfBytes: Uint8Array,
  annotations: PdfAnnotation[],
  overrides: Partial<SensitivePdfDocumentEditorSession> = {},
): SensitivePdfDocumentEditorSession {
  return markNonSerializable<SensitivePdfDocumentEditorSession>({
    annotations,
    cleanAnnotations: [],
    cleanPdfBytes: pdfBytes,
    cleanWorkSignature: createWorkSignature("clean", []),
    fileName: "parked.pdf",
    hasUnsavedChanges: true,
    importedAnnotationPageIndexes: [],
    managedAnnotationPageIndexes: [0],
    pdfBytes,
    pdfFingerprint: "clean",
    redoStack: [],
    removedAnnotationSourceIds: [],
    shouldImportAnnotations: false,
    sourceId: "parked-1",
    undoStack: [],
    view: { activePageIndex: 0, scale: 1 },
    version: 1,
    ...overrides,
  });
}

async function highlightCount(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const annots = pdfDoc.getPage(0).node.Annots();
  let count = 0;
  for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
    const dict = annots?.lookupMaybe(index, PDFDict);
    if (
      dict?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ===
      "Highlight"
    ) {
      count += 1;
    }
  }
  return count;
}

test("a parked session serialises its annotations without being mounted", async () => {
  const { bytes } = await documentEditorSessionOutput(
    session(await blankPdf(), [highlight("from a parked tab")]),
  );

  assert.equal(await highlightCount(bytes), 1);
});

test("a clean session hands back the bytes it already has", async () => {
  const cleanBytes = await blankPdf();
  const output = await documentEditorSessionOutput(
    session(cleanBytes, [], { hasUnsavedChanges: false }),
  );

  assert.equal(output.bytes, cleanBytes);
  assert.equal(output.sources, null);
});

test("a session saved from its parked state comes back clean", async () => {
  const original = session(await blankPdf(), [highlight("saved")]);
  const output = await documentEditorSessionOutput(original);
  const saved = documentEditorSessionAfterSave(original, output);

  assert.equal(saved.hasUnsavedChanges, false);
  assert.equal(saved.pdfBytes, output.bytes);
  assert.equal(saved.cleanPdfBytes, output.bytes);
  assert.deepEqual(saved.cleanAnnotations, original.annotations);
  assert.equal(
    saved.cleanWorkSignature,
    createWorkSignature(saved.pdfFingerprint, saved.cleanAnnotations),
  );
  assert.equal(saved.undoStack, original.undoStack);
});

// A session holds full PDF bytes behind a non-enumerable throwing toJSON, and a
// spread does not carry a non-enumerable property, so a rebuilt one would be a
// plain object that JSON.stringify - and so localStorage - would serialise.
test("a session rebuilt after a save still refuses to be serialised", async () => {
  const saved = documentEditorSessionAfterSave(
    session(await blankPdf(), [highlight("saved")]),
    { bytes: await blankPdf(), sources: null },
  );

  assert.throws(() => JSON.stringify(saved));
  assert.throws(() => JSON.stringify({ tabs: [saved] }));
});
