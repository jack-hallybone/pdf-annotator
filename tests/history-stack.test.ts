import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotationHistoryEntry,
  annotationHistorySignature,
  documentHistorySnapshotByteSize,
  normalizeHistoryStack,
  trimHistoryStack
} from '../src/workspace/historyStack';
import type { PdfAnnotation } from '../src/workspace/types';

// The history-entry/snapshot types live in PdfWorkspace (a .tsx React module).
// We deliberately build minimal shapes and cast, rather than importing that
// module, so these pure-logic tests never pull React/DOM into the runner.
type HistoryEntry = ReturnType<typeof annotationHistoryEntry>;

function stickyNote(id: string, pageIndex = 0): PdfAnnotation {
  return {
    id,
    kind: 'stickyNote',
    pageIndex,
    color: [1, 1, 0],
    rect: { x1: 0, y1: 0, x2: 10, y2: 10 },
    text: id
  } as PdfAnnotation;
}

function documentEntry(pagesBytes?: Uint8Array): HistoryEntry {
  return {
    kind: 'document',
    snapshot: pagesBytes
      ? { operation: { type: 'insertPages', pagesBytes } }
      : { operation: { type: 'removePages' } }
  } as unknown as HistoryEntry;
}

test('annotationHistoryEntry wraps annotations and signature is stable/among-different', () => {
  const entry = annotationHistoryEntry([stickyNote('a')]);
  assert.equal(entry.kind, 'annotations');

  const sigA = annotationHistorySignature([stickyNote('a')]);
  const sigAAgain = annotationHistorySignature([stickyNote('a')]);
  const sigB = annotationHistorySignature([stickyNote('b')]);
  assert.equal(sigA, sigAAgain);
  assert.notEqual(sigA, sigB);
});

test('normalizeHistoryStack drops junk, keeps valid entries, upgrades legacy arrays', () => {
  const legacyArrayEntry = [stickyNote('legacy')];
  const validEntry = annotationHistoryEntry([stickyNote('valid')]);
  const normalized = normalizeHistoryStack([
    validEntry,
    legacyArrayEntry,
    null,
    42,
    { kind: 'nonsense' }
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0], validEntry);
  assert.equal(normalized[1].kind, 'annotations');
  assert.deepEqual(
    normalized[1].kind === 'annotations' ? normalized[1].annotations : null,
    legacyArrayEntry
  );
});

test('normalizeHistoryStack returns [] for non-array input', () => {
  assert.deepEqual(normalizeHistoryStack(null), []);
  assert.deepEqual(normalizeHistoryStack('nope'), []);
});

test('trimHistoryStack caps total entries at 20 (keeps the most recent)', () => {
  const entries = Array.from({ length: 25 }, (_, index) =>
    annotationHistoryEntry([stickyNote(`n${index}`)])
  );
  const trimmed = trimHistoryStack(entries);
  assert.equal(trimmed.length, 20);
  // The oldest 5 were dropped from the front.
  assert.equal(trimmed[0], entries[5]);
  assert.equal(trimmed[19], entries[24]);
});

test('trimHistoryStack caps document entries at 5, evicting oldest documents first', () => {
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < 7; i += 1) {
    entries.push(documentEntry());
    entries.push(annotationHistoryEntry([stickyNote(`a${i}`)]));
  }
  const trimmed = trimHistoryStack(entries);
  const documentCount = trimmed.filter((entry) => entry.kind === 'document').length;
  assert.equal(documentCount, 5);
});

test('trimHistoryStack enforces the total-bytes cap even when the document-entry count is under its own cap', () => {
  // Regression test: the byte-size trim loop used to be gated behind an early
  // return that only fired once documentEntries > MAX_DOCUMENT_HISTORY_ENTRIES
  // (5), so 3 huge document entries (well under the count cap) could sit
  // comfortably past the 128MB total-bytes budget forever.
  const bigEntry = () => documentEntry(new Uint8Array(50 * 1024 * 1024)); // 50MB
  const entries: HistoryEntry[] = [bigEntry(), bigEntry(), bigEntry()]; // 150MB, 3 <= 5
  const trimmed = trimHistoryStack(entries);

  const totalBytes = trimmed.reduce((total, entry) => {
    return entry.kind === 'document'
      ? total +
          documentHistorySnapshotByteSize(
            (entry as unknown as {
              snapshot: Parameters<typeof documentHistorySnapshotByteSize>[0];
            }).snapshot
          )
      : total;
  }, 0);

  assert.ok(
    totalBytes <= 128 * 1024 * 1024,
    `expected trimmed total (${totalBytes}) to respect the 128MB cap`
  );
  assert.ok(trimmed.length < entries.length, 'expected at least one entry to be evicted');
});

test('documentHistorySnapshotByteSize sums insertPages bytes plus cleanPdfBytes, deduped', () => {
  const shared = new Uint8Array(100);
  const insert = documentEntry(new Uint8Array(40));
  assert.equal(
    documentHistorySnapshotByteSize(
      (insert as unknown as { snapshot: Parameters<typeof documentHistorySnapshotByteSize>[0] })
        .snapshot
    ),
    40
  );

  // Same Uint8Array referenced twice must only count once.
  const snapshotWithShared = {
    operation: { type: 'insertPages', pagesBytes: shared },
    cleanPdfBytes: shared
  } as unknown as Parameters<typeof documentHistorySnapshotByteSize>[0];
  assert.equal(documentHistorySnapshotByteSize(snapshotWithShared), 100);
});
