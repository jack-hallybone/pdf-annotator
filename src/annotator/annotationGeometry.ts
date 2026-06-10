import { clamp } from './viewerConfig';
import type { PdfAnnotation, PdfPoint, PdfRect } from './types';

export type InkPathCommand =
  | { point: PdfPoint; type: 'move' }
  | { point: PdfPoint; type: 'line' }
  | { control1: PdfPoint; control2: PdfPoint; point: PdfPoint; type: 'curve' };

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
    if (!next) {
      return Math.hypot(point.x - pathPoint.x, point.y - pathPoint.y) <= threshold;
    }

    if (!pointNearSegmentBounds(point, pathPoint, next, threshold)) {
      return false;
    }

    return distanceToSegment(point, pathPoint, next) <= threshold;
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

export function appendInkPoint(
  path: PdfPoint[],
  point: PdfPoint,
  minDistance: number
) {
  if (!isFinitePoint(point)) {
    return path;
  }

  const previous = path[path.length - 1];
  if (
    previous &&
    Math.hypot(point.x - previous.x, point.y - previous.y) < minDistance
  ) {
    return path;
  }

  return [...path, point];
}

export function simplifyInkPath(path: PdfPoint[], tolerance: number) {
  const points = path.filter(isFinitePoint);
  if (points.length < 3 || tolerance <= 0) {
    return points;
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  simplifyPathSections(points, tolerance, keep);
  return points.filter((_, index) => keep[index] === 1);
}

export function resampleInkPath(path: PdfPoint[], spacing: number) {
  const points = path.filter(isFinitePoint);
  if (points.length < 2 || spacing <= 0) {
    return points;
  }

  const result: PdfPoint[] = [points[0]];
  let previous = points[0];
  let distanceSinceLastSample = 0;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    const segmentLength = Math.hypot(dx, dy);

    if (segmentLength === 0) {
      continue;
    }

    let distanceAlongSegment = spacing - distanceSinceLastSample;
    while (distanceAlongSegment <= segmentLength) {
      const ratio = distanceAlongSegment / segmentLength;
      const sample = {
        x: previous.x + dx * ratio,
        y: previous.y + dy * ratio
      };
      result.push(sample);
      distanceAlongSegment += spacing;
    }

    distanceSinceLastSample =
      segmentLength - (distanceAlongSegment - spacing);
    previous = point;
  }

  const last = points[points.length - 1];
  const current = result[result.length - 1];
  if (current && Math.hypot(last.x - current.x, last.y - current.y) > 0.01) {
    result.push(last);
  }

  return result;
}

export function inkPathCommands(path: PdfPoint[]): InkPathCommand[] {
  const points = path.filter(isFinitePoint);
  if (points.length === 0) {
    return [];
  }

  if (points.length === 1) {
    return [{ point: points[0], type: 'move' }];
  }

  if (points.length === 2) {
    return [
      { point: points[0], type: 'move' },
      { point: points[1], type: 'line' }
    ];
  }

  const visualPoints = relaxInkVisualPoints(points);
  const commands: InkPathCommand[] = [{ point: visualPoints[0], type: 'move' }];
  let current = visualPoints[0];
  let index = 1;
  for (; index < visualPoints.length - 2; index += 1) {
    const end = midpoint(visualPoints[index], visualPoints[index + 1]);
    commands.push(quadraticAsCubic(current, visualPoints[index], end));
    current = end;
  }
  commands.push(
    quadraticAsCubic(current, visualPoints[index], visualPoints[index + 1])
  );

  return commands;
}

export function dotPath(point: PdfPoint, width: number) {
  const radius = Math.max(width, 0.5) / 2;
  return [
    { x: point.x - radius, y: point.y },
    { x: point.x, y: point.y + radius },
    { x: point.x + radius, y: point.y },
    { x: point.x, y: point.y - radius },
    { x: point.x - radius, y: point.y }
  ];
}

