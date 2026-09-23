import { AnnotationType } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} from "pdf-lib";
import type { PDFDocument } from "pdf-lib";
import { uint8ArrayToArrayBuffer } from "../bytes";
import {
  boundsForPoints,
  pathLooksClosed,
  rectToQuadPoints,
  rotationFromAppearanceMatrix,
} from "./annotationGeometry";
import { ANNOTATION_BOOKMARK_KEY } from "./annotationBookmarkKey";
import { normalizeAnnotationComment } from "./annotationComments";
import { strippedDocumentText } from "./untrustedText";
import {
  DIRECT_SOURCE_ID_PREFIX,
  clampPdfNumber,
  directSourceId,
  unresolvedSourceId,
} from "./annotationSourceKey";
import { loadEditablePdf } from "./pdfPageOperations";
import type { PdfAnnotation, PdfPoint, PdfRect } from "./types";

// Each annotation subtype has a different runtime shape; every field is
// validated below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    .getAnnotations({ intent: "display" })
    .then((items) => items as ExistingPdfAnnotation[])
    .catch((error) => {
      displayAnnotationCache.delete(page);
      throw error;
    });
  displayAnnotationCache.set(page, annotations);
  return annotations;
}

// An editable kind that failed validation, distinct from `null`, which means
// "not an editable kind".
const MALFORMED = Symbol("malformed-annotation");

const editableAnnotationTypes = new Set<number>([
  AnnotationType.FREETEXT,
  AnnotationType.HIGHLIGHT,
  AnnotationType.INK,
  AnnotationType.STAMP,
  AnnotationType.TEXT,
]);

// At 3-6 bytes of heap per character, roughly 30 MiB of note text, beside the
// 128 MiB of file bytes the app already accepts.
export const MAX_DOCUMENT_ANNOTATION_TEXT_CHARACTERS = 8_000_000;

// Returns as soon as the total passes `budget`, so the number means "at least
// this many" and the walk never holds more than roughly `budget` characters.
export async function annotationTextCharacters(
  pdf: PDFDocumentProxy,
  budget: number,
) {
  let characters = 0;
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex + 1);
    try {
      const annotations = (await page.getAnnotations({
        intent: "display",
      })) as ExistingPdfAnnotation[];
      for (const annotation of annotations) {
        if (editableAnnotationTypes.has(annotation.annotationType)) {
          characters += rawAnnotationText(annotation).length;
        }
      }
    } finally {
      page.cleanup();
    }

    if (characters > budget) {
      return characters;
    }
  }

  return characters;
}

// Imported stamps are retained as PNG/base64 in annotation state, so these stay
// well below the general file-image preflight ceiling.
const MAX_EDITABLE_STAMP_PIXELS = 4_000_000;
const MAX_EDITABLE_STAMP_PIXELS_PER_DOCUMENT = 12_000_000;
const MAX_ENCODED_STAMP_STREAM_BYTES = 16 * 1024 * 1024;
type ImportedStampBudget = {
  pixelsByKey: Map<string, number>;
  totalPixels: number;
};
const importedStampBudgets = new WeakMap<Uint8Array, ImportedStampBudget>();
let stampDecodeQueue: Promise<void> = Promise.resolve();

export async function importExistingAnnotationsForPage(
  page: PDFPageProxy,
  pageIndex: number,
  pdfBytes: Uint8Array,
) {
  const annotations = await getDisplayAnnotations(page);
  // Sequential on purpose: a stamp import owns decoded RGB, RGBA, canvas and
  // base64 buffers at once, and mapping in parallel multiplies that peak.
  const mapped: Array<PdfAnnotation | null | typeof MALFORMED> = [];
  for (const [annotationIndex, annotation] of annotations.entries()) {
    mapped.push(
      await mapExistingAnnotation(
        annotation,
        pageIndex,
        annotationIndex,
        pdfBytes,
      ),
    );
  }
  return {
    annotations: mapped.filter(
      (annotation): annotation is PdfAnnotation =>
        annotation !== null && annotation !== MALFORMED,
    ),
    malformedCount: mapped.filter((annotation) => annotation === MALFORMED)
      .length,
  };
}

