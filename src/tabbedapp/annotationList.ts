// Turns the core's per-page annotation buckets into one reviewable list.
import {
  MAX_ANNOTATION_COMMENT_LENGTH,
  annotationCommentText,
  annotationCoveredText,
  annotationSupportsComment,
} from "../pdfdocumenteditor/annotationComments";
import { annotationBounds } from "../pdfdocumenteditor/annotationGeometry";
import { rgbToHex } from "../pdfdocumenteditor/annotationColors";
import type { PdfAnnotation } from "../pdfdocumenteditor/types";

export type AnnotationListRow = {
  annotation: PdfAnnotation;
  bookmarked: boolean;
  /** Lower-case hex, or "" for a kind that carries no colour of its own. */
  colorKey: string;
  comment: string;
  commentable: boolean;
  id: string;
  kindLabel: string;
  pageIndex: number;
  quote: string;
};

export type AnnotationListFilter = {
  /** Empty means "every colour"; otherwise only these hex keys are shown. */
  colorKeys: string[];
  bookmarkedOnly: boolean;
};

export const EMPTY_ANNOTATION_FILTER: AnnotationListFilter = {
  bookmarkedOnly: false,
  colorKeys: [],
};

const KIND_LABELS: Record<PdfAnnotation["kind"], string> = {
  draw: "Pen",
  freeText: "Text",
  freehandHighlight: "Highlighter",
  imageStamp: "Image",
  stickyNote: "Note",
  textHighlight: "Highlight",
};

/** Ordered as a reader meets them, not as the file stores them. */
export function annotationListRows(
  annotationsByPage: Map<number, PdfAnnotation[]>,
): AnnotationListRow[] {
  const rows: AnnotationListRow[] = [];
  for (const [pageIndex, annotations] of annotationsByPage) {
    for (const annotation of annotations) {
      rows.push(annotationListRow(annotation, pageIndex));
    }
  }

  return rows.sort(compareAnnotationRows);
}

function annotationListRow(
  annotation: PdfAnnotation,
  pageIndex: number,
): AnnotationListRow {
  return {
    annotation,
    bookmarked: Boolean(annotation.bookmarked),
    colorKey: annotationColorKey(annotation),
    comment: annotationCommentText(annotation),
    commentable: annotationSupportsComment(annotation),
    id: annotation.id,
    kindLabel: KIND_LABELS[annotation.kind],
    pageIndex,
    quote: annotationRowQuote(annotation),
  };
}

// A bound on the render alone: annotation text carries no length rule, and the
// annotation itself keeps every character.
function annotationRowQuote(annotation: PdfAnnotation) {
  const text =
    annotationCoveredText(annotation) || annotationCommentText(annotation);
  return text.slice(0, MAX_ANNOTATION_COMMENT_LENGTH);
}

/** An image stamp has no colour, and "" keeps it out of the filter row. */
function annotationColorKey(annotation: PdfAnnotation) {
  return annotation.kind === "imageStamp"
    ? ""
    : rgbToHex(annotation.color).toLowerCase();
}

function compareAnnotationRows(
  left: AnnotationListRow,
  right: AnnotationListRow,
) {
  if (left.pageIndex !== right.pageIndex) {
    return left.pageIndex - right.pageIndex;
  }

  const leftBounds = annotationBounds(left.annotation);
  const rightBounds = annotationBounds(right.annotation);
  // PDF y grows upward, so the top of the page is the LARGER value.
  const top =
    Math.max(rightBounds.y1, rightBounds.y2) -
    Math.max(leftBounds.y1, leftBounds.y2);
  if (Math.abs(top) > 1) {
    return top;
  }

  const left0 = Math.min(leftBounds.x1, leftBounds.x2);
  const right0 = Math.min(rightBounds.x1, rightBounds.x2);
  if (Math.abs(left0 - right0) > 1) {
    return left0 - right0;
  }

  // A stable tiebreak, so the list does not reshuffle between renders.
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function annotationColorCounts(rows: AnnotationListRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.colorKey) {
      counts.set(row.colorKey, (counts.get(row.colorKey) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([colorKey, count]) => ({ colorKey, count }))
    .sort((a, b) => b.count - a.count || (a.colorKey < b.colorKey ? -1 : 1));
}

export function filterAnnotationRows(
  rows: AnnotationListRow[],
  filter: AnnotationListFilter,
) {
  const colorKeys = new Set(filter.colorKeys);
  return rows.filter(
    (row) =>
      (!filter.bookmarkedOnly || row.bookmarked) &&
      (colorKeys.size === 0 || colorKeys.has(row.colorKey)),
  );
}

export function toggleColorFilter(
  filter: AnnotationListFilter,
  colorKey: string,
) {
  const next = filter.colorKeys.includes(colorKey)
    ? filter.colorKeys.filter((key) => key !== colorKey)
    : [...filter.colorKeys, colorKey];
  return { ...filter, colorKeys: next };
}

/**
 * Or deleting the last of a colour leaves the list empty behind a swatch
 * nobody can see to switch off.
 */
export function prunedAnnotationFilter(
  filter: AnnotationListFilter,
  rows: AnnotationListRow[],
) {
  const available = new Set(rows.map((row) => row.colorKey));
  const colorKeys = filter.colorKeys.filter((key) => available.has(key));
  if (colorKeys.length === filter.colorKeys.length) {
    return filter;
  }

  return { ...filter, colorKeys };
}
