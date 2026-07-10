import { clamp } from './viewerConfig';
import { FREE_TEXT_MAX_WIDTH, FREE_TEXT_MIN_WIDTH } from './freeTextLayout';
import type { PdfAnnotation, PdfPoint, PdfRect } from './types';

export type InkPathCommand =
  | { point: PdfPoint; type: 'move' }
  | { point: PdfPoint; type: 'line' }
  | { control1: PdfPoint; control2: PdfPoint; point: PdfPoint; type: 'curve' };

export type ImageStampResizeHandleKind =
  | 'bottom-left'
  | 'bottom-right'
  | 'top-left'
  | 'top-right';

export function resizeFreeTextWidth(
  annotation: Extract<PdfAnnotation, { kind: 'freeText' }>,
  point: PdfPoint,
  handle: 'left' | 'right'
) {
  const rotation = annotation.rotation ?? 0;
  // `annotation.rect` is always the rotated on-page footprint (width/height
  // swapped for 90/270, per rotatedAnnotationRect's convention) - the resize
  // math below assumes an un-rotated rect, so it needs the local (un-rotated)
  // bounds, not the on-page ones. rotatedAnnotationRect is its own inverse
  // here (swapping width/height back undoes the earlier swap), so reusing it
  // recovers the local rect without a separate function.
  const localRect = rotatedAnnotationRect(annotation.rect, rotation);
  const localPoint = unrotatePointForAnnotation(point, annotation.rect, rotation);
  const left = Math.min(localRect.x1, localRect.x2);
  const right = Math.max(localRect.x1, localRect.x2);
  const top = Math.max(localRect.y1, localRect.y2);
  const bottom = Math.min(localRect.y1, localRect.y2);

  if (handle === 'left') {
    const nextLeft = clamp(
      localPoint.x,
      right - FREE_TEXT_MAX_WIDTH,
      right - FREE_TEXT_MIN_WIDTH
    );
    return {
      ...annotation,
      layoutWidth: right - nextLeft,
      rect: rotatedAnnotationRect(
        { x1: nextLeft, y1: bottom, x2: right, y2: top },
        rotation
      )
    };
  }

  const nextRight = clamp(
    localPoint.x,
    left + FREE_TEXT_MIN_WIDTH,
    left + FREE_TEXT_MAX_WIDTH
  );
  return {
    ...annotation,
    layoutWidth: nextRight - left,
    rect: rotatedAnnotationRect(
      { x1: left, y1: bottom, x2: nextRight, y2: top },
      rotation
    )
  };
}

export function resizeImageStampRect(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>,
  point: PdfPoint,
  handle: ImageStampResizeHandleKind,
  scale: number
) {
  const rotation = annotation.rotation ?? 0;
  // See resizeFreeTextWidth's comment - the resize math here assumes an
  // un-rotated rect, so it works in the local (un-rotated) frame throughout
  // and only converts back to the on-page footprint at the very end.
  const rect = rotatedAnnotationRect(annotation.rect, rotation);
  const localPoint = unrotatePointForAnnotation(
    point,
    annotation.rect,
    rotation
  );
  const aspectRatio = imageStampAspectRatio(annotation);
  const minSize = Math.max(4, 12 / scale);
  const anchors = {
    'top-left': { x: rect.x2, y: rect.y1 },
    'top-right': { x: rect.x1, y: rect.y1 },
    'bottom-left': { x: rect.x2, y: rect.y2 },
    'bottom-right': { x: rect.x1, y: rect.y2 }
  };
  const anchor = anchors[handle];
  const requestedWidth = Math.max(minSize, Math.abs(localPoint.x - anchor.x));
  const requestedHeight = Math.max(minSize, Math.abs(localPoint.y - anchor.y));
  const width = Math.max(requestedWidth, requestedHeight * aspectRatio);
  const height = width / aspectRatio;
  const right = handle.endsWith('right');
  const top = handle.startsWith('top');
  const x1 = right ? anchor.x : anchor.x - width;
  const x2 = right ? anchor.x + width : anchor.x;
  const y1 = top ? anchor.y : anchor.y - height;
  const y2 = top ? anchor.y + height : anchor.y;

  return {
    ...annotation,
    rect: rotatedAnnotationRect(normalizedRect({ x1, x2, y1, y2 }), rotation)
  };
}

export function resizeImageStampToWidth(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>,
  width: number
) {
  const rect = annotation.rect;
  const nextWidth = Math.max(1, width);
  const height = nextWidth / imageStampAspectRatio(annotation);
  return {
    ...annotation,
    rect: {
      ...rect,
      x2: rect.x1 + nextWidth,
      y1: rect.y2 - height
    }
  };
}

export function resizeImageStampToHeight(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>,
  height: number
) {
  const rect = annotation.rect;
  const nextHeight = Math.max(1, height);
  const width = nextHeight * imageStampAspectRatio(annotation);
  return {
    ...annotation,
    rect: {
      ...rect,
      x2: rect.x1 + width,
      y1: rect.y2 - nextHeight
    }
  };
}

export function imageStampAspectRatio(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>
) {
  return Math.max(0.01, annotation.widthPx / Math.max(1, annotation.heightPx));
}

