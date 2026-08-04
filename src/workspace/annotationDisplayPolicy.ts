import { AnnotationType } from 'pdfjs-dist';
import {
  existingAnnotationId,
  isEditableExistingAnnotation
} from './annotationImport';
import type { ExistingPdfAnnotation } from './annotationImport';
import type { PdfAnnotation } from './types';

// Which layer an annotation already in the PDF is allowed into. Extracted from
// PdfPageView because it is pure policy with a narrow seam - and because the
// distinction it encodes is a security boundary, not a styling choice, so it
// deserves to be readable and directly testable rather than buried in a 4.9k
// line component.
//
// Two layers, very different trust properties:
//
//   * the pdf.js annotation layer builds real HTML elements. Anything admitted
//     here becomes a live DOM node built from an untrusted document.
//   * the appearance overlay paints the document's own appearance streams onto
//     a canvas and masks them to the annotation's rect. Inert pixels.
//
// Only links are allowed to be HTML. Everything else that should be seen is
// painted.

export function shouldRenderExistingAnnotationInPdfJsLayer(
  annotation: ExistingPdfAnnotation
) {
  // Deliberately not widgets: a form field here would be a focusable,
  // scriptable control. See the appearance overlay below for how they are
  // shown instead.
  return annotation.annotationType === AnnotationType.LINK;
}

// Widgets (form fields, and the on-page stamp of a signature field) are
// included on purpose. Excluding them made signed and form-bearing documents
// render visibly differently in this app than in Adobe or Chrome - content
// silently missing from a document the user is deciding whether to trust.
//
// Appearance only, never interactivity: widgets stay out of the HTML layer
// above, and that layer still renders with renderForms: false and
// enableScripting: false, so a field is drawn exactly as the document defines
// it and cannot be focused, typed into, or run a script. Widgets the document
// hides need no special case here - pdf.js does not paint a hidden annotation
// into the overlay render, so the caller's changed-pixel diff finds nothing to
// keep.
export function shouldRenderExistingAnnotationInAppearanceOverlay(
  annotation: ExistingPdfAnnotation,
  pageAnnotations: PdfAnnotation[],
  pageIndex: number
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
  annotation: ExistingPdfAnnotation
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

// pdf.js's Stamp metadata can't tell us on its own whether a stamp will
// import as an editable image (that requires the async pdf-lib byte
// extraction in annotationImport.ts) - so instead of duplicating that
// structural check here, this looks at whether the import already
// succeeded, i.e. whether a matching imported `imageStamp` annotation is
// currently present. That keeps the "hide the native PDF rendering" and
// "did the import work" decisions from ever disagreeing, which would
// otherwise either double-render the stamp or make it vanish.
export function isManagedExistingAnnotation(
  annotation: ExistingPdfAnnotation,
  pageAnnotations: PdfAnnotation[],
  pageIndex: number
) {
  if (annotation.annotationType === AnnotationType.STAMP) {
    const importedId = `imported-${pageIndex}-${existingAnnotationId(annotation)}`;
    return pageAnnotations.some(
      (candidate) => candidate.kind === 'imageStamp' && candidate.id === importedId
    );
  }

  return isEditableExistingAnnotation(annotation);
}
