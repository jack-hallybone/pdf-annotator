import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotationMatchesEraserScope,
  buildEraserAnnotationIndex,
  queryEraserAnnotationIndex
} from '../src/workspace/eraserGeometry';
import type { PdfAnnotation } from '../src/workspace/types';

function drawAt(id: string, x: number, y: number): PdfAnnotation {
  // A tiny 2x2 ink square centred near (x, y).
  return {
    id,
    kind: 'draw',
    pageIndex: 0,
    color: [0, 0, 0],
    opacity: 1,
    width: 1,
    paths: [
      [
        { x: x - 1, y: y - 1 },
        { x: x + 1, y: y - 1 },
        { x: x + 1, y: y + 1 },
        { x: x - 1, y: y + 1 }
      ]
    ]
  } as PdfAnnotation;
}

function idsNear(index: ReturnType<typeof buildEraserAnnotationIndex>, x: number, y: number) {
  return [...queryEraserAnnotationIndex(index, { x, y })]
    .map((entry) => entry.annotation.id)
    .sort();
}

test('queryEraserAnnotationIndex returns annotations near the point, not far ones', () => {
  const annotations = [drawAt('near', 100, 100), drawAt('far', 5000, 5000)];
  const index = buildEraserAnnotationIndex(annotations, 1, 10);

  assert.deepEqual(idsNear(index, 100, 100), ['near']);
  // A point far from both should hit neither.
  assert.deepEqual(idsNear(index, 2500, 2500), []);
});

test('buildEraserAnnotationIndex skips annotations with non-finite bounds', () => {
  const broken = drawAt('broken', 100, 100);
  (broken as { paths: { x: number; y: number }[][] }).paths = [
    [{ x: Number.NaN, y: 100 }]
  ];
  const index = buildEraserAnnotationIndex([broken], 1, 10);
  // No cells should have been populated for a NaN-bounded annotation.
  assert.equal(index.grid.size, 0);
});

test('a query point near two overlapping annotations returns both, deduped', () => {
  const annotations = [drawAt('a', 100, 100), drawAt('b', 101, 101)];
  const index = buildEraserAnnotationIndex(annotations, 1, 10);
  assert.deepEqual(idsNear(index, 100, 100), ['a', 'b']);
});

test('annotationMatchesEraserScope filters by scope', () => {
  const draw = drawAt('d', 0, 0);
  const highlight = { ...draw, id: 'h', kind: 'freehandHighlight' } as PdfAnnotation;
  const textHighlight = { id: 't', kind: 'textHighlight' } as PdfAnnotation;

  assert.equal(annotationMatchesEraserScope(draw, 'all'), true);
  assert.equal(annotationMatchesEraserScope(draw, 'draw'), true);
  assert.equal(annotationMatchesEraserScope(highlight, 'draw'), false);
  assert.equal(annotationMatchesEraserScope(highlight, 'highlight'), true);
  assert.equal(annotationMatchesEraserScope(textHighlight, 'highlight'), true);
  assert.equal(annotationMatchesEraserScope(draw, 'highlight'), false);
});