export function normalizedRect(rect: PdfRect): PdfRect {
  return {
    x1: Math.min(rect.x1, rect.x2),
    y1: Math.min(rect.y1, rect.y2),
    x2: Math.max(rect.x1, rect.x2),
    y2: Math.max(rect.y1, rect.y2)
  };
}

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
    case 'imageStamp':
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

    // `rect` always stores the un-rotated footprint for these two kinds -
    // rotatedAnnotationRect returns the actual on-screen footprint, which is
    // what every caller of annotationBounds needs (hit-testing, the eraser's
    // spatial index, lasso containment, page-membership/scroll-to checks).
    case 'freeText':
    case 'imageStamp':
      return rotatedAnnotationRect(annotation.rect, annotation.rotation ?? 0);

    case 'stickyNote':
      return annotation.rect;
  }
}

// The four appearance-stream rotation matrices this app's writer can
// produce (the [a b c d] part; translation depends on the local width/height
// and is applied separately below), keyed by clockwise degrees. Kept as one
// literal table so the write side (pdfWriter.ts's appearanceRotationMatrix)
// and the reverse lookup used on reimport (annotationImport.ts's
// rotationFromMatrix) can never drift out of sync with each other - adding a
// rotation option only ever means editing this one table.
const ROTATION_APPEARANCE_MATRIX_ABCD: Record<
  number,
  [number, number, number, number]
> = {
  0: [1, 0, 0, 1],
  90: [0, -1, 1, 0],
  180: [-1, 0, 0, -1],
  270: [0, 1, -1, 0]
};

// Builds the full 6-entry Form XObject /Matrix for a given rotation, given
// the appearance's local (un-rotated) width/height - matches the PDF spec's
// "rotate BBox content, then translate so the transformed BBox lands back at
// the origin" requirement so the viewer's automatic BBox-to-Rect fit is a
// pure translate, never an unwanted rescale.
export function appearanceRotationMatrix(
  rotation: number,
  width: number,
  height: number
): number[] {
  const normalized = ((rotation % 360) + 360) % 360;
  const abcd = ROTATION_APPEARANCE_MATRIX_ABCD[normalized] ?? ROTATION_APPEARANCE_MATRIX_ABCD[0];
  switch (normalized) {
    case 90:
      return [...abcd, 0, width];
    case 180:
      return [...abcd, width, height];
    case 270:
      return [...abcd, height, 0];
    default:
      return [...abcd, 0, 0];
  }
}

// Inverse of appearanceRotationMatrix's [a b c d] part: given the four
// leading Matrix entries (already rounded to the nearest integer, since
// pdf-lib round-trips these as plain numbers with no meaningful drift for
// this app's own output), returns which rotation produced them, or `null`
// if the matrix doesn't match any of the four this app ever writes. `null`
// is deliberately distinct from `0` - a present-but-unrecognized Matrix
// means the caller can't safely assume any particular rotation and should
// decline to import rather than silently guessing unrotated.
export function rotationFromAppearanceMatrix(
  a: number,
  b: number,
  c: number,
  d: number
): number | null {
  const roundedA = Math.round(a);
  const roundedB = Math.round(b);
  const roundedC = Math.round(c);
  const roundedD = Math.round(d);

  for (const [rotation, abcd] of Object.entries(ROTATION_APPEARANCE_MATRIX_ABCD)) {
    if (
      abcd[0] === roundedA &&
      abcd[1] === roundedB &&
      abcd[2] === roundedC &&
      abcd[3] === roundedD
    ) {
      return Number(rotation);
    }
  }

  return null;
}

function rotationTrig(rotation: number) {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { cos: 0, sin: 1 };
    case 180:
      return { cos: -1, sin: 0 };
    case 270:
      return { cos: 0, sin: -1 };
    default:
      return { cos: 1, sin: 0 };
  }
}

// A freeText/imageStamp annotation's own `rotation` field spins its content
// independently of the page - `rect` always stores the un-rotated (reading
// direction) footprint. This returns the on-screen footprint after that spin:
// unchanged at 0/180, width/height swapped around the same center at 90/270.
export function rotatedAnnotationRect(rect: PdfRect, rotation: number): PdfRect {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized !== 90 && normalized !== 270) {
    return rect;
  }

  const width = Math.abs(rect.x2 - rect.x1);
  const height = Math.abs(rect.y2 - rect.y1);
  const cx = (rect.x1 + rect.x2) / 2;
  const cy = (rect.y1 + rect.y2) / 2;
  return {
    x1: cx - height / 2,
    x2: cx + height / 2,
    y1: cy - width / 2,
    y2: cy + width / 2
  };
}

// Converts a point from "as displayed" (post-rotation) space back into the
// annotation's own local/un-rotated space, so existing left/right or corner
// resize math (written assuming no rotation) keeps working unchanged. PDF
// space is Y-up while the on-screen rotation is clockwise in Y-down screen
// space, so undoing it here uses the standard (Y-up, counterclockwise-positive)
// rotation formula with the angle taken as-is, not negated.
export function unrotatePointForAnnotation(
  point: PdfPoint,
  rect: PdfRect,
  rotation: number
): PdfPoint {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 0) {
    return point;
  }

  const { cos, sin } = rotationTrig(normalized);
  const cx = (rect.x1 + rect.x2) / 2;
  const cy = (rect.y1 + rect.y2) / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos
  };
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
