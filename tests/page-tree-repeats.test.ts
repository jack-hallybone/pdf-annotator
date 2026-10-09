import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFName, PDFNumber, type PDFRef } from "pdf-lib";
import { loadEditablePdf } from "../src/pdfdocumenteditor/pdfPageOperations";
import {
  detectReadOnlyReason,
  pageTreeRepeatsABranch,
} from "../src/pdfdocumenteditor/pdfProtection";

// pdf-lib's page walk has no visited set, so a /Pages node that lists the same child several times, nested a few levels deep, is walked fanout^depth times: a 3 KB file of this shape froze the app for 34 s on open. These are kept small, so a regression shows as a wrong verdict rather than a hang.
async function repeatedPageTree(fanout: number, depth: number) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  let child: PDFRef = doc.getPage(0).ref;
  for (let level = 0; level < depth; level += 1) {
    child = doc.context.register(
      doc.context.obj({
        Type: "Pages",
        Kids: Array.from({ length: fanout }, () => child),
        Count: 1,
      }),
    );
  }
  doc.catalog.set(PDFName.of("Pages"), child);
  // Both options would walk the page tree this test exists to keep pdf-lib out of.
  return doc.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

// What pdf.js reports for such a file: /Count 1, and the first path's leaf.
const onePageReader = {
  numPages: 1,
  getMetadata: async () => ({ info: {}, metadata: null }),
  getPage: async () => ({ ref: { num: 0, gen: 0 } }),
} as unknown as Parameters<typeof detectReadOnlyReason>[1];

test("a page tree that lists a branch twice opens read-only, without walking every path", async () => {
  const bytes = await repeatedPageTree(3, 3);
  assert.equal(
    await detectReadOnlyReason(bytes, onePageReader, false),
    "ambiguous page order",
  );
});

test("pdf-lib is never handed a page tree that lists a branch twice", async () => {
  const bytes = await repeatedPageTree(2, 2);
  assert.equal(pageTreeRepeatsABranch(await PDFDocument.load(bytes)), true);
  await assert.rejects(
    loadEditablePdf(bytes),
    /lists part of itself more than once/,
  );
});

test("a page tree whose own node lists itself is refused the same way", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const root = doc.catalog.Pages();
  root.Kids().push(doc.catalog.get(PDFName.of("Pages")) as PDFRef);
  const bytes = await doc.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  await assert.rejects(
    loadEditablePdf(bytes),
    /lists part of itself more than once/,
  );
});

test("an ordinary nested page tree passes", async () => {
  const doc = await PDFDocument.create();
  for (let page = 0; page < 3; page += 1) {
    doc.addPage([200, 200]);
  }
  // A second level, as many producers write: the root holds an intermediate /Pages node that holds the leaves.
  const root = doc.catalog.Pages();
  const leaves = root.Kids();
  const middle = doc.context.register(
    doc.context.obj({
      Type: "Pages",
      Parent: doc.catalog.get(PDFName.of("Pages")),
      Kids: leaves,
      Count: 3,
    }),
  );
  root.set(PDFName.of("Kids"), doc.context.obj([middle]));
  const bytes = await doc.save({ useObjectStreams: false });

  const reloaded = await loadEditablePdf(bytes);
  assert.equal(pageTreeRepeatsABranch(reloaded), false);
  assert.equal(reloaded.getPageCount(), 3);
});

// tests/deleted-page-residue.test.ts deletes one slot of such a file and keeps the page the other slot lists.
test("a page listed in two slots is not a repeated branch", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const root = doc.catalog.Pages();
  root.Kids().push(page.ref);
  root.set(PDFName.of("Count"), PDFNumber.of(2));
  const bytes = await doc.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });

  const reloaded = await loadEditablePdf(bytes);
  assert.equal(pageTreeRepeatsABranch(reloaded), false);
  assert.equal(reloaded.getPageCount(), 2);
});