async function mapExistingAnnotation(
  annotation: ExistingPdfAnnotation,
  pageIndex: number,
  annotationIndex: number,
  pdfBytes: Uint8Array,
): Promise<PdfAnnotation | null | typeof MALFORMED> {
  const sourceId = await confirmedAnnotationSourceId(
    pdfBytes,
    annotation,
    pageIndex,
    annotationIndex,
  );
  const id = `imported-${pageIndex}-${existingAnnotationId(annotation, annotationIndex)}`;
  const color = pdfjsColorToRgb(
    annotation.color ?? annotation.defaultAppearanceData?.fontColor,
    [1, 0.85, 0.15],
  );
  // Only for the kinds the switch below maps: reading it walks the raw /Annots.
  const bookmarkFlag =
    editableAnnotationTypes.has(annotation.annotationType) &&
    (await extractAnnotationBookmark(
      pdfBytes,
      pageIndex,
      annotation,
      annotationIndex,
    ))
      ? { bookmarked: true as const }
      : {};

  switch (annotation.annotationType) {
    case AnnotationType.HIGHLIGHT: {
      const rects = quadPointsToRects(annotation.quadPoints, annotation.rect);
      if (rects.length === 0) {
        return null;
      }

      return {
        id,
        sourceId,
        ...bookmarkFlag,
        kind: "textHighlight",
        pageIndex,
        rects,
        quadPoints:
          annotation.quadPoints?.length > 0
            ? chunkQuadPoints(annotation.quadPoints)
            : rects.map(rectToQuadPoints),
        color,
        opacity: highlightOpacity(annotation),
        comment: extractAnnotationComment(annotation),
        coveredText: extractOverlaidText(annotation),
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
        ...bookmarkFlag,
        kind: inkIsHighlight ? "freehandHighlight" : "draw",
        pageIndex,
        paths: inkLists,
        color: inkColor(annotation, inkIsHighlight),
        filled:
          inkIsHighlight &&
          inkLists.length > 0 &&
          inkLists.every(pathLooksClosed),
        opacity: inkOpacity(annotation, inkIsHighlight),
        width: inkWidth(annotation, inkIsHighlight),
        comment: extractAnnotationComment(annotation),
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

      // Recovers the rotation freeTextAppearance wrote; null for anything that
      // does not match that shape, which falls back to the plain Rect.
      const appearance = await extractAppearanceRotationAndRect(
        pdfBytes,
        pageIndex,
        annotation,
        annotationIndex,
      );

      return {
        id,
        sourceId,
        ...bookmarkFlag,
        kind: "freeText",
        pageIndex,
        rect: appearance?.rect ?? freeTextRect,
        rotation: appearance?.rotation,
        text: extractAnnotationText(annotation),
        fontSize: extractFontSize(annotation),
        color: pdfjsColorToRgb(
          annotation.defaultAppearanceData?.fontColor ?? annotation.color,
          [0.05, 0.2, 0.42],
        ),
        opacity: freeTextOpacity(annotation),
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
        ...bookmarkFlag,
        kind: "stickyNote",
        pageIndex,
        rect: noteRect,
        text: extractAnnotationText(annotation),
        color: pdfjsColorToRgb(annotation.color, [1, 0.9, 0.25]),
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

      const image = await extractStampImage(
        pdfBytes,
        pageIndex,
        annotation,
        `${pageIndex}:${annotationIndex}:${sourceId}`,
        annotationIndex,
      );
      if (!image) {
        return MALFORMED;
      }

      return {
        id,
        sourceId,
        ...bookmarkFlag,
        kind: "imageStamp",
        pageIndex,
        rect: image.rect,
        comment: extractAnnotationComment(annotation),
        imageData: image.imageData,
        mimeType: "image/png",
        widthPx: image.widthPx,
        heightPx: image.heightPx,
        rotation: image.rotation,
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

export function isEditableExistingAnnotation(
  annotation: ExistingPdfAnnotation,
) {
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
      "callout",
      "calloutLine",
      "calloutLines",
      "calloutPoints",
      "lineCoordinates",
      "vertices",
    ])
  ) {
    return false;
  }

  const borderWidth = firstFiniteNumber(
    annotation.borderStyle?.width,
    annotation.borderStyle?.rawWidth,
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

function normalizeInkLists(annotation: ExistingPdfAnnotation): PdfPoint[][] {
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
        : [],
    )
    .filter((path) => path.length > 0);
}

function isFlatNumberList(value: unknown): value is number[] | Float32Array {
  if (!isIterable(value)) {
    return false;
  }

  const values = Array.from(value as Iterable<unknown>);
  return values.length > 0 && values.every((item) => typeof item === "number");
}

function isPointObjectList(
  value: unknown,
): value is Array<{ x: number; y: number }> {
  if (!isIterable(value)) {
    return false;
  }

  const values = Array.from(value as Iterable<unknown>);
  return (
    values.length > 0 &&
    values.every(
      (item) =>
        item !== null && typeof item === "object" && "x" in item && "y" in item,
    )
  );
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    Boolean(value) &&
    typeof value !== "string" &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
  );
}

function highlightOpacity(annotation: ExistingPdfAnnotation) {
  const explicitOpacity = annotation.ca ?? annotation.opacity;
  return typeof explicitOpacity === "number" && explicitOpacity < 1
    ? clampPdfNumber(explicitOpacity, 0, 1, 0.35)
    : 0.35;
}

function freeTextOpacity(annotation: ExistingPdfAnnotation) {
  const explicitOpacity = annotation.ca ?? annotation.opacity;
  return typeof explicitOpacity === "number"
    ? clampPdfNumber(explicitOpacity, 0, 1, 1)
    : 1;
}

function rawOpacity(annotation: ExistingPdfAnnotation) {
  const explicitOpacity = annotation.ca ?? annotation.opacity;
  return typeof explicitOpacity === "number" && Number.isFinite(explicitOpacity)
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
    annotation.thickness,
  );

  if (explicitWidth !== null) {
    return clampPdfNumber(explicitWidth, 0.1, 72, 1);
  }

  return asHighlight ? 8 : 2.5;
}

function inkColor(
  annotation: ExistingPdfAnnotation,
  asHighlight: boolean,
): [number, number, number] {
  const highlightFallback: [number, number, number] = [1, 0.82, 0.12];
  const color = pdfjsColorToRgb(
    annotation.interiorColor ?? annotation.color,
    asHighlight ? highlightFallback : [0.05, 0.2, 0.42],
  );

  if (asHighlight && isNearBlack(color)) {
    return highlightFallback;
  }

  return color;
}

function isInkHighlight(annotation: ExistingPdfAnnotation) {
  // An explicit intent settles it before the text hints, which read /Contents
  // and would turn a pen stroke commented "highlight this" into a highlighter.
  if (annotation.it === "Ink" || annotation.intent === "Ink") {
    return false;
  }

  return (
    hasHighlightHint(annotation) ||
    annotation.it === "InkHighlight" ||
    annotation.intent === "InkHighlight" ||
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
    annotation.contentsObj?.str,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return text.includes("highlight") || text.includes("highlighter");
}

function isAppearanceBackedClosedInk(
  annotation: ExistingPdfAnnotation,
  paths: PdfPoint[][],
) {
  if (!hasNormalAppearance(annotation)) {
    return false;
  }

  const effectiveWidth = firstFiniteNumber(
    annotation.borderStyle?.width,
    annotation.width,
    annotation.thickness,
  );
  if (effectiveWidth !== null && effectiveWidth > 0.05) {
    return false;
  }

  return looksLikeClosedAppearanceInk(paths);
}

function looksLikeClosedAppearanceInk(paths: PdfPoint[][]) {
  const closedPaths = paths.filter(
    (path) => path.length >= 4 && pathLooksClosed(path),
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
    annotation.AP,
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
    annotation.contentsObj?.str,
  ]
    .map(annotationTextHint)
    .filter(Boolean)
    .join(" ")
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
    annotation.contentsObj?.str,
  ]
    .map(annotationTextHint)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /callout|equation|formula|shape|stamp/.test(text);
}

function hasAnyAnnotationProperty(
  annotation: ExistingPdfAnnotation,
  keys: string[],
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
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const candidate = value as { str?: unknown; text?: unknown };
    if (typeof candidate.str === "string") {
      return candidate.str;
    }
    if (typeof candidate.text === "string") {
      return candidate.text;
    }
  }

  return "";
}

function isNearBlack([r, g, b]: [number, number, number]) {
  return r < 0.08 && g < 0.08 && b < 0.08;
}

function firstFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

// /Contents and nothing else: falling back to pdf.js's appearance
// re-extraction would invent a comment from whatever the mark is drawn over.
function extractAnnotationComment(annotation: ExistingPdfAnnotation) {
  const contents = annotation.contentsObj?.str ?? annotation.contents;
  return typeof contents === "string"
    ? normalizeAnnotationComment(contents)
    : "";
}

function extractOverlaidText(annotation: ExistingPdfAnnotation) {
  const overlaid: unknown = annotation.overlaidText;
  if (typeof overlaid !== "string") {
    return undefined;
  }

  const text = normalizeAnnotationComment(overlaid);
  return text.length > 0 ? text : undefined;
}

// Character rules but no length bound; see CLAUDE.md Learnings.
function extractAnnotationText(annotation: ExistingPdfAnnotation) {
  return strippedDocumentText(rawAnnotationText(annotation));
}

function rawAnnotationText(annotation: ExistingPdfAnnotation) {
  // `/Contents` wins: `textContent` is pdf.js's re-extraction of what was
  // drawn, so preferring it would bake word-wrap points in as newlines.
  const fromContents = annotation.contentsObj?.str ?? annotation.contents;
  if (typeof fromContents === "string" && fromContents.length > 0) {
    return fromContents;
  }

  const textContent = annotation.textContent;
  if (Array.isArray(textContent) && textContent.length > 0) {
    return textContent
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          return item.str ?? item.text ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return annotation.titleObj?.str ?? "";
}

function extractFontSize(annotation: ExistingPdfAnnotation) {
  const fontSize = annotation.defaultAppearanceData?.fontSize;
  if (typeof fontSize === "number" && Number.isFinite(fontSize)) {
    return clampPdfNumber(fontSize, 1, 144, 16);
  }

  const defaultAppearance =
    annotation.defaultAppearance ?? annotation.defaultAppearanceData?.fontSize;
  if (typeof defaultAppearance === "string") {
    const match = defaultAppearance.match(/\/[^\s]+\s+([0-9.]+)\s+Tf/);
    if (match) {
      return clampPdfNumber(Number(match[1]), 1, 144, 16);
    }
  }

  return 16;
}

export function existingAnnotationId(
  annotation: ExistingPdfAnnotation,
  fallbackIndex = 0,
) {
  return String(
    annotation.id ??
      annotation.refName ??
      annotation.annotationId ??
      `annotation-${fallbackIndex}`,
  );
}

// Confirm here, where pdf.js's subtype and rectangle are still to hand and the
// same check `existingAnnotationDict` makes can be applied.
async function confirmedAnnotationSourceId(
  pdfBytes: Uint8Array,
  annotation: ExistingPdfAnnotation,
  pageIndex: number,
  annotationIndex: number,
) {
  const sourceId = existingAnnotationSourceId(
    annotation,
    pageIndex,
    annotationIndex,
  );
  if (
    !sourceId.startsWith(DIRECT_SOURCE_ID_PREFIX) ||
    !editableAnnotationTypes.has(annotation.annotationType)
  ) {
    return sourceId;
  }

  const placement = await directAnnotationPlacement(
    pdfBytes,
    pageIndex,
    annotation,
    annotationIndex,
  );
  return placement === "confirmed"
    ? sourceId
    : unresolvedSourceId(placement, pageIndex, annotationIndex);
}

function existingAnnotationSourceId(
  annotation: ExistingPdfAnnotation,
  pageIndex: number,
  annotationIndex: number,
) {
  // A ref-shaped id (5R, 50R1) is stronger than /NM, geometry or array
  // position, so never OR those weaker aliases into the same identity.
  const pdfJsId = annotationTextHint(annotation.id).trim();
  if (parsePdfJsRef(pdfJsId)) {
    return pdfJsId;
  }

  if (pdfJsId) {
    // A direct dictionary's /NM is user-controlled metadata and must not
    // override its /Annots position.
    return directSourceId(pageIndex, annotationIndex);
  }

  const preciseCandidates = uniqueSourceIdCandidates([
    annotation.refName,
    annotation.annotationId,
    annotation.nm,
    annotation.NM,
    annotation.nameObj?.str,
    annotation.nameObj?.text,
  ]);

  if (preciseCandidates.length > 0) {
    return preciseCandidates[0];
  }

  // Page and /Annots position is the only exact locator a direct dictionary
  // has, and it holds until the writer mutates that array.
  return directSourceId(pageIndex, annotationIndex);
}

function uniqueSourceIdCandidates(values: unknown[]) {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const value of values) {
    const text = annotationTextHint(value).trim();
    if (!text) {
      continue;
    }

    const key = text.toLowerCase().replace(/\s+/g, "");
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
        y2: Math.max(quad[1], quad[3], quad[5], quad[7]),
      }));
  }

  const fallbackRect = rectFromArray(rect);
  return fallbackRect ? [fallbackRect] : [];
}

