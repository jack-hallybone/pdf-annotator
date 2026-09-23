import assert from "node:assert/strict";
import { test } from "node:test";
import { act, waitFor } from "@testing-library/react";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mountLoadedModel, onePagePdf } from "./documentModelHarness";
import { markersIn } from "./pdfMarkers";
import { createWorkSignature } from "../src/pdfdocumenteditor/annotationState";
import {
  MAX_DOCUMENT_HISTORY_ENTRIES,
  MAX_HISTORY_ENTRIES,
  MAX_IMAGE_HISTORY_TOTAL_BYTES,
  annotationHistoryEntry,
  documentHistorySnapshotByteSize,
  historyStackImageByteSize,
} from "../src/pdfdocumenteditor/historyStack";
import { markNonSerializable } from "../src/pdfdocumenteditor/sensitiveSession";
import { documentEditorSessionOutput } from "../src/pdfdocumenteditor/sessionOutput";
import type {
  PdfDocumentEditorHistoryEntry,
  SensitivePdfDocumentEditorSession,
} from "../src/pdfdocumenteditor/useDocumentModel";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";

// Driven through the real push paths, because a push path that never calls the
// trim satisfies every test written against the trim.

function stickyNote(index: number): PdfAnnotation {
  return {
    color: [1, 1, 0],
    id: `note-${index}`,
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: index, x2: index + 10, y1: 0, y2: 10 },
    text: `note ${index}`,
  };
}

function imageStamp(index: number, bytes: number): PdfAnnotation {
  return {
    comment: "",
    heightPx: 1000,
    id: `stamp-${index}`,
    imageData: "A".repeat(bytes),
    kind: "imageStamp",
    mimeType: "image/png",
    pageIndex: 0,
    rect: { x1: 0, x2: 100, y1: 0, y2: 100 },
    widthPx: 1000,
  };
}

function boundsReport(
  undoStack: PdfDocumentEditorHistoryEntry[],
  redoStack: PdfDocumentEditorHistoryEntry[],
) {
  const report = (stack: PdfDocumentEditorHistoryEntry[]) => {
    const documents = stack.filter((entry) => entry.kind === "document");
    return {
      bytes: documents.reduce(
        (total, entry) =>
          entry.kind === "document"
            ? total + documentHistorySnapshotByteSize(entry.snapshot)
            : total,
        0,
      ),
      documents: documents.length,
      entries: stack.length,
      imageBytes: historyStackImageByteSize(stack),
    };
  };
  return { redo: report(redoStack), undo: report(undoStack) };
}

function assertWithinBounds(
  undoStack: PdfDocumentEditorHistoryEntry[],
  redoStack: PdfDocumentEditorHistoryEntry[],
  what: string,
) {
  const measured = boundsReport(undoStack, redoStack);
  for (const [side, stack] of Object.entries(measured)) {
    assert.ok(
      stack.entries <= MAX_HISTORY_ENTRIES,
      `${what}: the ${side} stack grew to ${stack.entries} entries, past ` +
        `MAX_HISTORY_ENTRIES (${MAX_HISTORY_ENTRIES}) - this push path is ` +
        `not going through the cap`,
    );
    assert.ok(
      stack.documents <= MAX_DOCUMENT_HISTORY_ENTRIES,
      `${what}: the ${side} stack holds ${stack.documents} document ` +
        `snapshots, past MAX_DOCUMENT_HISTORY_ENTRIES ` +
        `(${MAX_DOCUMENT_HISTORY_ENTRIES})`,
    );
    assert.ok(
      stack.imageBytes <= MAX_IMAGE_HISTORY_TOTAL_BYTES,
      `${what}: the ${side} stack holds ${stack.imageBytes} bytes of pasted ` +
        `image, past MAX_IMAGE_HISTORY_TOTAL_BYTES ` +
        `(${MAX_IMAGE_HISTORY_TOTAL_BYTES}) - a stamp's payload rides on the ` +
        `annotation, so no count of versions can see it`,
    );
  }
  return measured;
}

