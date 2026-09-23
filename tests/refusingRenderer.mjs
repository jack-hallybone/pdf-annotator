// A renderer that refuses to open one document, because a suite that cannot make
// a reload fail cannot see whether a page edit put its identities back.

// Import this before any `await import()` of renderer code: the redirect below is
// consulted when a specifier is resolved, and a static import graph is resolved
// in full before any of it runs.
import { registerHooks } from "node:module";
import "./rendererAssetStubs";
import { getDocument as openDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export * from "pdfjs-dist/legacy/build/pdf.mjs";

const PDFJS_ENTRY = "pdfjs-dist/legacy/build/pdf.mjs";

let refusals = 0;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === PDFJS_ENTRY && context.parentURL !== import.meta.url
      ? { shortCircuit: true, url: import.meta.url }
      : nextResolve(specifier, context);
  },
});

export function refuseNextDocumentLoad() {
  refusals += 1;
}

// Refusals armed and not yet used: a case that never reaches the reload fails
// rather than passing quietly on a path it did not drive.
export function pendingDocumentRefusals() {
  return refusals;
}

export function getDocument(parameters) {
  if (refusals === 0) {
    return openDocument(parameters);
  }

  refusals -= 1;
  return {
    destroy: async () => {},
    onPassword: null,
    onProgress: null,
    get promise() {
      return Promise.reject(new Error("the renderer refused this document"));
    },
  };
}
