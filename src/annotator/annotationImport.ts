import { AnnotationType } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfAnnotation, PdfPoint, PdfRect } from './types';

export type ExistingPdfAnnotation = Record<string, any>;

const displayAnnotationCache = new WeakMap<
  PDFPageProxy,
  Promise<ExistingPdfAnnotation[]>
>();

export function getDisplayAnnotations(page: PDFPageProxy) {
  const cached = displayAnnotationCache.get(page);
  if (cached) {
    return cached;
  }

  const annotations = page
    .getAnnotations({ intent: 'display' })
    .then((items) => items as ExistingPdfAnnotation[])
    .catch((error) => {
      displayAnnotationCache.delete(page);
      throw error;
    });
  displayAnnotationCache.set(page, annotations);
  return annotations;
}

export async function importExistingAnnotationsForPage(
  page: PDFPageProxy,
  pageIndex: number
) {
  const annotations = await getDisplayAnnotations(page);
  return annotations
    .map((annotation, annotationIndex) =>
      mapExistingAnnotation(annotation, pageIndex, annotationIndex)
    )
    .filter((annotation): annotation is PdfAnnotation => annotation !== null);
}

function mapExistingAnnotation(
  annotation: ExistingPdfAnnotation,
  pageIndex: number,
  annotationIndex: number
): PdfAnnotation | null {
  const sourceId = existingAnnotationId(annotation, annotationIndex);
  const id = `imported-${pageIndex}-${sourceId}`;
  const color = pdfjsColorToRgb(
    annotation.color ?? annotation.defaultAppearanceData?.fontColor,
    [1, 0.85, 0.15]
  );

  switch (annotation.annotationType) {
    case AnnotationType.HIGHLIGHT: {
      const rects = quadPointsToRects(annotation.quadPoints, annotation.rect);
      if (rects.length === 0) {
        return null;
      }

      return {
        id,
        sourceId,
        kind: 'textHighlight',
        pageIndex,
        rects,
        quadPoints:
          annotation.quadPoints?.length > 0
            ? chunkQuadPoints(annotation.quadPoints)
            : rects.map(rectToQuadPoints),
        color,
        opacity: highlightOpacity(annotation),
        contents: ''
      };
    }

    case AnnotationType.INK:
      const inkLists = normalizeInkLists(annotation);
      if (inkLists.length === 0) {
        return null;
      }

      const inkIsHighlight = isInkHighlight(annotation);
      return {
        id,
        sourceId,
        kind: inkIsHighlight ? 'freehandHighlight' : 'draw',
        pageIndex,
        paths: inkLists,
        color: inkColor(annotation, inkIsHighlight),
        filled:
          inkIsHighlight && inkLists.length > 0 && inkLists.every(pathLooksClosed),
        opacity: inkOpacity(annotation, inkIsHighlight),
        width: inkWidth(annotation, inkIsHighlight),
        contents: ''
      };

    case AnnotationType.FREETEXT:
      const freeTextRect = rectFromArray(annotation.rect);
      if (!freeTextRect) {
        return null;
      }

      return {
        id,
        sourceId,
        kind: 'freeText',
        pageIndex,
        rect: freeTextRect,
        text: extractAnnotationText(annotation),
        fontSize: extractFontSize(annotation),
        color: pdfjsColorToRgb(
          annotation.defaultAppearanceData?.fontColor ?? annotation.color,
          [0.05, 0.2, 0.42]
        ),
        opacity: freeTextOpacity(annotation)
      };

    case AnnotationType.TEXT:
      const noteRect = rectFromArray(annotation.rect);
      if (!noteRect) {
        return null;
      }

      return {
        id,
        sourceId,
        kind: 'stickyNote',
        pageIndex,
        rect: noteRect,
        text: extractAnnotationText(annotation),
        color: pdfjsColorToRgb(annotation.color, [1, 0.9, 0.25])
      };

    default:
      return null;
  }
}

type InkList =
  | number[]
  | Float32Array
  | Array<{
      x: number;
      y: number;
    }>;

export function normalizeInkLists(
  annotation: ExistingPdfAnnotation
): PdfPoint[][] {
  const rawInkLists =
    annotation.inkLists ??
    annotation.inkList ??
    annotation.paths ??
    annotation.path ??
    annotation.outlines?.points;

  if (!rawInkLists) {
    return [];
  }

  if (isFlatNumberList(rawInkLists)) {
    return [pointsArrayToPath(rawInkLists)];
  }

  if (!isIterable(rawInkLists)) {
    return [];
  }

  const lists = Array.from(rawInkLists as Iterable<unknown>);
  return lists
    .map((inkList) =>
      isFlatNumberList(inkList) || isPointObjectList(inkList)
        ? pointsArrayToPath(inkList as InkList)
        : []
    )
    .filter((path) => path.length > 0);
}

