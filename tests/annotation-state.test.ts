import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotationSourceIdsForReplacement,
  byteFingerprint
} from '../src/annotator/annotationState';
import type { PdfAnnotation } from '../src/annotator/types';

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
