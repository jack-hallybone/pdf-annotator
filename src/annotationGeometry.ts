import { clamp } from './viewerConfig';
import type { PdfAnnotation, PdfPoint, PdfRect } from './types';

export function rectToQuadPoints(rect: PdfRect) {
  return [
    rect.x1,
    rect.y2,
    rect.x2,
    rect.y2,
    rect.x1,
    rect.y1,
    rect.x2,
    rect.y1
  ];
}

export function nearestRectIndex(rects: PdfRect[], point: PdfPoint) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  rects.forEach((rect, index) => {
    const y = clamp(point.y, Math.min(rect.y1, rect.y2), Math.max(rect.y1, rect.y2));
    const x = clamp(point.x, Math.min(rect.x1, rect.x2), Math.max(rect.x1, rect.x2));
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function moveAnnotation(
  annotation: PdfAnnotation,
  delta: PdfPoint
): PdfAnnotation {
  switch (annotation.kind) {
    case 'textHighlight': {
      const rects = annotation.rects.map((rect) => moveRect(rect, delta));
      return {
        ...annotation,
        rects,
        quadPoints: annotation.quadPoints.map((quad) =>
          quad.map((value, index) => value + (index % 2 === 0 ? delta.x : delta.y))
        )
      };
    }

    case 'draw':
    case 'freehandHighlight':
      return {
        ...annotation,
        paths: annotation.paths.map((path) =>
          path.map((point) => ({
            x: point.x + delta.x,
            y: point.y + delta.y
          }))
        )
      };

    case 'freeText':
    case 'stickyNote':
      return {
        ...annotation,
        rect: moveRect(annotation.rect, delta)
      };
  }
}

function moveRect(rect: PdfRect, delta: PdfPoint): PdfRect {
  return {
    x1: rect.x1 + delta.x,
    y1: rect.y1 + delta.y,
    x2: rect.x2 + delta.x,
    y2: rect.y2 + delta.y
  };
}

export function annotationBounds(annotation: PdfAnnotation): PdfRect {
  switch (annotation.kind) {
    case 'textHighlight':
      return boundsForRects(annotation.rects);

    case 'draw':
    case 'freehandHighlight':
      return boundsForPointPaths(annotation.paths);

    case 'freeText':
    case 'stickyNote':
      return annotation.rect;
  }
}

export function boundsForRects(rects: PdfRect[]): PdfRect {
  return rects.reduce(
    (bounds, rect) => ({
      x1: Math.min(bounds.x1, rect.x1, rect.x2),
      y1: Math.min(bounds.y1, rect.y1, rect.y2),
      x2: Math.max(bounds.x2, rect.x1, rect.x2),
      y2: Math.max(bounds.y2, rect.y1, rect.y2)
    }),
    {
      x1: Number.POSITIVE_INFINITY,
      y1: Number.POSITIVE_INFINITY,
      x2: Number.NEGATIVE_INFINITY,
      y2: Number.NEGATIVE_INFINITY
    }
  );
}

export function boundsForPoints(points: PdfPoint[]): PdfRect {
  return points.reduce(
    (bounds, point) => ({
      x1: Math.min(bounds.x1, point.x),
      y1: Math.min(bounds.y1, point.y),
      x2: Math.max(bounds.x2, point.x),
      y2: Math.max(bounds.y2, point.y)
    }),
    {
      x1: Number.POSITIVE_INFINITY,
      y1: Number.POSITIVE_INFINITY,
      x2: Number.NEGATIVE_INFINITY,
      y2: Number.NEGATIVE_INFINITY
    }
  );
}

function boundsForPointPaths(paths: PdfPoint[][]): PdfRect {
  const bounds = {
    x1: Number.POSITIVE_INFINITY,
    y1: Number.POSITIVE_INFINITY,
    x2: Number.NEGATIVE_INFINITY,
    y2: Number.NEGATIVE_INFINITY
  };

  for (const path of paths) {
    for (const point of path) {
      bounds.x1 = Math.min(bounds.x1, point.x);
      bounds.y1 = Math.min(bounds.y1, point.y);
      bounds.x2 = Math.max(bounds.x2, point.x);
      bounds.y2 = Math.max(bounds.y2, point.y);
    }
  }

  return bounds;
}

export function annotationHitTest(
  annotation: PdfAnnotation,
  point: PdfPoint,
  scale: number
) {
  if (annotation.kind === 'draw' || annotation.kind === 'freehandHighlight') {
    const threshold = Math.max(annotation.width * 1.4, 8 / scale);
    return annotation.paths.some((path) => pathHitTest(path, point, threshold));
  }

  const bounds = annotationBounds(annotation);
  const padding = 6 / scale;
  return (
    point.x >= bounds.x1 - padding &&
    point.x <= bounds.x2 + padding &&
    point.y >= bounds.y1 - padding &&
    point.y <= bounds.y2 + padding
  );
}

export function annotationWhollyInsidePolygon(
  annotation: PdfAnnotation,
  polygon: PdfPoint[]
) {
  if (polygon.length < 3) {
    return false;
  }

  if (annotation.kind === 'draw' || annotation.kind === 'freehandHighlight') {
    return pathsWhollyInsidePolygon(annotation.paths, polygon);
  }

  const bounds = annotationBounds(annotation);
  return [
    { x: bounds.x1, y: bounds.y1 },
    { x: bounds.x1, y: bounds.y2 },
    { x: bounds.x2, y: bounds.y1 },
    { x: bounds.x2, y: bounds.y2 }
  ].every((point) => pointInPolygon(point, polygon));
}

export function isLassoSelectableAnnotation(annotation: PdfAnnotation) {
  return annotation.kind === 'draw' || annotation.kind === 'freehandHighlight';
}

function pointInPolygon(point: PdfPoint, polygon: PdfPoint[]) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pathsWhollyInsidePolygon(paths: PdfPoint[][], polygon: PdfPoint[]) {
  for (const path of paths) {
    for (const point of path) {
      if (!pointInPolygon(point, polygon)) {
        return false;
      }
    }
  }

  return true;
}

export function pathHitTest(path: PdfPoint[], point: PdfPoint, threshold: number) {
  return path.some((pathPoint, index) => {
    const next = path[index + 1];
    return next
      ? distanceToSegment(point, pathPoint, next) <= threshold
      : Math.hypot(point.x - pathPoint.x, point.y - pathPoint.y) <= threshold;
  });
}

export function pathLength(path: PdfPoint[]) {
  return path.reduce((length, point, index) => {
    const previous = path[index - 1];
    return previous
      ? length + Math.hypot(point.x - previous.x, point.y - previous.y)
      : length;
  }, 0);
}

export function smoothPath(path: PdfPoint[]) {
  if (path.length < 4) {
    return path;
  }

  const smoothed: PdfPoint[] = [path[0]];
  for (let index = 1; index < path.length - 1; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    const next = path[index + 1];
    smoothed.push({
      x: previous.x * 0.18 + current.x * 0.64 + next.x * 0.18,
      y: previous.y * 0.18 + current.y * 0.64 + next.y * 0.18
    });
  }
  smoothed.push(path[path.length - 1]);
  return smoothed;
}

export function dotPath(point: PdfPoint, width: number) {
  const radius = Math.max(width, 1.5) / 2;
  return [
    { x: point.x - radius, y: point.y },
    { x: point.x, y: point.y + radius },
    { x: point.x + radius, y: point.y },
    { x: point.x, y: point.y - radius },
    { x: point.x - radius, y: point.y }
  ];
}

function distanceToSegment(point: PdfPoint, start: PdfPoint, end: PdfPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    0,
    1
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