function isFlatNumberList(value: unknown): value is number[] | Float32Array {
  if (!isIterable(value)) {
    return false;
  }

  const values = Array.from(value as Iterable<unknown>);
  return values.length > 0 && values.every((item) => typeof item === 'number');
}

function isPointObjectList(
  value: unknown
): value is Array<{ x: number; y: number }> {
  if (!isIterable(value)) {
    return false;
  }

  const values = Array.from(value as Iterable<unknown>);
  return (
    values.length > 0 &&
    values.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        'x' in item &&
        'y' in item
    )
  );
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    Boolean(value) &&
    typeof value !== 'string' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      'function'
  );
}

function highlightOpacity(annotation: ExistingPdfAnnotation) {
  const explicitOpacity = annotation.ca ?? annotation.opacity;
  return typeof explicitOpacity === 'number' && explicitOpacity < 1
    ? clampPdfNumber(explicitOpacity, 0, 1, 0.35)
    : 0.35;
}

function freeTextOpacity(annotation: ExistingPdfAnnotation) {
  const explicitOpacity = annotation.ca ?? annotation.opacity;
  return typeof explicitOpacity === 'number'
    ? clampPdfNumber(explicitOpacity, 0, 1, 1)
    : 1;
}

function rawOpacity(annotation: ExistingPdfAnnotation) {
  const explicitOpacity = annotation.ca ?? annotation.opacity;
  return typeof explicitOpacity === 'number' && Number.isFinite(explicitOpacity)
    ? clampPdfNumber(explicitOpacity, 0, 1, 1)
    : null;
}

function inkOpacity(annotation: ExistingPdfAnnotation, asHighlight = false) {
  const explicitOpacity = rawOpacity(annotation);
  if (explicitOpacity !== null && (!asHighlight || explicitOpacity < 0.95)) {
    return explicitOpacity;
  }

  return asHighlight ? 0.35 : 0.95;
}

function inkWidth(annotation: ExistingPdfAnnotation, asHighlight = false) {
  const explicitWidth = firstFiniteNumber(
    annotation.borderStyle?.rawWidth,
    annotation.borderStyle?.width,
    annotation.width,
    annotation.thickness
  );

  if (explicitWidth !== null) {
    return clampPdfNumber(explicitWidth, 0.1, 72, 1);
  }

  return asHighlight ? 8 : 2.5;
}

function inkColor(
  annotation: ExistingPdfAnnotation,
  asHighlight: boolean
): [number, number, number] {
  const highlightFallback: [number, number, number] = [1, 0.82, 0.12];
  const color = pdfjsColorToRgb(
    annotation.interiorColor ?? annotation.color,
    asHighlight ? highlightFallback : [0.05, 0.2, 0.42]
  );

  if (asHighlight && isNearBlack(color)) {
    return highlightFallback;
  }

  return color;
}

export function isInkHighlight(annotation: ExistingPdfAnnotation) {
  return (
    hasHighlightHint(annotation) ||
    annotation.it === 'InkHighlight' ||
    annotation.intent === 'InkHighlight' ||
    hasHighlightBandPaths(annotation)
  );
}

function hasHighlightBandPaths(annotation: ExistingPdfAnnotation) {
  const paths = normalizeInkLists(annotation);
  return paths.length > 0 && paths.every(pathLooksLikeHighlightBand);
}

function pathLooksLikeHighlightBand(path: PdfPoint[]) {
  if (path.length < 4 || !pathLooksClosed(path)) {
    return false;
  }

  const bounds = boundsForPath(path);
  const width = Math.abs(bounds.x2 - bounds.x1);
  const height = Math.abs(bounds.y2 - bounds.y1);
  const shorterSide = Math.min(width, height);
  const longerSide = Math.max(width, height);

  return (
    longerSide >= 18 &&
    shorterSide >= 3 &&
    longerSide / Math.max(shorterSide, 1) >= 2.2
  );
}

export function pathLooksClosed(path: PdfPoint[]) {
  if (path.length < 4) {
    return false;
  }

  const first = path[0];
  const last = path[path.length - 1];
  const bounds = boundsForPath(path);
  const diagonal = Math.hypot(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1);
  const closingDistance = Math.hypot(first.x - last.x, first.y - last.y);
  return closingDistance <= Math.max(2, diagonal * 0.03);
}

