// Pure eraser hit-testing logic, extracted from PdfPageView. The eraser needs
// to answer "which annotations are near this point?" cheaply on every pointer
// move, so it builds a uniform spatial grid of annotation bounds once per
// gesture and queries it per point. None of this touches the DOM or canvas -
// the actual canvas erasing of ink strokes lives with the ink-rendering code,
// since it needs the shared canvas context helpers.
import { annotationBounds } from './annotationGeometry';
import type { PdfAnnotation, PdfPoint, PdfRect } from './types';

export type EraserScope = 'all' | 'draw' | 'highlight';

export type EraserAnnotationIndexEntry = {
  annotation: PdfAnnotation;
  bounds: PdfRect;
};

export type EraserAnnotationIndex = {
  cellSize: number;
  grid: Map<string, EraserAnnotationIndexEntry[]>;
  queryPadding: number;
};

export function buildEraserAnnotationIndex(
  annotations: PdfAnnotation[],
  scale: number,
  eraserWidth: number
): EraserAnnotationIndex {
  const entries = annotations.map((annotation) => ({
    annotation,
    bounds: annotationBounds(annotation)
  }));
  const eraserRadius = Math.max(eraserWidth / 2 / scale, 1 / scale);
  const maxInkPadding = entries.reduce((maxPadding, { annotation }) => {
    if (annotation.kind !== 'draw' && annotation.kind !== 'freehandHighlight') {
      return maxPadding;
    }

    return Math.max(maxPadding, annotation.width * 1.4);
  }, 0);
  const queryPadding = Math.max(eraserRadius, maxInkPadding, 6 / scale);
  const cellSize = Math.max(32 / scale, queryPadding * 2, 16);
  const grid = new Map<string, EraserAnnotationIndexEntry[]>();

  for (const entry of entries) {
    if (!isFiniteRect(entry.bounds)) {
      continue;
    }

    forEachGridCell(entry.bounds, cellSize, queryPadding, (key) => {
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        grid.set(key, [entry]);
      }
    });
  }

  return { cellSize, grid, queryPadding };
}

export function queryEraserAnnotationIndex(
  index: EraserAnnotationIndex,
  point: PdfPoint
) {
  const candidates = new Map<string, EraserAnnotationIndexEntry>();
  const queryBounds = {
    x1: point.x,
    y1: point.y,
    x2: point.x,
    y2: point.y
  };

  forEachGridCell(queryBounds, index.cellSize, index.queryPadding, (key) => {
    for (const entry of index.grid.get(key) ?? []) {
      candidates.set(entry.annotation.id, entry);
    }
  });

  return candidates.values();
}

export function annotationMatchesEraserScope(
  annotation: PdfAnnotation,
  scope: EraserScope
) {
  if (scope === 'all') {
    return true;
  }

  if (scope === 'draw') {
    return annotation.kind === 'draw';
  }

  return (
    annotation.kind === 'textHighlight' ||
    annotation.kind === 'freehandHighlight'
  );
}

function forEachGridCell(
  bounds: PdfRect,
  cellSize: number,
  padding: number,
  callback: (key: string) => void
) {
  const minX = Math.floor((Math.min(bounds.x1, bounds.x2) - padding) / cellSize);
  const maxX = Math.floor((Math.max(bounds.x1, bounds.x2) + padding) / cellSize);
  const minY = Math.floor((Math.min(bounds.y1, bounds.y2) - padding) / cellSize);
  const maxY = Math.floor((Math.max(bounds.y1, bounds.y2) + padding) / cellSize);

  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      callback(`${x}:${y}`);
    }
  }
}

function isFiniteRect(rect: PdfRect) {
  return (
    Number.isFinite(rect.x1) &&
    Number.isFinite(rect.y1) &&
    Number.isFinite(rect.x2) &&
    Number.isFinite(rect.y2)
  );
}
