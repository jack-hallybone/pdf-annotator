import { AnnotationType } from 'pdfjs-dist';
import {
  existingAnnotationId,
  isEditableExistingAnnotation
} from './annotationImport';
import type { ExistingPdfAnnotation } from './annotationImport';
import type { PdfAnnotation } from './types';

// Which layer an annotation already in the PDF is allowed into. The split is a
// security boundary, not a styling choice: the pdf.js annotation layer builds
// real DOM nodes out of an untrusted document, while the appearance overlay
// only paints the document's own appearance streams onto a canvas. Only links
// may be HTML; everything else that should be seen is painted.

export function shouldRenderExistingAnnotationInPdfJsLayer(
  annotation: ExistingPdfAnnotation
) {
  // Widgets are deliberately absent: a form field here would be a focusable,
  // scriptable control. They are painted by the overlay below instead.
  return annotation.annotationType === AnnotationType.LINK;
}

// Widgets (form fields, and a signature field's on-page stamp) belong here:
// excluding them made signed documents render with content missing that every
// other viewer shows. Appearance only - they stay out of the HTML layer above,
// so they can't be focused, filled in, or run a script. Hidden widgets need no
// special case: pdf.js doesn't paint them, so the caller's changed-pixel diff
// finds nothing to keep.
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
