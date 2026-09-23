import assert from "node:assert/strict";
import test from "node:test";

// Which layer an existing annotation is allowed into is a security boundary, not
// a styling choice: the pdf.js annotation layer builds real HTML elements, so a
// widget admitted there would be a scriptable form control built from an
// untrusted document, where the appearance overlay paints inert pixels.

// annotationDisplayPolicy.ts imports `pdfjs-dist`, whose browser build touches
// `DOMMatrix` at module top level, so it is loaded with a dynamic import after
// the polyfills: a static import would be hoisted above them.
installBrowserPolyfills();
const { AnnotationType } = await import("pdfjs-dist");
const {
  shouldRenderExistingAnnotationInAppearanceOverlay,
  shouldRenderExistingAnnotationInPdfJsLayer,
} = await import("../src/pdfdocumenteditor/annotationDisplayPolicy");

function installBrowserPolyfills() {
  class FakeDOMMatrix {}
  const globals = globalThis as Record<string, unknown>;
  globals.DOMMatrix ??= FakeDOMMatrix;
}

function annotation(annotationType: number) {
  return { annotationType, id: "a1", rect: [0, 0, 10, 10] } as Record<
    string,
    unknown
  >;
}

test("only links are ever built as HTML in the pdf.js annotation layer", () => {
  assert.equal(
    shouldRenderExistingAnnotationInPdfJsLayer(annotation(AnnotationType.LINK)),
    true,
  );

  for (const type of [
    AnnotationType.WIDGET,
    AnnotationType.POPUP,
    AnnotationType.STAMP,
    AnnotationType.FREETEXT,
    AnnotationType.HIGHLIGHT,
    AnnotationType.INK,
  ]) {
    assert.equal(
      shouldRenderExistingAnnotationInPdfJsLayer(annotation(type)),
      false,
      `annotation type ${type} must not reach the HTML layer`,
    );
  }
});

// Widgets were excluded from the appearance overlay as well, so a signature
// stamp - and every form field - silently vanished from a document that renders
// it everywhere else.
test("widget appearances are painted in the appearance overlay", () => {
  assert.equal(
    shouldRenderExistingAnnotationInAppearanceOverlay(
      annotation(AnnotationType.WIDGET),
      [],
      0,
    ),
    true,
  );
});

test("links and popups stay out of the appearance overlay", () => {
  for (const type of [AnnotationType.LINK, AnnotationType.POPUP]) {
    assert.equal(
      shouldRenderExistingAnnotationInAppearanceOverlay(
        annotation(type),
        [],
        0,
      ),
      false,
      `annotation type ${type} must not be painted into the overlay`,
    );
  }
});

test("an unsupported annotation kind is painted rather than dropped", () => {
  for (const type of [
    AnnotationType.SQUARE,
    AnnotationType.CIRCLE,
    AnnotationType.LINE,
  ]) {
    assert.equal(
      shouldRenderExistingAnnotationInAppearanceOverlay(
        annotation(type),
        [],
        0,
      ),
      true,
      `annotation type ${type} should be painted read-only`,
    );
  }
});