function chunkQuadPoints(quadPoints: number[]) {
  const values = Array.from(quadPoints, Number);
  return Array.from({ length: Math.floor(values.length / 8) }, (_, index) =>
    values.slice(index * 8, index * 8 + 8),
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
    y: Number(numericPoints[index * 2 + 1]),
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

type ExtractedStampImage = {
  imageData: string;
  widthPx: number;
  heightPx: number;
  rotation: number;
  rect: PdfRect;
};

type AppearanceRotationAndRect = {
  formStream: PDFRawStream;
  rect: PdfRect;
  rotation: number;
};

// The raw pdf-lib dictionary behind a pdf.js annotation, matched by object and
// generation number or by confirmed /Annots position, and nothing weaker: /NM,
// geometry and "the only Highlight on the page" can all hit a different object.
async function existingAnnotationDict(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation,
  annotationIndex?: number,
) {
  const pdfDoc = await getEditablePdf(pdfBytes);
  if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
    return null;
  }

  const annots = pdfDoc.getPage(pageIndex).node.Annots();
  if (!annots) {
    return null;
  }

  const ref = parsePdfJsRef(annotation.id);
  if (ref) {
    const annotRef = findMatchingRef(annots, ref);
    if (!annotRef) {
      return null;
    }

    const annotDict = resolve(pdfDoc, pdfDoc.context.lookup(annotRef));
    return annotDict instanceof PDFDict ? { annotDict, pdfDoc } : null;
  }

  if (
    annotationIndex === undefined ||
    !Number.isInteger(annotationIndex) ||
    annotationIndex < 0 ||
    annotationIndex >= annots.size()
  ) {
    return null;
  }

  // The entry itself, not a lookup: a reference here means pdf.js was reading
  // some other annotation as direct, so the position is not this one's identity.
  const entry = annots.get(annotationIndex);
  if (
    !(entry instanceof PDFDict) ||
    directArrayPlacement(annots, annotationIndex, annotation) !== "confirmed"
  ) {
    return null;
  }

  return { annotDict: entry, pdfDoc };
}

// A confirmation, never an identity: subtype and rectangle must single out one
// entry, or an unchecked position reads or writes a neighbour.
type DirectArrayPlacement = "ambiguous" | "confirmed" | "shifted";

function directArrayPlacement(
  annots: PDFArray,
  annotationIndex: number,
  annotation: ExistingPdfAnnotation,
): DirectArrayPlacement {
  const reported = comparableAnnotationRect(
    annotation.subtype,
    rectFromArray(annotation.rect),
  );
  if (typeof annotation.subtype !== "string" || !reported) {
    return "shifted";
  }

  const descriptors = directEntryDescriptors(annots);
  const confirms = (entry: DirectEntryDescriptor | null | undefined) =>
    Boolean(
      entry &&
      entry.subtype === annotation.subtype &&
      sameRect(entry.rect, reported),
    );

  if (descriptors.filter(confirms).length > 1) {
    return "ambiguous";
  }

  return confirms(descriptors[annotationIndex]) ? "confirmed" : "shifted";
}

type DirectEntryDescriptor = { rect: PdfRect; subtype: string };

// Built once per /Annots array; every annotation on the page asks the same of it.
const directEntryDescriptorCache = new WeakMap<
  PDFArray,
  Array<DirectEntryDescriptor | null>
>();

function directEntryDescriptors(annots: PDFArray) {
  const cached = directEntryDescriptorCache.get(annots);
  if (cached) {
    return cached;
  }

  const descriptors = Array.from({ length: annots.size() }, (_, index) =>
    describeDirectEntry(annots, index),
  );
  directEntryDescriptorCache.set(annots, descriptors);
  return descriptors;
}

function describeDirectEntry(
  annots: PDFArray,
  index: number,
): DirectEntryDescriptor | null {
  try {
    const entry = annots.get(index);
    if (!(entry instanceof PDFDict)) {
      return null;
    }

    const subtype = entry
      .lookupMaybe(PDFName.of("Subtype"), PDFName)
      ?.decodeText();
    const storedRect = entry.lookupMaybe(PDFName.of("Rect"), PDFArray);
    const rect =
      storedRect && storedRect.size() >= 4
        ? rectFromArray(
            Array.from({ length: 4 }, (_, position) =>
              pdfArrayNumber(storedRect, position),
            ),
          )
        : null;
    const comparable = comparableAnnotationRect(subtype, rect);
    return subtype && comparable ? { rect: comparable, subtype } : null;
  } catch {
    // A wrong-typed /Subtype or /Rect makes pdf-lib throw rather than return
    // undefined; such an entry confirms nothing.
    return null;
  }
}

// pdf.js reports an appearance-less /Text annotation at a fixed icon box
// anchored to the stored rect's top-left (TextAnnotation: rect[1] = rect[3] -
// 22, rect[2] = rect[0] + 22).
const TEXT_ANNOTATION_ICON_SIZE = 22;

function comparableAnnotationRect(subtype: unknown, rect: PdfRect | null) {
  if (!rect || subtype !== "Text") {
    return rect;
  }

  return {
    x1: rect.x1,
    y1: rect.y2 - TEXT_ANNOTATION_ICON_SIZE,
    x2: rect.x1 + TEXT_ANNOTATION_ICON_SIZE,
    y2: rect.y2,
  };
}

function sameRect(left: PdfRect, right: PdfRect) {
  return (
    Math.abs(left.x1 - right.x1) < 0.01 &&
    Math.abs(left.y1 - right.y1) < 0.01 &&
    Math.abs(left.x2 - right.x2) < 0.01 &&
    Math.abs(left.y2 - right.y2) < 0.01
  );
}

/** The same confirmation, against the page's raw /Annots array in the file. */
async function directAnnotationPlacement(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation,
  annotationIndex: number,
): Promise<DirectArrayPlacement> {
  try {
    const pdfDoc = await getEditablePdf(pdfBytes);
    if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
      return "shifted";
    }

    const annots = pdfDoc.getPage(pageIndex).node.Annots();
    if (!annots || annotationIndex < 0 || annotationIndex >= annots.size()) {
      return "shifted";
    }

    return directArrayPlacement(annots, annotationIndex, annotation);
  } catch {
    return "shifted";
  }
}

