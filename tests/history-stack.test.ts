import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_HISTORY_TOTAL_BYTES,
  annotationHistoryEntry,
  annotationHistorySignature,
  documentHistorySnapshotByteSize,
  historyStackImageByteSize,
  trimHistoryStack,
} from "../src/pdfdocumenteditor/historyStack";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";

// The history-entry types live in a .tsx React module, so these build minimal
// shapes and cast rather than pulling React and the DOM into the runner.
type HistoryEntry = ReturnType<typeof annotationHistoryEntry>;

function stickyNote(id: string, pageIndex = 0): PdfAnnotation {
  return {
    id,
    kind: "stickyNote",
    pageIndex,
    color: [1, 1, 0],
    rect: { x1: 0, y1: 0, x2: 10, y2: 10 },
    text: id,
  } as PdfAnnotation;
}

const ONE_MIB = 1024 * 1024;

function imageStamp(id: string, bytes: number): PdfAnnotation {
  return {
    comment: "",
    heightPx: 1000,
    id,
    imageData: "A".repeat(bytes),
    kind: "imageStamp",
    mimeType: "image/png",
    pageIndex: 0,
    rect: { x1: 0, y1: 0, x2: 100, y2: 100 },
    widthPx: 1000,
  };
}

function documentEntry(
  pagesBytes?: Uint8Array,
  annotations: PdfAnnotation[] = [],
): HistoryEntry {
  return {
    kind: "document",
    snapshot: {
      annotations,
      cleanAnnotations: annotations,
      operation: pagesBytes
        ? { type: "insertPages", pagesBytes }
        : { type: "removePages" },
    },
  } as unknown as HistoryEntry;
}

test("annotationHistoryEntry wraps annotations and signature is stable/among-different", () => {
  const entry = annotationHistoryEntry([stickyNote("a")]);
  assert.equal(entry.kind, "annotations");

  const sigA = annotationHistorySignature([stickyNote("a")]);
  const sigAAgain = annotationHistorySignature([stickyNote("a")]);
  const sigB = annotationHistorySignature([stickyNote("b")]);
  assert.equal(sigA, sigAAgain);
  assert.notEqual(sigA, sigB);
});

test("trimHistoryStack caps total entries at 20 (keeps the most recent)", () => {
  const entries = Array.from({ length: 25 }, (_, index) =>
    annotationHistoryEntry([stickyNote(`n${index}`)]),
  );
  const trimmed = trimHistoryStack(entries);
  assert.equal(trimmed.length, 20);
  assert.equal(trimmed[0], entries[5]);
  assert.equal(trimmed[19], entries[24]);
});

test("trimHistoryStack caps document entries at 5, evicting oldest documents first", () => {
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < 7; i += 1) {
    entries.push(documentEntry());
    entries.push(annotationHistoryEntry([stickyNote(`a${i}`)]));
  }
  const trimmed = trimHistoryStack(entries);
  const documentCount = trimmed.filter(
    (entry) => entry.kind === "document",
  ).length;
  assert.equal(documentCount, 5);
});

test("trimHistoryStack enforces the total-bytes cap even when the document-entry count is under its own cap", () => {
  // The byte-size trim used to be gated behind an early return that only fired
  // past MAX_DOCUMENT_HISTORY_ENTRIES (5), so three huge document entries could
  // sit past the total-bytes budget for ever.
  const bigEntry = () => documentEntry(new Uint8Array(50 * 1024 * 1024)); // 50MB
  const entries: HistoryEntry[] = [bigEntry(), bigEntry(), bigEntry()]; // 150MB, 3 <= 5
  const trimmed = trimHistoryStack(entries);

  const totalBytes = trimmed.reduce((total, entry) => {
    return entry.kind === "document"
      ? total +
          documentHistorySnapshotByteSize(
            (
              entry as unknown as {
                snapshot: Parameters<typeof documentHistorySnapshotByteSize>[0];
              }
            ).snapshot,
          )
      : total;
  }, 0);

  assert.ok(
    totalBytes <= 128 * 1024 * 1024,
    `expected trimmed total (${totalBytes}) to respect the 128MB cap`,
  );
  assert.ok(
    trimmed.length < entries.length,
    "expected at least one entry to be evicted",
  );
});

test("documentHistorySnapshotByteSize sums insertPages bytes plus cleanPdfBytes, deduped", () => {
  const shared = new Uint8Array(100);
  const insert = documentEntry(new Uint8Array(40));
  assert.equal(
    documentHistorySnapshotByteSize(
      (
        insert as unknown as {
          snapshot: Parameters<typeof documentHistorySnapshotByteSize>[0];
        }
      ).snapshot,
    ),
    40,
  );

  const snapshotWithShared = {
    operation: { type: "insertPages", pagesBytes: shared },
    cleanPdfBytes: shared,
  } as unknown as Parameters<typeof documentHistorySnapshotByteSize>[0];
  assert.equal(documentHistorySnapshotByteSize(snapshotWithShared), 100);
});

test("trimHistoryStack caps the image bytes the stack holds, under every other cap", () => {
  // Ten entries, one 8 MiB stamp each: inside MAX_HISTORY_ENTRIES (20), no
  // document entry at all, and 80 MiB of held image.
  const entries = Array.from({ length: 10 }, (_, index) =>
    annotationHistoryEntry([imageStamp(`stamp-${index}`, 8 * ONE_MIB)]),
  );
  assert.ok(
    historyStackImageByteSize(entries) > MAX_IMAGE_HISTORY_TOTAL_BYTES,
    "the case did not build a stack past the bound it is testing",
  );

  const trimmed = trimHistoryStack(entries);

  assert.ok(
    historyStackImageByteSize(trimmed) <= MAX_IMAGE_HISTORY_TOTAL_BYTES,
    `the trimmed stack holds ${historyStackImageByteSize(trimmed)} bytes of ` +
      `image, past MAX_IMAGE_HISTORY_TOTAL_BYTES ` +
      `(${MAX_IMAGE_HISTORY_TOTAL_BYTES})`,
  );
  assert.equal(trimmed.at(-1), entries.at(-1));
});

test("a single step heavier than the whole budget is not kept", () => {
  const oversized = annotationHistoryEntry(
    Array.from({ length: 40 }, (_, index) =>
      imageStamp(`stamp-${index}`, 2 * ONE_MIB),
    ),
  );

  const trimmed = trimHistoryStack([oversized]);

  assert.equal(trimmed.length, 0);
  assert.equal(historyStackImageByteSize(trimmed), 0);
});

test("one image named by every entry is counted once, and evicts nothing", () => {
  // commitAnnotations stores the pre-edit array by reference, so dragging one
  // stamp leaves many entries naming one string. A bound that counted occurrences
  // would read 20 x 8 MiB here and throw away nineteen undo steps to free nothing.
  const dragged = imageStamp("dragged", 8 * ONE_MIB);
  const entries = Array.from({ length: 20 }, () =>
    annotationHistoryEntry([dragged]),
  );

  assert.equal(historyStackImageByteSize(entries), 8 * ONE_MIB);
  assert.equal(trimHistoryStack(entries).length, 20);
});

test("the same picture pasted twice is two allocations and is counted twice", () => {
  const bytes = 8 * ONE_MIB;
  const entry = annotationHistoryEntry([
    imageStamp("first", bytes),
    imageStamp("second", bytes),
  ]);

  assert.equal(historyStackImageByteSize([entry]), 2 * bytes);
});
