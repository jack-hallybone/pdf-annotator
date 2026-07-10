import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotationSourceIdsForReplacement,
  byteFingerprint,
  groupAnnotationsByPageStable
} from '../src/workspace/annotationState';
import type { PdfAnnotation } from '../src/workspace/types';

function stickyNote(id: string, pageIndex: number): PdfAnnotation {
  return {
    color: [1, 0.9, 0.25],
    id,
    kind: 'stickyNote',
    pageIndex,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: ''
  };
}

test('replacement keys include original source IDs and app-written annotation IDs', () => {
  const editedImportedNote: PdfAnnotation = {
    color: [1, 0.9, 0.25],
    id: 'imported-0-note-1',
    kind: 'stickyNote',
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    sourceId: '12 0 R|original-note',
    text: 'edited note'
  };

  const keys = annotationSourceIdsForReplacement(
    [editedImportedNote],
    new Set(),
    [editedImportedNote]
  );

  assert.equal(keys.has('12 0 R|original-note'), true);
  assert.equal(keys.has('imported-0-note-1'), true);
});

test('removed replacement keys are ignored when that annotation is present again', () => {
  const restoredNote: PdfAnnotation = {
    color: [1, 0.9, 0.25],
    id: 'imported-0-note-1',
    kind: 'stickyNote',
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    sourceId: '12 0 R|original-note',
    text: 'restored note'
  };

  const keys = annotationSourceIdsForReplacement(
    [],
    new Set(['12 0 R|original-note', 'imported-0-note-1']),
    [restoredNote]
  );

  assert.deepEqual(Array.from(keys), []);
});

test('empty current annotations request removal by source ID and app ID', () => {
  const emptyImportedNote: PdfAnnotation = {
    color: [1, 0.9, 0.25],
    id: 'imported-0-note-1',
    kind: 'stickyNote',
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    sourceId: '12 0 R|original-note',
    text: ''
  };

  const keys = annotationSourceIdsForReplacement(
    [],
    new Set(),
    [],
    [emptyImportedNote]
  );

  assert.equal(keys.has('12 0 R|original-note'), true);
  assert.equal(keys.has('imported-0-note-1'), true);
});

test('byte fingerprints include changes outside sampled ranges', () => {
  const left = new Uint8Array(200_000).fill(65);
  const right = left.slice();
  right[100_003] = 66;

  assert.notEqual(byteFingerprint(left), byteFingerprint(right));
});

test('groupAnnotationsByPageStable reuses unaffected pages by reference', () => {
  const page0a = stickyNote('a', 0);
  const page0b = stickyNote('b', 0);
  const page1a = stickyNote('c', 1);
  const cache = new Map<number, PdfAnnotation[]>();

  const first = groupAnnotationsByPageStable([page0a, page0b, page1a], cache);
  const firstPage0 = first.get(0);
  const firstPage1 = first.get(1);

  const editedPage0b = { ...page0b, text: 'edited' };
  const second = groupAnnotationsByPageStable(
    [page0a, editedPage0b, page1a],
    cache
  );

  assert.notEqual(second.get(0), firstPage0, 'edited page gets a new bucket');
  assert.equal(second.get(1), firstPage1, 'untouched page reuses its bucket');
});

test('groupAnnotationsByPageStable does not reuse a bucket when its length changes', () => {
  const page0a = stickyNote('a', 0);
  const page1a = stickyNote('b', 1);
  const cache = new Map<number, PdfAnnotation[]>();

  const first = groupAnnotationsByPageStable([page0a, page1a], cache);
  const firstPage1 = first.get(1);

  const page1NewAnnotation = stickyNote('c', 1);
  const second = groupAnnotationsByPageStable(
    [page0a, page1a, page1NewAnnotation],
    cache
  );

  assert.notEqual(
    second.get(1),
    firstPage1,
    'page with an added annotation gets a new bucket'
  );
  assert.equal(second.get(1)?.length, 2);
});

test('groupAnnotationsByPageStable drops pages that lose all their annotations', () => {
  const page0a = stickyNote('a', 0);
  const page1a = stickyNote('b', 1);
  const cache = new Map<number, PdfAnnotation[]>();

  groupAnnotationsByPageStable([page0a, page1a], cache);
  const second = groupAnnotationsByPageStable([page0a], cache);

  assert.equal(second.has(1), false);
  assert.equal(cache.has(1), false);
});

test('groupAnnotationsByPageStable stays stable across repeated calls with no changes', () => {
  const page0a = stickyNote('a', 0);
  const page1a = stickyNote('b', 1);
  const cache = new Map<number, PdfAnnotation[]>();

  const first = groupAnnotationsByPageStable([page0a, page1a], cache);
  const second = groupAnnotationsByPageStable([page0a, page1a], cache);
  const third = groupAnnotationsByPageStable([page0a, page1a], cache);

  assert.equal(second.get(0), first.get(0));
  assert.equal(second.get(1), first.get(1));
  assert.equal(third.get(0), first.get(0));
  assert.equal(third.get(1), first.get(1));
});