// Absent, false or any other type reads as unstarred: the key is private, so a
// third-party document may have put anything under that name.
async function extractAnnotationBookmark(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation,
  annotationIndex?: number,
) {
  try {
    const resolved = await existingAnnotationDict(
      pdfBytes,
      pageIndex,
      annotation,
      annotationIndex,
    );
    if (!resolved) {
      return false;
    }

    const flag = resolved.pdfDoc.context.lookup(
      resolved.annotDict.get(PDFName.of(ANNOTATION_BOOKMARK_KEY)),
    );
    return flag instanceof PDFBool && flag.asBoolean();
  } catch {
    return false;
  }
}

// Returns null unless the BBox-to-Rect relationship is a pure translate, since
// a producer that scales instead would be silently mis-sized.
export async function extractAppearanceRotationAndRect(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation,
  annotationIndex?: number,
): Promise<AppearanceRotationAndRect | null> {
  try {
    const onPageRect = rectFromArray(annotation.rect);
    const resolved = await existingAnnotationDict(
      pdfBytes,
      pageIndex,
      annotation,
      annotationIndex,
    );
    if (!onPageRect || !resolved) {
      return null;
    }

    const { annotDict, pdfDoc } = resolved;

    const apDict = resolve(pdfDoc, annotDict.get(PDFName.of("AP")));
    if (!(apDict instanceof PDFDict)) {
      return null;
    }

    const formStream = resolve(pdfDoc, apDict.get(PDFName.of("N")));
    if (!(formStream instanceof PDFRawStream)) {
      return null;
    }

    const bbox = formStream.dict.lookupMaybe(PDFName.of("BBox"), PDFArray);
    if (!bbox || bbox.size() < 4) {
      return null;
    }

    const bboxWidth = Math.abs(
      pdfArrayNumber(bbox, 2) - pdfArrayNumber(bbox, 0),
    );
    const bboxHeight = Math.abs(
      pdfArrayNumber(bbox, 3) - pdfArrayNumber(bbox, 1),
    );
    if (!(bboxWidth > 0) || !(bboxHeight > 0)) {
      return null;
    }

    const matrix = formStream.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray);
    const rotation = matrix ? rotationFromMatrix(matrix) : 0;
    // A Matrix matching no rotation this writer produces cannot be assumed
    // unrotated, so decline rather than show or save the wrong orientation.
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
        y2: centerY + bboxHeight / 2,
      },
    };
  } catch {
    return null;
  }
}

