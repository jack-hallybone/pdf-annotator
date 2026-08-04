import assert from 'node:assert/strict';
import test from 'node:test';

// Which layer an existing annotation is allowed into. The split is a security
// boundary, not a styling choice: the pdf.js annotation layer builds real HTML
// elements, so a widget admitted there would be a focusable, scriptable form
// control built from an untrusted document. The appearance overlay only paints
// the document's own appearance streams onto a canvas - inert pixels.
//
// annotationDisplayPolicy.ts imports `pdfjs-dist` (for the AnnotationType
// enum), whose browser build touches `DOMMatrix` at module top level. Static ES
// imports are hoisted and evaluated before any of this file's own code runs, so
// the only way to load it in plain Node is to install minimal browser polyfills
// first and then load it with a *dynamic* import (which is not hoisted). Same
// pattern as tests/annotation-rotation-reimport.test.ts.
installBrowserPolyfills();
const { AnnotationType } = await import('pdfjs-dist');
const {
  shouldRenderExistingAnnotationInAppearanceOverlay,
  shouldRenderExistingAnnotationInPdfJsLayer
} = await import('../src/workspace/annotationDisplayPolicy');

function installBrowserPolyfills() {
  class FakeDOMMatrix {}
  const globals = globalThis as Record<string, unknown>;
  globals.DOMMatrix ??= FakeDOMMatrix;
}

function annotation(annotationType: number) {
  return { annotationType, id: 'a1', rect: [0, 0, 10, 10] } as Record<
    string,
    unknown
  >;
}

test('only links are ever built as HTML in the pdf.js annotation layer', () => {
  assert.equal(
    shouldRenderExistingAnnotationInPdfJsLayer(annotation(AnnotationType.LINK)),
    true
  );

  for (const type of [
    AnnotationType.WIDGET,
    AnnotationType.POPUP,
    AnnotationType.STAMP,
    AnnotationType.FREETEXT,
    AnnotationType.HIGHLIGHT,
    AnnotationType.INK
  ]) {
    assert.equal(
      shouldRenderExistingAnnotationInPdfJsLayer(annotation(type)),
      false,
      `annotation type ${type} must not reach the HTML layer`
    );
  }
});

// The regression this file was added for: widgets were excluded from the
// appearance overlay as well, so a signature stamp - and every form field -
// silently vanished from a document that renders it everywhere else.
test('widget appearances are painted in the appearance overlay', () => {
  assert.equal(
    shouldRenderExistingAnnotationInAppearanceOverlay(
      annotation(AnnotationType.WIDGET),
      [],
      0
    ),
    true
  );
});

test('links and popups stay out of the appearance overlay', () => {
  // Links are built by the HTML layer instead; popups are note chrome this app
  // renders itself.
  for (const type of [AnnotationType.LINK, AnnotationType.POPUP]) {
    assert.equal(
      shouldRenderExistingAnnotationInAppearanceOverlay(annotation(type), [], 0),
      false,
      `annotation type ${type} must not be painted into the overlay`
    );
  }
});

test('an unsupported annotation kind is painted rather than dropped', () => {
  // Preserving what we cannot edit is the point: a Square/Circle/Line from
  // another tool is shown read-only, not silently hidden.
  for (const type of [
    AnnotationType.SQUARE,
    AnnotationType.CIRCLE,
    AnnotationType.LINE
  ]) {
    assert.equal(
      shouldRenderExistingAnnotationInAppearanceOverlay(annotation(type), [], 0),
      true,
      `annotation type ${type} should be painted read-only`
    );
  }
});
