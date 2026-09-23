import assert from "node:assert/strict";
import test from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { PDFDocument } from "pdf-lib";
import { createWorkSignature } from "../src/pdfdocumenteditor/annotationState";
import {
  MAX_DOCUMENT_HISTORY_ENTRIES,
  MAX_HISTORY_ENTRIES,
  MAX_IMAGE_HISTORY_TOTAL_BYTES,
  annotationHistoryEntry,
  historyStackImageByteSize,
  trimHistoryStack,
} from "../src/pdfdocumenteditor/historyStack";
import { markNonSerializable } from "../src/pdfdocumenteditor/sensitiveSession";
import { documentEditorSessionOutput } from "../src/pdfdocumenteditor/sessionOutput";
import { defaultToolSettings } from "../src/pdfdocumenteditor/toolSettings";
import { composeTabbedAppSession } from "../src/tabbedapp/tabbedAppSession";
import { markersIn } from "./pdfMarkers";
import type { SensitivePdfDocumentEditorSession } from "../src/pdfdocumenteditor/PdfDocumentEditor";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";

// An undo stack is the one structure that is supposed to keep what the reader
// deleted, so a cap on its length has satisfied nothing if the entries that left
// still hold what they held, and the payload is watched through a WeakRef.

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

// From a fresh macrotask each round: a synchronous `gc()` inside the frame that
// built the payloads can still see them on that frame's own stack.
async function collectUntilEmpty(expected: WeakRef<object>[]) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    collectGarbage();
    if (expected.every((ref) => ref.deref() === undefined)) {
      return;
    }
  }
}

function stickyNote(id: string, text = id): PdfAnnotation {
  return {
    color: [1, 1, 0],
    id,
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 0, x2: 10, y1: 0, y2: 10 },
    text,
  };
}

function imageStamp(id: string, bytes: number): PdfAnnotation {
  return {
    comment: "",
    heightPx: 1000,
    id,
    imageData: "A".repeat(bytes),
    kind: "imageStamp",
    mimeType: "image/png",
    pageIndex: 0,
    rect: { x1: 0, x2: 100, y1: 0, y2: 100 },
    widthPx: 1000,
  };
}

type HistoryEntry = ReturnType<typeof annotationHistoryEntry>;

function pushNoteEntry(
  stack: HistoryEntry[],
  index: number,
  watched: WeakRef<object>[],
) {
  const note = stickyNote(`note-${index}`);
  watched.push(new WeakRef(note));
  return trimHistoryStack([...stack, annotationHistoryEntry([note])]);
}

function pushDocumentEntry(
  stack: HistoryEntry[],
  index: number,
  watched: WeakRef<object>[],
) {
  const cleanPdfBytes = new Uint8Array(4096).fill(index & 0xff);
  watched.push(new WeakRef(cleanPdfBytes));
  const entry = {
    kind: "document",
    snapshot: {
      annotations: [],
      cleanAnnotations: [],
      cleanPdfBytes,
      operation: { type: "removePages" },
    },
    view: { activePageIndex: 0, scale: 1 },
  } as unknown as HistoryEntry;
  return trimHistoryStack([...stack, entry]);
}

test("an evicted annotation entry releases the note only it still held", async () => {
  let stack: HistoryEntry[] = [];
  const watched: WeakRef<object>[] = [];
  const pushes = MAX_HISTORY_ENTRIES * 3;
  for (let index = 0; index < pushes; index += 1) {
    stack = pushNoteEntry(stack, index, watched);
  }

  assert.equal(stack.length, MAX_HISTORY_ENTRIES);
  const evicted = watched.slice(0, pushes - MAX_HISTORY_ENTRIES);
  const surviving = watched.slice(pushes - MAX_HISTORY_ENTRIES);
  await collectUntilEmpty(evicted);

  assert.deepEqual(
    evicted
      .map((ref, index) => (ref.deref() ? `note-${index}` : null))
      .filter(Boolean),
    [],
    "an entry left the stack and the note it held stayed reachable: the " +
      "stack caps its length without ever letting the deleted note go",
  );
  assert.equal(
    surviving.filter((ref) => ref.deref()).length,
    surviving.length,
    "an entry still on the stack lost its note",
  );
});

test("a stack past its image budget releases the images it evicted", async () => {
  // Eight entries is well inside MAX_HISTORY_ENTRIES and none is a document entry,
  // so every bound this stack had reported it empty while it held 96 MiB.
  const stampBytes = 12 * 1024 * 1024;
  const pushes = 8;
  let stack: HistoryEntry[] = [];
  const watched: WeakRef<object>[] = [];
  for (let index = 0; index < pushes; index += 1) {
    const stamp = imageStamp(`stamp-${index}`, stampBytes);
    watched.push(new WeakRef(stamp));
    stack = trimHistoryStack([...stack, annotationHistoryEntry([stamp])]);
  }

  assert.ok(
    historyStackImageByteSize(stack) <= MAX_IMAGE_HISTORY_TOTAL_BYTES,
    "the stack is over its image budget, so nothing below is measuring " +
      "eviction",
  );
  assert.ok(
    stack.length < pushes,
    "no entry was evicted, so this case never asked whether eviction frees",
  );

  const evicted = watched.slice(0, pushes - stack.length);
  const surviving = watched.slice(pushes - stack.length);
  await collectUntilEmpty(evicted);

  assert.equal(
    evicted.filter((ref) => ref.deref()).length,
    0,
    "an entry left the stack over the image budget and the image it held " +
      "stayed reachable: the budget evicts entries without ever letting the " +
      "megabytes go",
  );
  assert.equal(
    surviving.filter((ref) => ref.deref()).length,
    surviving.length,
    "an entry still on the stack lost its image",
  );
});

