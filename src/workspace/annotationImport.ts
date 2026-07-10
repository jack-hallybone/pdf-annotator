import { AnnotationType } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef
} from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import {
  boundsForPoints,
  pathLooksClosed,
  rectToQuadPoints,
  rotationFromAppearanceMatrix
} from './annotationGeometry';
import {
  clampPdfNumber,
  normalizedRectValues,
  sourceKeyNumber,
  textHash
} from './annotationSourceKey';
import { MAX_SOURCE_IMAGE_PIXELS } from './imageImport';
import { loadEditablePdf } from './pdfPageOperations';
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

// A sentinel distinct from `null`: `null` means "not one of our editable
// kinds, or intentionally unsupported" (Popups, Links, complex shapes -
// completely normal, most real-world PDFs have plenty). MALFORMED means "this
// looked like one of our editable kinds, but its own data failed the
// validation we apply for data-integrity reasons (bad bit depth, non-identity
// Decode, a BBox/Rect relationship that isn't a pure translate, etc.)" - the
// caller surfaces a heads-up for this case, since it's silently dropped from
// the editable view even though it's preserved untouched in the saved file.
const MALFORMED = Symbol('malformed-annotation');

export async function importExistingAnnotationsForPage(
  page: PDFPageProxy,
  pageIndex: number,
  pdfBytes: Uint8Array
) {
  const annotations = await getDisplayAnnotations(page);
  const mapped = await Promise.all(
    annotations.map((annotation, annotationIndex) =>
      mapExistingAnnotation(annotation, pageIndex, annotationIndex, pdfBytes)
    )
  );
  return {
    annotations: mapped.filter(
      (annotation): annotation is PdfAnnotation =>
        annotation !== null && annotation !== MALFORMED
    ),
    malformedCount: mapped.filter((annotation) => annotation === MALFORMED)
      .length
  };
}

async function mapExistingAnnotation(
  annotation: ExistingPdfAnnotation,
  pageIndex: number,
  annotationIndex: number,
  pdfBytes: Uint8Array
): Promise<PdfAnnotation | null | typeof MALFORMED> {
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

    case AnnotationType.FREETEXT: {
      if (!isEditableExistingAnnotation(annotation)) {
        return null;
      }

      const freeTextRect = rectFromArray(annotation.rect);
      if (!freeTextRect) {
        return null;
      }

      // freeTextAppearance in pdfWriter.ts writes a rotated FreeText the
      // same way imageStampAppearance does (Rect is the rotated on-page
      // footprint, BBox/Matrix hold the un-rotated size + rotation) - reuse
      // the same recovery here so a rotated text box redisplays rotated
      // instead of silently un-rotated. Falls back to the plain Rect/no
      // rotation for annotations that don't match that shape (third-party
      // FreeText, or ours from before rotation existed).
      const appearance = await extractAppearanceRotationAndRect(
        pdfBytes,
        pageIndex,
        annotation
      );

      return {
        id,
        sourceId,
        kind: 'freeText',
        pageIndex,
        rect: appearance?.rect ?? freeTextRect,
        rotation: appearance?.rotation,
        text: extractAnnotationText(annotation),
        fontSize: extractFontSize(annotation),
        color: pdfjsColorToRgb(
          annotation.defaultAppearanceData?.fontColor ?? annotation.color,
          [0.05, 0.2, 0.42]
        ),
        opacity: freeTextOpacity(annotation)
      };
    }

    case AnnotationType.TEXT: {
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
    }

    case AnnotationType.STAMP: {
      if (!isSimpleStampAnnotation(annotation)) {
        return null;
      }

      const stampRect = rectFromArray(annotation.rect);
      if (!stampRect) {
        return MALFORMED;
      }

      const image = await extractStampImage(pdfBytes, pageIndex, annotation);
      if (!image) {
        return MALFORMED;
      }

      return {
        id,
        sourceId,
        kind: 'imageStamp',
        pageIndex,
        rect: image.rect,
        imageData: image.imageData,
        mimeType: 'image/png',
        widthPx: image.widthPx,
        heightPx: image.heightPx,
        rotation: image.rotation
      };
    }

    default:
      return null;
  }
}