function nearlyEqual(a: number, b: number) {
  return Math.abs(a - b) <= 0.5;
}

// Only the shape `imageStampAppearance` writes is recognised; anything else
// stays read-only.
export function extractStampImage(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation,
  budgetKey = `${pageIndex}:0:${existingAnnotationId(annotation)}`,
  // Position in /Annots, which identifies a direct dictionary.
  annotationIndex?: number,
): Promise<ExtractedStampImage | null> {
  return enqueueStampDecode(() =>
    extractStampImageNow(
      pdfBytes,
      pageIndex,
      annotation,
      budgetKey,
      annotationIndex,
    ),
  );
}

async function extractStampImageNow(
  pdfBytes: Uint8Array,
  pageIndex: number,
  annotation: ExistingPdfAnnotation,
  budgetKey: string,
  annotationIndex?: number,
): Promise<ExtractedStampImage | null> {
  try {
    const appearance = await extractAppearanceRotationAndRect(
      pdfBytes,
      pageIndex,
      annotation,
      annotationIndex,
    );
    if (!appearance) {
      return null;
    }

    // Already loaded (and cached) inside extractAppearanceRotationAndRect.
    const pdfDoc = await getEditablePdf(pdfBytes);
    const { formStream, rect: stampRect, rotation } = appearance;
    const resources = formStream.dict.lookupMaybe(
      PDFName.of("Resources"),
      PDFDict,
    );
    const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const imageKeys = xObjects?.keys() ?? [];
    if (!xObjects || imageKeys.length !== 1) {
      return null;
    }

    const imageStream = resolve(pdfDoc, xObjects.get(imageKeys[0]));
    if (!(imageStream instanceof PDFRawStream)) {
      return null;
    }

    const width = imageStream.dict
      .lookupMaybe(PDFName.of("Width"), PDFNumber)
      ?.asNumber();
    const height = imageStream.dict
      .lookupMaybe(PDFName.of("Height"), PDFNumber)
      ?.asNumber();
    const colorSpace = imageStream.dict
      .lookupMaybe(PDFName.of("ColorSpace"), PDFName)
      ?.decodeText();
    const bitsPerComponent = imageStream.dict
      .lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber)
      ?.asNumber();
    if (
      !width ||
      !height ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > MAX_EDITABLE_STAMP_PIXELS ||
      colorSpace !== "DeviceRGB" ||
      bitsPerComponent !== 8 ||
      !isIdentityOrAbsentDecodeArray(imageStream.dict, 3) ||
      !isSimpleFlateStream(imageStream) ||
      imageStream.getContentsSize() > MAX_ENCODED_STAMP_STREAM_BYTES
    ) {
      return null;
    }

    const pixelCount = width * height;
    const stampBudget = importedStampBudgets.get(pdfBytes) ?? {
      pixelsByKey: new Map<string, number>(),
      totalPixels: 0,
    };
    const previouslyCountedPixels = stampBudget.pixelsByKey.get(budgetKey) ?? 0;
    const nextTotalPixels =
      stampBudget.totalPixels - previouslyCountedPixels + pixelCount;
    if (nextTotalPixels > MAX_EDITABLE_STAMP_PIXELS_PER_DOCUMENT) {
      return null;
    }

    const rgbBytes = await decodeBoundedFlateStream(
      imageStream,
      pixelCount * 3,
    );
    if (!rgbBytes) {
      return null;
    }

    const smask = resolve(pdfDoc, imageStream.dict.get(PDFName.of("SMask")));
    let alphaBytes: Uint8Array | null = null;
    if (smask) {
      if (
        !isValidStampAlphaMask(smask, width, height) ||
        !isSimpleFlateStream(smask) ||
        smask.getContentsSize() > MAX_ENCODED_STAMP_STREAM_BYTES
      ) {
        return null;
      }
      alphaBytes = await decodeBoundedFlateStream(smask, pixelCount);
      if (!alphaBytes) {
        return null;
      }
    }

    const imageData = stampImageToPng(rgbBytes, alphaBytes, width, height);
    if (!imageData) {
      return null;
    }

    stampBudget.pixelsByKey.set(budgetKey, pixelCount);
    stampBudget.totalPixels = nextTotalPixels;
    importedStampBudgets.set(pdfBytes, stampBudget);
    return {
      imageData,
      widthPx: width,
      heightPx: height,
      rotation,
      rect: stampRect,
    };
  } catch {
    return null;
  }
}