test("annotation edits driven past the bound stop the undo stack growing", async () => {
  const { result } = await mountLoadedModel();
  const model = () => result.current.model;
  const pushes = MAX_HISTORY_ENTRIES * 3;

  let peak = 0;
  for (let index = 0; index < pushes; index += 1) {
    await act(async () => {
      model().commitAnnotations((current) => [...current, stickyNote(index)]);
    });
    peak = Math.max(peak, model().undoStack.length);
    assertWithinBounds(model().undoStack, model().redoStack, "annotation edit");
  }

  // Without this the cap could be met by a model that stopped recording after the
  // first edit.
  assert.equal(
    model().annotations.length,
    pushes,
    "the drive did not actually make one edit per push",
  );
  assert.equal(
    peak,
    MAX_HISTORY_ENTRIES,
    `the undo stack never reached its bound (peaked at ${peak}), so this ` +
      "case did not drive past it",
  );
  assert.equal(model().undoStack.length, MAX_HISTORY_ENTRIES);
});

test("pasted images driven past the byte budget stop the undo stack growing", async () => {
  // Every push here is inside MAX_HISTORY_ENTRIES and none is a document entry, so
  // the other bounds hold at every step while the megabytes only go up. Driven
  // through commitAnnotations, because a bound the push path does not call is not
  // a bound.
  const { result } = await mountLoadedModel();
  const model = () => result.current.model;
  const stampBytes = 12 * 1024 * 1024;
  const pushes = 8;

  let peak = 0;
  for (let index = 0; index < pushes; index += 1) {
    await act(async () => {
      model().commitAnnotations((current) => [
        ...current,
        imageStamp(index, stampBytes),
      ]);
    });
    peak = Math.max(peak, model().undoStack.length);
    assertWithinBounds(model().undoStack, model().redoStack, "pasted image");
  }

  assert.equal(
    model().annotations.length,
    pushes,
    "the drive did not actually paste one image per push",
  );
  assert.ok(
    model().undoStack.length < pushes,
    `${pushes} pasted images left all ${model().undoStack.length} entries on ` +
      "the undo stack, so the byte budget evicted nothing and the assertion " +
      "above passed without being tested",
  );
  assert.ok(
    peak <= pushes,
    "the stack grew past the number of pushes, which cannot happen",
  );
});

test("a live edit's push is capped on the same bound", async () => {
  const { result } = await mountLoadedModel();
  const model = () => result.current.model;
  const pushes = MAX_HISTORY_ENTRIES * 2;

  // Three acts rather than one: the annotations ref catches up inside the state
  // updater React runs at render time, so a begin/move/finish collapsed into one
  // act records nothing.
  for (let index = 0; index < pushes; index += 1) {
    await act(async () => {
      model().beginAnnotationEdit();
    });
    await act(async () => {
      model().commitAnnotations((current) => [...current, stickyNote(index)], {
        recordUndo: false,
      });
    });
    await act(async () => {
      model().finishAnnotationEdit();
    });
    assertWithinBounds(model().undoStack, model().redoStack, "live edit");
  }

  assert.equal(model().annotations.length, pushes);
  assert.equal(model().undoStack.length, MAX_HISTORY_ENTRIES);
});

test("structural edits driven past the document bound stop both stacks growing", async () => {
  const { result } = await mountLoadedModel();
  const model = () => result.current.model;
  const rotations = MAX_DOCUMENT_HISTORY_ENTRIES * 2;

  for (let index = 0; index < rotations; index += 1) {
    await act(async () => {
      await model().handleRotatePage(0);
    });
    await waitFor(() => {
      assert.equal(model().busy, false);
    });
    assertWithinBounds(model().undoStack, model().redoStack, "structural edit");
  }

  const documents = model().undoStack.filter(
    (entry) => entry.kind === "document",
  );
  assert.equal(
    documents.length,
    MAX_DOCUMENT_HISTORY_ENTRIES,
    `${rotations} page rotations left ${documents.length} document ` +
      "snapshots on the undo stack",
  );

  for (let index = 0; index < documents.length; index += 1) {
    await act(async () => {
      await model().undoHistory();
    });
    await waitFor(() => {
      assert.equal(model().busy, false);
    });
    assertWithinBounds(model().undoStack, model().redoStack, "undo");
  }

  assert.ok(
    model().redoStack.length > 0,
    "undoing a page rotation put nothing on the redo stack, so this case " +
      "never exercised it",
  );
});

