import { annotationBounds, moveAnnotation } from "./annotationGeometry";
import type { PdfAnnotation, PdfPoint, PdfRect } from "./types";

/*
 * The annotations never go on the system clipboard: what goes there is a token
 * this window compares for equality, so no serialised annotation is ever parsed
 * and no user content reaches an OS clipboard history.
 */

export const ANNOTATION_CLIPBOARD_TYPE = "application/x-pdfdocumenteditor-clip";

/* PDF points, applied once per paste of the same clip, so repeated pastes do
 * not stack. */
const PASTE_OFFSET_POINTS = 12;

type AnnotationPasteTarget = {
  pageBounds: PdfRect;
  pageIndex: number;
};

type AnnotationClip = {
  annotations: PdfAnnotation[];
  pasteCount: number;
  token: string;
};

let clip: AnnotationClip | null = null;

/** Returns the token naming the clip; nothing else identifies one. */
export function writeAnnotationClipboard(annotations: PdfAnnotation[]) {
  const token = crypto.randomUUID();
  clip = { annotations, pasteCount: 0, token };
  return token;
}

export function hasAnnotationClipboard(token: string) {
  return token.length > 0 && clip?.token === token;
}

/** The annotations `token` names, minted afresh for `target`. */
export function readAnnotationPaste(
  token: string,
  target: AnnotationPasteTarget,
) {
  if (!hasAnnotationClipboard(token) || !clip) {
    return [];
  }

  clip.pasteCount += 1;
  return pasteAnnotations(clip.annotations, target, clip.pasteCount);
}

/**
 * A pasted annotation is a new one: a fresh `id` and no `sourceId`, because a
 * source identity names one dictionary in the file and sharing it would make
 * one edit match two annotations.
 */
function pasteAnnotations(
  annotations: PdfAnnotation[],
  target: AnnotationPasteTarget,
  offsetIndex: number,
): PdfAnnotation[] {
  if (annotations.length === 0) {
    return [];
  }

  const delta = pasteDelta(annotations, target, offsetIndex);
  return annotations.map((annotation) =>
    withPastedIdentity(
      moveAnnotation({ ...annotation, pageIndex: target.pageIndex }, delta),
    ),
  );
}

function withPastedIdentity(annotation: PdfAnnotation): PdfAnnotation {
  const pasted = { ...annotation, id: crypto.randomUUID() };
  delete pasted.sourceId;
  if (pasted.kind === "textHighlight") {
    delete pasted.coveredText;
  }
  return pasted;
}

function pasteDelta(
  annotations: PdfAnnotation[],
  target: AnnotationPasteTarget,
  offsetIndex: number,
): PdfPoint {
  const group = groupBounds(annotations);
  const step = PASTE_OFFSET_POINTS * offsetIndex;
  return {
    // PDF space puts y up, so down-and-right is +x, -y.
    x: containedDelta(step, group.x1, group.x2, target.pageBounds),
    y: containedDelta(-step, group.y1, group.y2, target.pageBounds, "y"),
  };
}

/** `delta`, reduced until [`low`, `high`] lands inside the page. */
function containedDelta(
  delta: number,
  low: number,
  high: number,
  pageBounds: PdfRect,
  axis: "x" | "y" = "x",
) {
  const pageLow = axis === "x" ? pageBounds.x1 : pageBounds.y1;
  const pageHigh = axis === "x" ? pageBounds.x2 : pageBounds.y2;
  if (high - low >= pageHigh - pageLow) {
    return pageLow - low;
  }

  return Math.min(Math.max(delta, pageLow - low), pageHigh - high);
}

function groupBounds(annotations: PdfAnnotation[]): PdfRect {
  const bounds = annotations.map(annotationBounds);
  return {
    x1: Math.min(...bounds.map((rect) => rect.x1)),
    x2: Math.max(...bounds.map((rect) => rect.x2)),
    y1: Math.min(...bounds.map((rect) => rect.y1)),
    y2: Math.max(...bounds.map((rect) => rect.y2)),
  };
}