function enqueueStampDecode<T>(task: () => Promise<T>) {
  const result = stampDecodeQueue.then(task, task);
  stampDecodeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isSimpleFlateStream(stream: PDFRawStream) {
  const filter = stream.dict.lookupMaybe(PDFName.of("Filter"), PDFName);
  return (
    filter?.decodeText() === "FlateDecode" &&
    !stream.dict.get(PDFName.of("DecodeParms"))
  );
}

async function decodeBoundedFlateStream(
  stream: PDFRawStream,
  expectedLength: number,
) {
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength <= 0 ||
    typeof DecompressionStream === "undefined"
  ) {
    return null;
  }

  const input = new Blob([
    uint8ArrayToArrayBuffer(stream.getContents()),
  ]).stream();
  const reader = input
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let decodedLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (decodedLength + value.byteLength > expectedLength) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
      decodedLength += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  if (decodedLength !== expectedLength) {
    return null;
  }

  const decoded = new Uint8Array(expectedLength);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoded;
}

function resolve(pdfDoc: PDFDocument, value: unknown) {
  return value instanceof PDFRef ? pdfDoc.context.lookup(value) : value;
}

function pdfArrayNumber(array: PDFArray, index: number) {
  return array.lookupMaybe(index, PDFNumber)?.asNumber() ?? 0;
}