test("an evicted document entry releases the PDF bytes only it still held", async () => {
  let stack: HistoryEntry[] = [];
  const watched: WeakRef<object>[] = [];
  const pushes = MAX_DOCUMENT_HISTORY_ENTRIES * 3;
  for (let index = 0; index < pushes; index += 1) {
    stack = pushDocumentEntry(stack, index, watched);
  }

  assert.equal(stack.length, MAX_DOCUMENT_HISTORY_ENTRIES);
  const evicted = watched.slice(0, pushes - MAX_DOCUMENT_HISTORY_ENTRIES);
  const surviving = watched.slice(pushes - MAX_DOCUMENT_HISTORY_ENTRIES);
  await collectUntilEmpty(evicted);

  assert.equal(
    evicted.filter((ref) => ref.deref()).length,
    0,
    "a document entry left the stack and the bytes of the document it " +
      "described stayed reachable",
  );
  assert.equal(
    surviving.filter((ref) => ref.deref()).length,
    surviving.length,
    "a document entry still on the stack lost its bytes",
  );
});

const MARKER = "PANNHISTORYMARKER";
const MARKER_PATTERN = /PANNHISTORYMARKER[A-Za-z0-9-]*/;

async function blankPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]);
  return pdfDoc.save({ useObjectStreams: false });
}

function highlight(id: string, comment: string): PdfAnnotation {
  return {
    color: [1, 0.9, 0.2],
    comment,
    id,
    kind: "textHighlight",
    opacity: 0.4,
    pageIndex: 0,
    quadPoints: [[72, 720, 180, 720, 72, 704, 180, 704]],
    rects: [{ x1: 72, x2: 180, y1: 704, y2: 720 }],
  };
}

function markedSession(
  pdfBytes: Uint8Array,
  live: PdfAnnotation[],
): SensitivePdfDocumentEditorSession {
  const deleted = highlight("deleted-note", `${MARKER}-COMMENT`);
  const deletedNote = stickyNote("deleted-sticky", `${MARKER}-STICKY`);
  return markNonSerializable<SensitivePdfDocumentEditorSession>({
    annotations: live,
    cleanAnnotations: [],
    cleanPdfBytes: pdfBytes,
    cleanWorkSignature: createWorkSignature("clean", []),
    fileName: "parked.pdf",
    hasUnsavedChanges: true,
    importedAnnotationPageIndexes: [],
    managedAnnotationPageIndexes: [0],
    pdfBytes,
    pdfFingerprint: "clean",
    redoStack: [annotationHistoryEntry([deletedNote])],
    removedAnnotationSourceIds: [],
    shouldImportAnnotations: false,
    sourceId: "parked-1",
    undoStack: [
      annotationHistoryEntry([deleted]),
      annotationHistoryEntry([deleted, deletedNote]),
    ],
    view: { activePageIndex: 0, scale: 1 },
    version: 1,
  });
}

const chromeState = {
  activeToolKey: "select",
  annotationFilter: { bookmarkedOnly: false, colorKeys: [] },
  showAnnotations: true,
  sidebarOpen: false,
  sidebarTab: "annotations" as const,
  sidebarWidth: 200,
  toolPresets: {},
  toolSettings: defaultToolSettings,
};

test("the scan can see a marker the writer really does put in the file", async () => {
  // The control: without it every case below passes on a scanner that finds
  // nothing anywhere.
  const pdfBytes = await blankPdf();
  const live = highlight("live-note", `${MARKER}-LIVE`);
  const { bytes } = await documentEditorSessionOutput(
    markedSession(pdfBytes, [live]),
  );

  assert.deepEqual(
    [...(await markersIn(bytes, MARKER_PATTERN))],
    [`${MARKER}-LIVE`],
    "the writer did not put the live annotation's comment in the file, so " +
      "the absence of the history's markers below proves nothing",
  );
});

test("a marker held only by the history stacks reaches nothing Save All writes", async () => {
  const pdfBytes = await blankPdf();
  const session = markedSession(pdfBytes, [
    highlight("live-note", "an ordinary comment"),
  ]);
  const { bytes } = await documentEditorSessionOutput(session);

  assert.deepEqual(
    [...(await markersIn(bytes, MARKER_PATTERN))],
    [],
    "the bytes a parked tab writes carry an annotation that exists only on " +
      "its undo/redo stacks - the reader deleted it and it left in the file",
  );
});

test("every carrier of a history stack refuses to serialise", async () => {
  const pdfBytes = await blankPdf();
  const session = markedSession(pdfBytes, []);
  const carriers: [string, object][] = [
    ["the parked document editor session", session],
    [
      "the composed tabbedapp session",
      composeTabbedAppSession(session, chromeState),
    ],
  ];

  for (const [name, carrier] of carriers) {
    assert.throws(
      () => JSON.stringify(carrier),
      `${name} serialised: its undo/redo stacks can be written to a store`,
    );
    assert.throws(
      () => JSON.stringify({ tabs: [carrier] }),
      `${name} serialised inside a parent: a store write wrapping it leaks`,
    );
  }
});