test("a parked tab's oversized stacks are capped when it is put back", async () => {
  const bytes = await onePagePdf();
  const oversized = Array.from(
    { length: MAX_HISTORY_ENTRIES * 5 },
    (_, index) => annotationHistoryEntry([stickyNote(index)]),
  );
  const parked = markNonSerializable<SensitivePdfDocumentEditorSession>({
    annotations: [],
    cleanAnnotations: [],
    cleanPdfBytes: bytes,
    cleanWorkSignature: createWorkSignature("parked", []),
    fileName: "parked.pdf",
    hasUnsavedChanges: false,
    importedAnnotationPageIndexes: [],
    managedAnnotationPageIndexes: [],
    pdfBytes: bytes,
    pdfFingerprint: "parked",
    redoStack: oversized,
    removedAnnotationSourceIds: [],
    shouldImportAnnotations: false,
    sourceId: "parked-oversized",
    undoStack: oversized,
    view: { activePageIndex: 0, scale: 1 },
    version: 1,
  });

  const { result } = await mountLoadedModel(1, undefined, bytes, [], parked);
  const model = () => result.current.model;
  await waitFor(() => {
    assert.ok(model().undoStack.length > 0, "the parked stacks never arrived");
  });

  assert.equal(model().undoStack.length, MAX_HISTORY_ENTRIES);
  assert.equal(model().redoStack.length, MAX_HISTORY_ENTRIES);
});

// Never persisted - the page the reader deleted.

const PAGE_MARKER = "PANNDELETEDPAGEMARKER";
const PAGE_MARKER_PATTERN = /PANNDELETEDPAGEMARKER[A-Za-z0-9-]*/;

async function twoPagesOneMarked() {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  pdfDoc.addPage([612, 792]).drawText("KEPTPAGE", {
    font,
    size: 24,
    x: 60,
    y: 700,
  });
  pdfDoc.addPage([612, 792]).drawText(`${PAGE_MARKER}-PAGETWO`, {
    font,
    size: 24,
    x: 60,
    y: 700,
  });
  return pdfDoc.save({ useObjectStreams: false });
}

async function writtenMarkers(model: {
  createDocumentEditorSession: () => SensitivePdfDocumentEditorSession | null;
}) {
  const session = model.createDocumentEditorSession();
  assert.ok(session, "no session was captured for a loaded document");
  const { bytes } = await documentEditorSessionOutput(session);
  return markersIn(bytes, PAGE_MARKER_PATTERN);
}

test("the page a reader deleted stays on the undo stack and leaves the file", async () => {
  const bytes = await twoPagesOneMarked();
  // The control: the scan can see the marker through the deflated, hex-encoded
  // content stream it is written in.
  assert.deepEqual(
    [...(await markersIn(bytes, PAGE_MARKER_PATTERN))],
    [`${PAGE_MARKER}-PAGETWO`],
    "the scan cannot see the marker in the document it is in, so its " +
      "absence below would prove nothing",
  );

  const { result } = await mountLoadedModel(1, undefined, bytes);
  const model = () => result.current.model;
  assert.deepEqual(
    [...(await writtenMarkers(model()))],
    [`${PAGE_MARKER}-PAGETWO`],
  );

  await act(async () => {
    await model().handleDeletePage(1);
  });
  await waitFor(() => {
    assert.equal(model().pageCount, 1);
  });

  const entry = model().undoStack.at(-1);
  assert.equal(
    entry?.kind,
    "document",
    "the page delete recorded no undo entry, so nothing is being kept and " +
      "this case is not measuring what it claims to",
  );

  assert.deepEqual(
    [...(await writtenMarkers(model()))],
    [],
    "the file this tab writes still carries the page the reader deleted - " +
      "the undo stack's copy reached the bytes",
  );

  await act(async () => {
    await model().undoHistory();
  });
  await waitFor(() => {
    assert.equal(model().pageCount, 2);
  });
  assert.deepEqual(
    [...(await writtenMarkers(model()))],
    [`${PAGE_MARKER}-PAGETWO`],
  );
});