// A non-identity /Decode would reinterpret the samples, so only an absent
// array or an explicit identity is accepted.
function isIdentityOrAbsentDecodeArray(dict: PDFDict, componentCount: number) {
  const decode = dict.lookupMaybe(PDFName.of("Decode"), PDFArray);
  if (!decode) {
    return true;
  }

  if (decode.size() !== componentCount * 2) {
    return false;
  }

  const identity = Array.from(
    { length: componentCount * 2 },
    (_, index) => index % 2,
  );
  return identity.every(
    (value, index) => pdfArrayNumber(decode, index) === value,
  );
}

function isValidStampAlphaMask(
  value: unknown,
  width: number,
  height: number,
): value is PDFRawStream {
  if (!(value instanceof PDFRawStream)) {
    return false;
  }

  const smaskWidth = value.dict
    .lookupMaybe(PDFName.of("Width"), PDFNumber)
    ?.asNumber();
  const smaskHeight = value.dict
    .lookupMaybe(PDFName.of("Height"), PDFNumber)
    ?.asNumber();
  const bitsPerComponent = value.dict
    .lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber)
    ?.asNumber();

  return (
    smaskWidth === width &&
    smaskHeight === height &&
    value.dict.lookupMaybe(PDFName.of("ColorSpace"), PDFName)?.decodeText() ===
      "DeviceGray" &&
    bitsPerComponent === 8 &&
    isIdentityOrAbsentDecodeArray(value.dict, 1)
  );
}

