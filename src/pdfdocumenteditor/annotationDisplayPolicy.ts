import { AnnotationType } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  existingAnnotationId,
  isEditableExistingAnnotation,
} from "./annotationImport";
import type { ExistingPdfAnnotation } from "./annotationImport";
import type { PdfAnnotation } from "./types";

// A security boundary, not a styling choice: the pdf.js annotation layer
// builds real DOM nodes out of an untrusted document, while the appearance
// overlay only paints onto a canvas.

export function shouldRenderExistingAnnotationInPdfJsLayer(
  annotation: ExistingPdfAnnotation,
) {
  // Widgets are absent on purpose: a form field here would be a focusable,
  // scriptable control.
  return annotation.annotationType === AnnotationType.LINK;
}

// Widgets belong here: excluding them left signed documents missing content
// every other viewer shows.
export function shouldRenderExistingAnnotationInAppearanceOverlay(
  annotation: ExistingPdfAnnotation,
  pageAnnotations: PdfAnnotation[],
  pageIndex: number,
) {
  if (
    annotation.annotationType === AnnotationType.LINK ||
    annotation.annotationType === AnnotationType.POPUP ||
    isReadOnlyTextMarkupAnnotation(annotation)
  ) {
    return false;
  }

  return !isManagedExistingAnnotation(annotation, pageAnnotations, pageIndex);
}

export function isReadOnlyTextMarkupAnnotation(
  annotation: ExistingPdfAnnotation,
) {
  if (isEditableExistingAnnotation(annotation)) {
    return false;
  }

  return (
    annotation.annotationType === AnnotationType.UNDERLINE ||
    annotation.annotationType === AnnotationType.SQUIGGLY ||
    annotation.annotationType === AnnotationType.STRIKEOUT
  );
}

// Hiding the native rendering and the import must never disagree, or the stamp
// is drawn twice or not at all.
export function isManagedExistingAnnotation(
  annotation: ExistingPdfAnnotation,
  pageAnnotations: PdfAnnotation[],
  pageIndex: number,
) {
  if (annotation.annotationType === AnnotationType.STAMP) {
    const importedId = `imported-${pageIndex}-${existingAnnotationId(annotation)}`;
    return pageAnnotations.some(
      (candidate) =>
        candidate.kind === "imageStamp" && candidate.id === importedId,
    );
  }

  return isEditableExistingAnnotation(annotation);
}
