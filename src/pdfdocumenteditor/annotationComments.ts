/*
 * Comment text is user input on its way into a PDF string, so it is bounded and
 * stripped here once.
 */
import type { PdfAnnotation } from "./types";
import { boundedDocumentText } from "./untrustedText";

/* Applies to text arriving from a file as much as to text typed in: a
 * /Contents string in an untrusted document has no size limit at all. */
export const MAX_ANNOTATION_COMMENT_LENGTH = 2000;

/** Free text and sticky notes do not: their /Contents is their own text. */
export function annotationSupportsComment(annotation: PdfAnnotation) {
  return (
    annotation.kind === "textHighlight" ||
    annotation.kind === "draw" ||
    annotation.kind === "freehandHighlight" ||
    annotation.kind === "imageStamp"
  );
}

export function annotationCommentText(annotation: PdfAnnotation) {
  if (annotation.kind === "freeText" || annotation.kind === "stickyNote") {
    return annotation.text;
  }

  return annotation.comment;
}

/** Derived, never stored: /Contents is where the reader's own note lives. */
export function annotationCoveredText(annotation: PdfAnnotation) {
  return annotation.kind === "textHighlight"
    ? annotation.coveredText
    : undefined;
}

/**
 * Trim, bound, and drop the control characters bar newlines: bidi overrides and
 * a lone \r make one string read differently here and in another reader.
 */
export function normalizeAnnotationComment(text: string) {
  return boundedDocumentText(text, MAX_ANNOTATION_COMMENT_LENGTH);
}

export function withAnnotationComment(
  annotation: PdfAnnotation,
  comment: string,
): PdfAnnotation {
  const next = normalizeAnnotationComment(comment);

  if (annotation.kind === "freeText" || annotation.kind === "stickyNote") {
    return annotation.text === next
      ? annotation
      : { ...annotation, text: next };
  }

  return annotation.comment === next
    ? annotation
    : { ...annotation, comment: next };
}

export function withAnnotationBookmark(
  annotation: PdfAnnotation,
  bookmarked: boolean,
): PdfAnnotation {
  if (Boolean(annotation.bookmarked) === bookmarked) {
    return annotation;
  }

  // Absent rather than false: "no key" is how an unstarred annotation looks
  // both in the dictionary and in a work signature.
  return bookmarked
    ? { ...annotation, bookmarked: true }
    : { ...annotation, bookmarked: undefined };
}