function isSimpleStampAnnotation(annotation: ExistingPdfAnnotation) {
  return (
    annotation.hasAppearance === true &&
    !annotation.hasOwnCanvas &&
    !annotation.noHTML
  );
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
  // `/Contents` is the authoritative source text. `textContent` is pdf.js's
  // own re-extraction of whatever got physically drawn in the appearance
  // stream - for our own FreeText output that's our *wrapped* lines, so
  // preferring it here would turn an internal word-wrap point into a
  // permanent literal newline every time a file gets reopened.
  const fromContents = annotation.contentsObj?.str ?? annotation.contents;
  if (typeof fromContents === 'string' && fromContents.length > 0) {
    return fromContents;
  }

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

  return annotation.titleObj?.str ?? '';
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
  const preciseCandidates = uniqueSourceIdCandidates([
    annotation.id,
    annotation.refName,
    annotation.annotationId,
    annotation.nm,
    annotation.NM,
    annotation.nameObj?.str,
    annotation.nameObj?.text
  ]);

  if (preciseCandidates.length > 0) {
    return preciseCandidates.join('|');
  }

  return uniqueSourceIdCandidates([
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

const editablePdfCache = new WeakMap<Uint8Array, Promise<PDFDocument>>();

function getEditablePdf(pdfBytes: Uint8Array) {
  let cached = editablePdfCache.get(pdfBytes);
  if (!cached) {
    cached = loadEditablePdf(pdfBytes);
    editablePdfCache.set(pdfBytes, cached);
  }
  return cached;
}

export type ExtractedStampImage = {
  imageData: string;
  widthPx: number;
  heightPx: number;
  rotation: number;
  rect: PdfRect;
};

export type AppearanceRotationAndRect = {
  formStream: PDFRawStream;
  rect: PdfRect;
  rotation: number;
};

// Reads an annotation's appearance-stream BBox/Matrix and reconstructs the
// un-rotated footprint + rotation this app's writer would have used to
// produce it (see appearanceRotationMatrix/rotatedAnnotationRect in
// annotationGeometry.ts) - shared between the Stamp and FreeText reimport
// cases, since both kinds' appearance streams follow the same convention.
// Returns null whenever the BBox-to-Rect relationship isn't a pure
// translate: this app's own writer always produces one, but a third-party
// tool that scales instead would have its annotation silently mis-sized if
// we trusted this math for it, so the on-page Rect's own dimensions are
// cross-checked against the (possibly rotation-swapped) BBox dimensions
// before anything here is trusted.
export async function extractAppearanceRotationAndRect(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation
): Promise<AppearanceRotationAndRect | null> {
  try {
    const ref = parsePdfJsRef(annotation.id);
    const onPageRect = rectFromArray(annotation.rect);
    if (!ref || !onPageRect) {
      return null;
    }

    const pdfDoc = await getEditablePdf(pdfBytes);
    if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
      return null;
    }

    const annotRef = findMatchingRef(pdfDoc.getPage(pageIndex).node.Annots(), ref);
    if (!annotRef) {
      return null;
    }

    const annotDict = resolve(pdfDoc, pdfDoc.context.lookup(annotRef));
    if (!(annotDict instanceof PDFDict)) {
      return null;
    }

    const apDict = resolve(pdfDoc, annotDict.get(PDFName.of('AP')));
    if (!(apDict instanceof PDFDict)) {
      return null;
    }

    const formStream = resolve(pdfDoc, apDict.get(PDFName.of('N')));
    if (!(formStream instanceof PDFRawStream)) {
      return null;
    }

    const bbox = formStream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
    if (!bbox || bbox.size() < 4) {
      return null;
    }

    const bboxWidth = Math.abs(pdfArrayNumber(bbox, 2) - pdfArrayNumber(bbox, 0));
    const bboxHeight = Math.abs(pdfArrayNumber(bbox, 3) - pdfArrayNumber(bbox, 1));
    if (!(bboxWidth > 0) || !(bboxHeight > 0)) {
      return null;
    }

    const matrix = formStream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
    const rotation = matrix ? rotationFromMatrix(matrix) : 0;
    // A present Matrix that doesn't match any rotation this app's writer
    // produces means we can't safely assume it's unrotated - importing it as
    // editable would risk silently showing/saving it at the wrong
    // orientation, so decline rather than guess.
    if (rotation === null) {
      return null;
    }

    const onPageWidth = Math.abs(onPageRect.x2 - onPageRect.x1);
    const onPageHeight = Math.abs(onPageRect.y2 - onPageRect.y1);
    const rotatedDims =
      rotation === 90 || rotation === 270
        ? { width: bboxHeight, height: bboxWidth }
        : { width: bboxWidth, height: bboxHeight };
    if (
      !nearlyEqual(rotatedDims.width, onPageWidth) ||
      !nearlyEqual(rotatedDims.height, onPageHeight)
    ) {
      return null;
    }

    const centerX = (onPageRect.x1 + onPageRect.x2) / 2;
    const centerY = (onPageRect.y1 + onPageRect.y2) / 2;

    return {
      formStream,
      rotation,
      rect: {
        x1: centerX - bboxWidth / 2,
        x2: centerX + bboxWidth / 2,
        y1: centerY - bboxHeight / 2,
        y2: centerY + bboxHeight / 2
      }
    };
  } catch {
    // Doesn't match this app's own appearance-stream convention (a
    // third-party annotation, or one of ours from before rotation existed) -
    // callers fall back to the plain, unrotated Rect for this.
    return null;
  }
}

function nearlyEqual(a: number, b: number) {
  return Math.abs(a - b) <= 0.5;
}

// pdf.js's Stamp annotation metadata never exposes the appearance stream's
// BBox/Matrix or the embedded image bytes - only the raw PDF structure has
// those, so a re-imported image stamp has to be read back out via pdf-lib
// directly. This only recognizes appearance streams shaped like the ones
// `imageStampAppearance` in pdfWriter.ts writes (a single Image XObject,
// DeviceRGB, one of the four 90-degree-step rotation Matrices); anything
// else falls back to null and the annotation stays a read-only PDF stamp.
export async function extractStampImage(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation
): Promise<ExtractedStampImage | null> {
  try {
    const appearance = await extractAppearanceRotationAndRect(
      pdfBytes,
      pageIndex,
      annotation
    );
    if (!appearance) {
      return null;
    }

    // Already loaded (and cached) inside extractAppearanceRotationAndRect.
    const pdfDoc = await getEditablePdf(pdfBytes);
    const { formStream, rect: stampRect, rotation } = appearance;
    const resources = formStream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const imageKeys = xObjects?.keys() ?? [];
    if (!xObjects || imageKeys.length !== 1) {
      return null;
    }

    const imageStream = resolve(pdfDoc, xObjects.get(imageKeys[0]));
    if (!(imageStream instanceof PDFRawStream)) {
      return null;
    }

    const width = imageStream.dict
      .lookupMaybe(PDFName.of('Width'), PDFNumber)
      ?.asNumber();
    const height = imageStream.dict
      .lookupMaybe(PDFName.of('Height'), PDFNumber)
      ?.asNumber();
    const colorSpace = imageStream.dict
      .lookupMaybe(PDFName.of('ColorSpace'), PDFName)
      ?.decodeText();
    const bitsPerComponent = imageStream.dict
      .lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)
      ?.asNumber();
    if (
      !width ||
      !height ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > MAX_SOURCE_IMAGE_PIXELS ||
      colorSpace !== 'DeviceRGB' ||
      bitsPerComponent !== 8 ||
      !isIdentityOrAbsentDecodeArray(imageStream.dict, 3)
    ) {
      return null;
    }

    const rgbBytes = decodePDFRawStream(imageStream).decode();
    if (rgbBytes.length < width * height * 3) {
      return null;
    }

    const smask = resolve(pdfDoc, imageStream.dict.get(PDFName.of('SMask')));
    const alphaBytes = isValidStampAlphaMask(smask, width, height)
      ? decodePDFRawStream(smask).decode()
      : null;

    const imageData = stampImageToPng(
      rgbBytes,
      alphaBytes && alphaBytes.length >= width * height ? alphaBytes : null,
      width,
      height
    );
    if (!imageData) {
      return null;
    }

    return {
      imageData,
      widthPx: width,
      heightPx: height,
      rotation,
      rect: stampRect
    };
  } catch {
    // The caller treats a null result here as MALFORMED and reports it to
    // the user - no separate technical log needed on top of that.
    return null;
  }
}

function resolve(pdfDoc: PDFDocument, value: unknown) {
  return value instanceof PDFRef ? pdfDoc.context.lookup(value) : value;
}

function pdfArrayNumber(array: PDFArray, index: number) {
  return array.lookupMaybe(index, PDFNumber)?.asNumber() ?? 0;
}

// Our own writer never sets a /Decode array, which defaults to "use the
// samples as-is" (e.g. [0 1 0 1 0 1] for a 3-component DeviceRGB image, or
// [0 1] for a 1-component DeviceGray SMask). A third-party PDF that happens
// to match this app's simple Stamp shape (single DeviceRGB Image XObject,
// FlateDecode) but sets an inverted or otherwise non-identity /Decode would
// have its samples reinterpreted wrong if we ignored it, so this only
// accepts an absent array or one that's explicitly the identity.
function isIdentityOrAbsentDecodeArray(dict: PDFDict, componentCount: number) {
  const decode = dict.lookupMaybe(PDFName.of('Decode'), PDFArray);
  if (!decode) {
    return true;
  }

  if (decode.size() !== componentCount * 2) {
    return false;
  }

  const identity = Array.from({ length: componentCount * 2 }, (_, index) =>
    index % 2
  );
  return identity.every((value, index) => pdfArrayNumber(decode, index) === value);
}

function isValidStampAlphaMask(
  value: unknown,
  width: number,
  height: number
): value is PDFRawStream {
  if (!(value instanceof PDFRawStream)) {
    return false;
  }

  const smaskWidth = value.dict
    .lookupMaybe(PDFName.of('Width'), PDFNumber)
    ?.asNumber();
  const smaskHeight = value.dict
    .lookupMaybe(PDFName.of('Height'), PDFNumber)
    ?.asNumber();
  const bitsPerComponent = value.dict
    .lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)
    ?.asNumber();

  return (
    smaskWidth === width &&
    smaskHeight === height &&
    bitsPerComponent === 8 &&
    isIdentityOrAbsentDecodeArray(value.dict, 1)
  );
}