function rotationFromMatrix(matrix: PDFArray): number | null {
  return rotationFromAppearanceMatrix(
    pdfArrayNumber(matrix, 0),
    pdfArrayNumber(matrix, 1),
    pdfArrayNumber(matrix, 2),
    pdfArrayNumber(matrix, 3),
  );
}

function stampImageToPng(
  rgbBytes: Uint8Array,
  alphaBytes: Uint8Array | null,
  width: number,
  height: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
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
  const dataUrl = canvas.toDataURL("image/png");
  const base64Index = dataUrl.indexOf(",");
  return base64Index < 0 ? null : dataUrl.slice(base64Index + 1);
}

function parsePdfJsRef(id: unknown) {
  if (typeof id !== "string") {
    return null;
  }

  const match = /^(\d+)R(\d*)$/.exec(id);
  if (!match) {
    return null;
  }

  return {
    objectNumber: Number(match[1]),
    generationNumber: match[2] ? Number(match[2]) : 0,
  };
}

function findMatchingRef(
  annots: PDFArray | undefined,
  ref: { objectNumber: number; generationNumber: number },
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
  rect: number[] | Float32Array | null | undefined,
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
    y2: Math.max(values[1], values[3]),
  };
}

function pdfjsColorToRgb(
  color: number[] | Uint8ClampedArray | null | undefined,
  fallback: [number, number, number],
): [number, number, number] {
  if (!color || color.length === 0) {
    return fallback;
  }

  const values = Array.from(color).map(Number);
  if (!values.every(Number.isFinite)) {
    return fallback;
  }

  const channels =
    values.length === 1
      ? [values[0], values[0], values[0]]
      : values.slice(0, 3);
  if (channels.length < 3) {
    return fallback;
  }

  const divisor = Math.max(...channels) > 1 ? 255 : 1;
  return [
    clampPdfNumber(channels[0] / divisor, 0, 1, fallback[0]),
    clampPdfNumber(channels[1] / divisor, 0, 1, fallback[1]),
    clampPdfNumber(channels[2] / divisor, 0, 1, fallback[2]),
  ];
}