function boundsForPath(path: PdfPoint[]) {
  return path.reduce(
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

function hasHighlightHint(annotation: ExistingPdfAnnotation) {
  const text = [
    annotation.it,
    annotation.intent,
    annotation.subject,
    annotation.name,
    annotation.title,
    annotation.titleObj?.str,
    annotation.contents,
    annotation.contentsObj?.str
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return text.includes('highlight') || text.includes('highlighter');
}

function isNearBlack([r, g, b]: [number, number, number]) {
  return r < 0.08 && g < 0.08 && b < 0.08;
}

function firstFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function extractAnnotationText(annotation: ExistingPdfAnnotation) {
  const textContent = annotation.textContent;
  if (Array.isArray(textContent) && textContent.length > 0) {
    return textContent
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          return item.str ?? item.text ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return (
    annotation.contentsObj?.str ??
    annotation.contents ??
    annotation.titleObj?.str ??
    ''
  );
}

function extractFontSize(annotation: ExistingPdfAnnotation) {
  const fontSize = annotation.defaultAppearanceData?.fontSize;
  if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
    return clampPdfNumber(fontSize, 1, 144, 16);
  }

  const defaultAppearance =
    annotation.defaultAppearance ?? annotation.defaultAppearanceData?.fontSize;
  if (typeof defaultAppearance === 'string') {
    const match = defaultAppearance.match(/\/[^\s]+\s+([0-9.]+)\s+Tf/);
    if (match) {
      return clampPdfNumber(Number(match[1]), 1, 144, 16);
    }
  }

  return 16;
}

export function existingAnnotationId(
  annotation: ExistingPdfAnnotation,
  fallbackIndex = 0
) {
  return String(
    annotation.id ??
      annotation.refName ??
      annotation.annotationId ??
      `annotation-${fallbackIndex}`
  );
}

function quadPointsToRects(quadPoints?: number[], rect?: number[]) {
  if (quadPoints?.length) {
    return chunkQuadPoints(quadPoints)
      .filter((quad) => quad.every(Number.isFinite))
      .map((quad) => ({
        x1: Math.min(quad[0], quad[2], quad[4], quad[6]),
        y1: Math.min(quad[1], quad[3], quad[5], quad[7]),
        x2: Math.max(quad[0], quad[2], quad[4], quad[6]),
        y2: Math.max(quad[1], quad[3], quad[5], quad[7])
      }));
  }

  const fallbackRect = rectFromArray(rect);
  return fallbackRect ? [fallbackRect] : [];
}

function chunkQuadPoints(quadPoints: number[]) {
  return Array.from({ length: Math.floor(quadPoints.length / 8) }, (_, index) =>
    quadPoints.slice(index * 8, index * 8 + 8)
  );
}

function rectToQuadPoints(rect: PdfRect) {
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

function pointsArrayToPath(points: InkList): PdfPoint[] {
  if (isPointObjectList(points)) {
    return points
      .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  const numericPoints = Array.from(points as number[] | Float32Array);
  return Array.from({ length: Math.floor(points.length / 2) }, (_, index) => ({
    x: Number(numericPoints[index * 2]),
    y: Number(numericPoints[index * 2 + 1])
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function rectFromArray(
  rect: number[] | Float32Array | null | undefined
): PdfRect | null {
  if (!rect || rect.length < 4) {
    return null;
  }

  const values = Array.from(rect).slice(0, 4).map(Number);
  if (!values.every(Number.isFinite)) {
    return null;
  }

  return {
    x1: Math.min(values[0], values[2]),
    y1: Math.min(values[1], values[3]),
    x2: Math.max(values[0], values[2]),
    y2: Math.max(values[1], values[3])
  };
}

function pdfjsColorToRgb(
  color: number[] | Uint8ClampedArray | null | undefined,
  fallback: [number, number, number]
): [number, number, number] {
  if (!color || color.length === 0) {
    return fallback;
  }

  const values = Array.from(color).map(Number);
  if (!values.every(Number.isFinite)) {
    return fallback;
  }

  const channels =
    values.length === 1 ? [values[0], values[0], values[0]] : values.slice(0, 3);
  if (channels.length < 3) {
    return fallback;
  }

  const divisor = Math.max(...channels) > 1 ? 255 : 1;
  return [
    clampPdfNumber(channels[0] / divisor, 0, 1, fallback[0]),
    clampPdfNumber(channels[1] / divisor, 0, 1, fallback[1]),
    clampPdfNumber(channels[2] / divisor, 0, 1, fallback[2])
  ];
}

function clampPdfNumber(
  value: number,
  min: number,
  max: number,
  fallback: number
) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}
