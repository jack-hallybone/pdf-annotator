import { AnnotationType } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
  boundsForPoints,
  pathLooksClosed,
  rectToQuadPoints
} from './annotationGeometry';
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
  const sourceId = existingAnnotationSourceId(
    annotation,
    pageIndex,
    annotationIndex
  );
  const id = `imported-${pageIndex}-${existingAnnotationId(
    annotation,
    annotationIndex
  )}`;
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

    case AnnotationType.INK: {
      if (!isEditableExistingAnnotation(annotation)) {
        return null;
      }

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
    }

    case AnnotationType.FREETEXT:
      if (!isEditableExistingAnnotation(annotation)) {
        return null;
      }

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
      if (!isEditableExistingAnnotation(annotation)) {
        return null;
      }

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

export function isEditableExistingAnnotation(annotation: ExistingPdfAnnotation) {
  switch (annotation.annotationType) {
    case AnnotationType.HIGHLIGHT:
      return true;

    case AnnotationType.INK:
      return isSimpleInkAnnotation(annotation);

    case AnnotationType.FREETEXT:
      return isSimpleFreeTextAnnotation(annotation);

    case AnnotationType.TEXT:
      return isSimpleStickyNoteAnnotation(annotation);

    default:
      return false;
  }
}

function isSimpleFreeTextAnnotation(annotation: ExistingPdfAnnotation) {
  const text = extractAnnotationText(annotation).trim();
  if (!text || hasComplexFreeTextIntent(annotation)) {
    return false;
  }

  if (
    hasAnyAnnotationProperty(annotation, [
      'callout',
      'calloutLine',
      'calloutLines',
      'calloutPoints',
      'lineCoordinates',
      'vertices'
    ])
  ) {
    return false;
  }

  const borderWidth = firstFiniteNumber(
    annotation.borderStyle?.width,
    annotation.borderStyle?.rawWidth
  );
  if (borderWidth !== null && borderWidth > 0) {
    return false;
  }

  const subject = annotationTextHint(annotation.subject).toLowerCase();
  return !/callout|equation|formula|shape|stamp/.test(subject);
}

function isSimpleStickyNoteAnnotation(annotation: ExistingPdfAnnotation) {
  return extractAnnotationText(annotation).trim().length > 0;
}

function isSimpleInkAnnotation(annotation: ExistingPdfAnnotation) {
  const paths = normalizeInkLists(annotation);
  if (paths.length === 0 || hasComplexInkIntent(annotation)) {
    return false;
  }

  if (isInkHighlight(annotation)) {
    return true;
  }

  return !isAppearanceBackedClosedInk(annotation, paths);
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

  const bounds = boundsForPoints(path);
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

function isAppearanceBackedClosedInk(
  annotation: ExistingPdfAnnotation,
  paths: PdfPoint[][]
) {
  if (!hasNormalAppearance(annotation)) {
    return false;
  }

  const effectiveWidth = firstFiniteNumber(
    annotation.borderStyle?.width,
    annotation.width,
    annotation.thickness
  );
  if (effectiveWidth !== null && effectiveWidth > 0.05) {
    return false;
  }

  return looksLikeClosedAppearanceInk(paths);
}

function looksLikeClosedAppearanceInk(paths: PdfPoint[][]) {
  const closedPaths = paths.filter(
    (path) => path.length >= 4 && pathLooksClosed(path)
  );
  if (closedPaths.length === 0 || closedPaths.length / paths.length < 0.75) {
    return false;
  }

  const points = paths.flat();
  const bounds = boundsForPoints(points);
  const width = Math.abs(bounds.x2 - bounds.x1);
  const height = Math.abs(bounds.y2 - bounds.y1);
  const pointCount = points.length;

  return width >= 6 && height >= 6 && pointCount >= 20;
}

function hasNormalAppearance(annotation: ExistingPdfAnnotation) {
  return Boolean(
    annotation.hasAppearance ||
      annotation.hasOwnCanvas ||
      annotation.appearance ||
      annotation.appearanceData ||
      annotation.appearanceStream ||
      annotation.appearanceRef ||
      annotation.ap ||
      annotation.AP
  );
}

function hasComplexInkIntent(annotation: ExistingPdfAnnotation) {
  const text = [
    annotation.it,
    annotation.intent,
    annotation.annotationIntent,
    annotation.name,
    annotation.subject,
    annotation.title,
    annotation.titleObj?.str,
    annotation.contents,
    annotation.contentsObj?.str
  ]
    .map(annotationTextHint)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /equation|formula|math|stamp|shape|callout|text/.test(text);
}

function hasComplexFreeTextIntent(annotation: ExistingPdfAnnotation) {
  const text = [
    annotation.it,
    annotation.intent,
    annotation.annotationIntent,
    annotation.name,
    annotation.title,
    annotation.titleObj?.str,
    annotation.contents,
    annotation.contentsObj?.str
  ]
    .map(annotationTextHint)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /callout|equation|formula|shape|stamp/.test(text);
}

function hasAnyAnnotationProperty(
  annotation: ExistingPdfAnnotation,
  keys: string[]
) {
  return keys.some((key) => hasAnnotationProperty(annotation, key));
}

function hasAnnotationProperty(annotation: ExistingPdfAnnotation, key: string) {
  const value = annotation[key];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Array.isArray(value) ? value.length > 0 : value.byteLength > 0;
  }

  return value !== undefined && value !== null;
}

function annotationTextHint(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object') {
    const candidate = value as { str?: unknown; text?: unknown };
    if (typeof candidate.str === 'string') {
      return candidate.str;
    }
    if (typeof candidate.text === 'string') {
      return candidate.text;
    }
  }

  return '';
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

function existingAnnotationSourceId(
  annotation: ExistingPdfAnnotation,
  pageIndex: number,
  annotationIndex: number
) {
  return uniqueSourceIdCandidates([
    annotation.id,
    annotation.refName,
    annotation.annotationId,
    annotation.nm,
    annotation.NM,
    annotation.nameObj?.str,
    annotation.nameObj?.text,
    annotationGeometrySourceKey(annotation),
    `page:${pageIndex}:annotation-${annotationIndex}`
  ]).join('|');
}

function annotationGeometrySourceKey(annotation: ExistingPdfAnnotation) {
  const rect = rectSourceKey(annotation.rect);
  if (!rect) {
    return '';
  }

  const subtype = annotationTextHint(annotation.subtype).trim();
  if (!subtype) {
    return '';
  }

  const text = annotationContentsSourceText(annotation).trim();
  return `geom:${subtype.toLowerCase()}:${rect}:${
    text ? textHash(text) : 'empty'
  }`;
}

function annotationContentsSourceText(annotation: ExistingPdfAnnotation) {
  return (
    annotationTextHint(annotation.contentsObj) ||
    annotationTextHint(annotation.contents) ||
    extractAnnotationText(annotation)
  );
}

function rectSourceKey(rect: unknown) {
  if (!Array.isArray(rect) && !(rect instanceof Float32Array)) {
    return '';
  }

  const values = Array.from(rect).slice(0, 4).map(Number);
  if (values.length < 4 || !values.every(Number.isFinite)) {
    return '';
  }

  return normalizedRectValues(values).map(sourceKeyNumber).join(',');
}

function normalizedRectValues(values: number[]) {
  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3])
  ];
}

function sourceKeyNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}

function textHash(text: string) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function uniqueSourceIdCandidates(values: unknown[]) {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const value of values) {
    const text = annotationTextHint(value).trim();
    if (!text) {
      continue;
    }

    const key = text.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push(text);
  }

  return candidates;
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