function rotationFromMatrix(matrix: PDFArray): number | null {
  return rotationFromAppearanceMatrix(
    pdfArrayNumber(matrix, 0),
    pdfArrayNumber(matrix, 1),
    pdfArrayNumber(matrix, 2),
    pdfArrayNumber(matrix, 3)
  );
}

function stampImageToPng(
  rgbBytes: Uint8Array,
  alphaBytes: Uint8Array | null,
  width: number,
  height: number
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = rgbBytes[pixel * 3];
    rgba[pixel * 4 + 1] = rgbBytes[pixel * 3 + 1];
    rgba[pixel * 4 + 2] = rgbBytes[pixel * 3 + 2];
    rgba[pixel * 4 + 3] = alphaBytes ? alphaBytes[pixel] : 255;
  }

  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  const base64Index = dataUrl.indexOf(',');
  return base64Index < 0 ? null : dataUrl.slice(base64Index + 1);
}

function parsePdfJsRef(id: unknown) {
  if (typeof id !== 'string') {
    return null;
  }

  const match = /^(\d+)R(\d*)$/.exec(id);
  if (!match) {
    return null;
  }

  return {
    objectNumber: Number(match[1]),
    generationNumber: match[2] ? Number(match[2]) : 0
  };
}

function findMatchingRef(
  annots: PDFArray | undefined,
  ref: { objectNumber: number; generationNumber: number }
) {
  if (!annots) {
    return null;
  }

  for (let index = 0; index < annots.size(); index += 1) {
    const entry = annots.get(index);
    if (
      entry instanceof PDFRef &&
      entry.objectNumber === ref.objectNumber &&
      entry.generationNumber === ref.generationNumber
    ) {
      return entry;
    }
  }

  return null;
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
