import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { createPdfTemplate } from "../src/pdfTemplates";

// A template this app creates from nothing must carry no personal info and
// none of pdf-lib's own default "pdf-lib (https://github.com/...)" branding
// either - every relevant metadata field is either blank or "PDF Annotator".
for (const kind of ["a4Blank", "a4Lined", "a4Cornell"] as const) {
  test(`a freshly created ${kind} template carries no personal metadata`, async () => {
    const { bytes } = await createPdfTemplate(kind);
    // load()'s own default (updateMetadata: true) re-stamps Producer/Creator
    // on read, same as create()'s does - the point here is what was saved.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });

    assert.equal(doc.getTitle(), "");
    assert.equal(doc.getAuthor(), "");
    assert.equal(doc.getSubject(), "");
    assert.equal(doc.getKeywords(), "");
    assert.equal(doc.getCreator(), "PDF Annotator");
    assert.equal(doc.getProducer(), "PDF Annotator");
  });
}