export function pathLooksClosed(path: PdfPoint[]) {
  const finitePath = path.filter(isFinitePoint);
  if (finitePath.length < 4) {
    return false;
  }

  const first = finitePath[0];
  const last = finitePath[finitePath.length - 1];
  const bounds = boundsForPoints(finitePath);
  const diagonal = Math.hypot(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1);
  const closingDistance = Math.hypot(first.x - last.x, first.y - last.y);
  return closingDistance <= Math.max(2, diagonal * 0.03);
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

function pointNearSegmentBounds(
  point: PdfPoint,
  start: PdfPoint,
  end: PdfPoint,
  threshold: number
) {
  return (
    point.x >= Math.min(start.x, end.x) - threshold &&
    point.x <= Math.max(start.x, end.x) + threshold &&
    point.y >= Math.min(start.y, end.y) - threshold &&
    point.y <= Math.max(start.y, end.y) + threshold
  );
}

function midpoint(first: PdfPoint, second: PdfPoint): PdfPoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2
  };
}

function relaxInkVisualPoints(points: PdfPoint[]) {
  if (points.length < 4) {
    return points;
  }

  const spacing = medianSegmentLength(points);
  const baseStrength = 0.24;
  const sparseStrength = clamp((spacing - 0.75) / 2.25, 0, 1) * 0.3;
  const strength = baseStrength + sparseStrength;

  let relaxed = points;
  for (let pass = 0; pass < 2; pass += 1) {
    relaxed = relaxInkVisualPass(relaxed, strength);
  }

  return relaxed;
}

function relaxInkVisualPass(points: PdfPoint[], strength: number) {
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) {
      return point;
    }

    const previous = points[index - 1];
    const next = points[index + 1];
    const turnFactor = smoothableTurnFactor(previous, point, next);
    if (turnFactor <= 0) {
      return point;
    }

    const target = midpoint(previous, next);
    const correction = strength * turnFactor;
    return {
      x: point.x + (target.x - point.x) * correction,
      y: point.y + (target.y - point.y) * correction
    };
  });
}

function medianSegmentLength(points: PdfPoint[]) {
  const lengths = points
    .slice(1)
    .map((point, index) =>
      Math.hypot(point.x - points[index].x, point.y - points[index].y)
    )
    .sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)] ?? 0;
}

function smoothableTurnFactor(
  previous: PdfPoint,
  point: PdfPoint,
  next: PdfPoint
) {
  const ax = point.x - previous.x;
  const ay = point.y - previous.y;
  const bx = next.x - point.x;
  const by = next.y - point.y;
  const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (denominator === 0) {
    return 1;
  }

  const cosine = clamp((ax * bx + ay * by) / denominator, -1, 1);
  return clamp((cosine + 0.2) / 1.2, 0, 1);
}

function quadraticAsCubic(
  start: PdfPoint,
  control: PdfPoint,
  end: PdfPoint
): InkPathCommand {
  return {
    control1: {
      x: start.x + (2 / 3) * (control.x - start.x),
      y: start.y + (2 / 3) * (control.y - start.y)
    },
    control2: {
      x: end.x + (2 / 3) * (control.x - end.x),
      y: end.y + (2 / 3) * (control.y - end.y)
    },
    point: end,
    type: 'curve'
  };
}

function simplifyPathSections(
  points: PdfPoint[],
  tolerance: number,
  keep: Uint8Array
) {
  const pendingSections: Array<[number, number]> = [[0, points.length - 1]];

  while (pendingSections.length > 0) {
    const [firstIndex, lastIndex] = pendingSections.pop()!;
    if (lastIndex <= firstIndex + 1) {
      continue;
    }

    let furthestIndex = -1;
    let furthestDistance = 0;
    const start = points[firstIndex];
    const end = points[lastIndex];

    for (let index = firstIndex + 1; index < lastIndex; index += 1) {
      const distance = distanceToSegment(points[index], start, end);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthestIndex = index;
      }
    }

    if (furthestIndex === -1 || furthestDistance <= tolerance) {
      continue;
    }

    keep[furthestIndex] = 1;
    pendingSections.push([firstIndex, furthestIndex], [furthestIndex, lastIndex]);
  }
}

function isFinitePoint(point: PdfPoint) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
