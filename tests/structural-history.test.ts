import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from "pdf-lib";
import {
  applyStructuralOperation,
  extractPagesBytes,
  insertPagesFromBytes,
  invertStructuralOperation,
  movePageBy,
  removePagesRange,
  rotatePageByDelta,
  type PdfStructuralOperation,
} from "../src/pdfdocumenteditor/pdfPageOperations";
import {
  pageMappingFor,
  pageOrderChangeOfOperation,
} from "../src/pdfdocumenteditor/pageIdentity";
import { loadTestPdf } from "./pdfTestUtils";

// Every operation answers with both halves of what it did: the bytes, and the
// annotation names it changed getting there.
async function applyStructuralOperationBytes(
  bytes: Uint8Array,
  operation: PdfStructuralOperation,
) {
  return (await applyStructuralOperation(bytes, operation)).bytes;
}

// Each page gets a distinct width, so page identity and order can be verified
// without real content or text extraction.
async function buildFingerprintedPdf(pageCount: number, startWidth = 600) {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    doc.addPage([startWidth + index, 792]);
  }
  return doc.save();
}

async function indirectAnnotationPdf(contents: string[]) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  for (const text of contents) {
    const page = doc.addPage([612, 792]);
    const ref = context.register(
      context.obj({
        Contents: PDFHexString.fromText(text),
        P: page.ref,
        Rect: [72, 700, 92, 720],
        Subtype: "Text",
        Type: "Annot",
      }),
    );
    page.node.set(PDFName.of("Annots"), context.obj([ref]));
  }
  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}

async function annotationEntries(bytes: Uint8Array) {
  const doc = await loadTestPdf(bytes);
  return doc.getPages().map((page) => {
    const annots = page.node.Annots();
    const entries: { reference: string; text: string }[] = [];
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const entry = annots?.get(index);
      entries.push({
        reference: entry instanceof PDFRef ? entry.toString() : "inline",
        text:
          annots
            ?.lookupMaybe(index, PDFDict)
            ?.lookupMaybe(PDFName.of("Contents"), PDFHexString)
            ?.decodeText() ?? "",
      });
    }
    return entries;
  });
}

async function pageWidths(bytes: Uint8Array) {
  const doc = await loadTestPdf(bytes);
  return doc.getPages().map((page) => page.getWidth());
}

test("rotatePageByDelta applies and normalizes rotation deltas", async () => {
  const bytes = await buildFingerprintedPdf(1);
  const rotated = await rotatePageByDelta(bytes, 0, 90);
  const doc = await loadTestPdf(rotated);
  assert.equal(doc.getPage(0).getRotation().angle, 90);

  const rotatedBack = await rotatePageByDelta(rotated, 0, -90);
  assert.equal(
    (await loadTestPdf(rotatedBack)).getPage(0).getRotation().angle,
    0,
  );

  const negativeNormalized = await rotatePageByDelta(bytes, 0, -90);
  assert.equal(
    (await loadTestPdf(negativeNormalized)).getPage(0).getRotation().angle,
    270,
  );
});

test("removePagesRange removes the correct contiguous pages", async () => {
  const bytes = await buildFingerprintedPdf(5); // widths 600..604
  const removed = (await removePagesRange(bytes, 1, 2)).bytes; // widths 601, 602
  assert.deepEqual(await pageWidths(removed), [600, 603, 604]);
});

test("insertPagesFromBytes inserts pages at the correct index and order", async () => {
  const target = await buildFingerprintedPdf(3, 600); // 600,601,602
  const source = await buildFingerprintedPdf(2, 900); // 900,901
  const inserted = (await insertPagesFromBytes(target, 1, source)).bytes;
  assert.deepEqual(await pageWidths(inserted), [600, 900, 901, 601, 602]);
});

test("extractPagesBytes produces a standalone document with the right pages", async () => {
  const bytes = await buildFingerprintedPdf(5); // 600..604
  const extracted = await extractPagesBytes(bytes, 2, 2); // widths 602, 603
  assert.equal(extracted.pageCount, 2);
  assert.deepEqual(await pageWidths(extracted.bytes), [602, 603]);
});

test("delete-then-undo round trip (removePages inverted via extraction) restores original pages", async () => {
  const original = await buildFingerprintedPdf(5); // 600..604
  const deleteOp: PdfStructuralOperation = {
    type: "removePages",
    startIndex: 2,
    count: 1,
  };

  // Mirrors handleDeletePage: extract the page being deleted before removing it.
  const extracted = await extractPagesBytes(original, 2, 1);
  const undoOp: PdfStructuralOperation = {
    type: "insertPages",
    atIndex: 2,
    copiedNames: extracted.copiedNames,
    pageCount: extracted.pageCount,
    pagesBytes: extracted.bytes,
  };

  const afterDelete = await applyStructuralOperationBytes(original, deleteOp);
  assert.deepEqual(await pageWidths(afterDelete), [600, 601, 603, 604]);

  const undone = await applyStructuralOperationBytes(afterDelete, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602, 603, 604]);

  const redoOp = await invertStructuralOperation(undoOp, undone);
  assert.equal(redoOp.type, "removePages");
  const redone = await applyStructuralOperationBytes(undone, redoOp);
  assert.deepEqual(await pageWidths(redone), [600, 601, 603, 604]);
});

test("add-then-undo round trip (insertPages inverted to removePages) restores original pages", async () => {
  const original = await buildFingerprintedPdf(3); // 600,601,602
  const blankPage = await buildFingerprintedPdf(1, 950);
  const addOp: PdfStructuralOperation = {
    type: "insertPages",
    atIndex: 1,
    copiedNames: new Map(),
    pageCount: 1,
    pagesBytes: blankPage,
  };

  const afterAdd = await applyStructuralOperationBytes(original, addOp);
  assert.deepEqual(await pageWidths(afterAdd), [600, 950, 601, 602]);

  const undoOp = await invertStructuralOperation(addOp, afterAdd);
  assert.deepEqual(undoOp, { type: "removePages", startIndex: 1, count: 1 });

  const undone = await applyStructuralOperationBytes(afterAdd, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602]);
});

test("rotate-then-undo round trip inverts the rotation delta", async () => {
  const original = await buildFingerprintedPdf(2);
  const rotateOp: PdfStructuralOperation = {
    type: "rotatePage",
    pageIndex: 1,
    deltaDegrees: 90,
  };

  const afterRotate = await applyStructuralOperationBytes(original, rotateOp);
  assert.equal(
    (await loadTestPdf(afterRotate)).getPage(1).getRotation().angle,
    90,
  );

  const undoOp = await invertStructuralOperation(rotateOp, afterRotate);
  assert.deepEqual(undoOp, {
    type: "rotatePage",
    pageIndex: 1,
    deltaDegrees: -90,
  });

  const undone = await applyStructuralOperationBytes(afterRotate, undoOp);
  assert.equal((await loadTestPdf(undone)).getPage(1).getRotation().angle, 0);
});

test("movePageBy swaps a page with its neighbor in either direction", async () => {
  const bytes = await buildFingerprintedPdf(4); // 600,601,602,603
  const movedDown = await movePageBy(bytes, 1, 1); // swap 601 and 602
  assert.deepEqual(await pageWidths(movedDown), [600, 602, 601, 603]);

  const movedUp = await movePageBy(bytes, 2, -1); // swap 601 and 602
  assert.deepEqual(await pageWidths(movedUp), [600, 602, 601, 603]);

  assert.deepEqual(
    await pageWidths(await movePageBy(bytes, 0, 1)),
    [601, 600, 602, 603],
  );
  assert.deepEqual(
    await pageWidths(await movePageBy(bytes, 3, -1)),
    [600, 601, 603, 602],
  );
});

// A move must not renumber what it moves: a copied page leaves an annotation
// named by nothing in the file, and the next edit to it stops the save.
test("movePageBy moves the page's own objects, not copies of them", async () => {
  const bytes = await indirectAnnotationPdf(["A", "B", "C"]);
  const before = await annotationEntries(bytes);
  assert.deepEqual(
    before.map((page) => page.map((entry) => entry.text)),
    [["A"], ["B"], ["C"]],
  );

  const after = await annotationEntries(await movePageBy(bytes, 0, 1));
  assert.deepEqual(after, [before[1], before[0], before[2]]);
});

test("movePageBy rejects moving past either edge of the document", async () => {
  const bytes = await buildFingerprintedPdf(3);
  await assert.rejects(() => movePageBy(bytes, 0, -1));
  await assert.rejects(() => movePageBy(bytes, 2, 1));
});

test("move-then-undo round trip (movePage inverted) restores original order", async () => {
  const original = await buildFingerprintedPdf(4); // 600,601,602,603
  const moveOp: PdfStructuralOperation = {
    type: "movePage",
    pageIndex: 1,
    direction: 1,
  };

  const afterMove = await applyStructuralOperationBytes(original, moveOp);
  assert.deepEqual(await pageWidths(afterMove), [600, 602, 601, 603]);

  const undoOp = await invertStructuralOperation(moveOp, afterMove);
  assert.deepEqual(undoOp, { type: "movePage", pageIndex: 2, direction: -1 });

  const undone = await applyStructuralOperationBytes(afterMove, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602, 603]);

  const redoOp = await invertStructuralOperation(undoOp, undone);
  assert.deepEqual(redoOp, moveOp);
  const redone = await applyStructuralOperationBytes(undone, redoOp);
  assert.deepEqual(await pageWidths(redone), [600, 602, 601, 603]);
});

test("merge-then-undo round trip (insertPages of merged pages, inverted) restores original pages", async () => {
  const original = await buildFingerprintedPdf(3, 600); // 600,601,602
  const mergeSource = await buildFingerprintedPdf(2, 900); // 900,901
  const insertAt = 3; // merge after the last page
  const mergeOp: PdfStructuralOperation = {
    type: "insertPages",
    atIndex: insertAt,
    copiedNames: new Map(),
    pageCount: 2,
    pagesBytes: mergeSource,
  };

  const afterMerge = await applyStructuralOperationBytes(original, mergeOp);
  assert.deepEqual(await pageWidths(afterMerge), [600, 601, 602, 900, 901]);

  const undoOp = await invertStructuralOperation(mergeOp, afterMerge);
  assert.deepEqual(undoOp, {
    type: "removePages",
    startIndex: insertAt,
    count: 2,
  });

  const undone = await applyStructuralOperationBytes(afterMerge, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602]);
});

test("multi-step sequence: rotate, delete, add, then undo x3, redo x3 stays consistent", async () => {
  let bytes = await buildFingerprintedPdf(4); // 600,601,602,603
  const undoStack: PdfStructuralOperation[] = [];
  const redoStack: PdfStructuralOperation[] = [];

  async function apply(operation: PdfStructuralOperation) {
    const undoOperation = await invertStructuralOperation(operation, bytes);
    bytes = await applyStructuralOperationBytes(bytes, operation);
    undoStack.push(undoOperation);
    redoStack.length = 0;
  }

  async function undo() {
    const operation = undoStack.pop();
    if (!operation) return;
    const redoOperation = await invertStructuralOperation(operation, bytes);
    bytes = await applyStructuralOperationBytes(bytes, operation);
    redoStack.push(redoOperation);
  }

  async function redo() {
    const operation = redoStack.pop();
    if (!operation) return;
    const undoOperation = await invertStructuralOperation(operation, bytes);
    bytes = await applyStructuralOperationBytes(bytes, operation);
    undoStack.push(undoOperation);
  }

  await apply({ type: "rotatePage", pageIndex: 0, deltaDegrees: 90 });
  assert.deepEqual(await pageWidths(bytes), [600, 601, 602, 603]);
  assert.equal((await loadTestPdf(bytes)).getPage(0).getRotation().angle, 90);

  // apply() extracts the page internally, as handleDeletePage builds undo.
  await apply({
    type: "removePages",
    startIndex: 2,
    count: 1,
  });
  assert.deepEqual(await pageWidths(bytes), [600, 601, 603]);

  const newPage = await buildFingerprintedPdf(1, 950);
  await apply({
    type: "insertPages",
    atIndex: 1,
    copiedNames: new Map(),
    pageCount: 1,
    pagesBytes: newPage,
  });
  assert.deepEqual(await pageWidths(bytes), [600, 950, 601, 603]);

  await undo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 603]);
  await undo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 602, 603]);
  await undo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 602, 603]);
  assert.equal((await loadTestPdf(bytes)).getPage(0).getRotation().angle, 0);

  await redo();
  assert.equal((await loadTestPdf(bytes)).getPage(0).getRotation().angle, 90);
  await redo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 603]);
  await redo();
  assert.deepEqual(await pageWidths(bytes), [600, 950, 601, 603]);
});

// A name that is none of the three the assertion allows is an identity the
// writer will refuse.
const INDIRECT_PAGES = ["A", "B", "C", "D"];

async function structuralOperations(
  bytes: Uint8Array,
): Promise<{ name: string; operation: PdfStructuralOperation }[]> {
  const extracted = await extractPagesBytes(bytes, 1, 1);
  return [
    {
      name: "rotate",
      operation: { deltaDegrees: 90, pageIndex: 1, type: "rotatePage" },
    },
    {
      name: "move",
      operation: { direction: 1, pageIndex: 1, type: "movePage" },
    },
    {
      name: "remove",
      operation: { count: 1, startIndex: 1, type: "removePages" },
    },
    {
      name: "undo of a remove",
      operation: {
        atIndex: 1,
        copiedNames: extracted.copiedNames,
        pageCount: extracted.pageCount,
        pagesBytes: extracted.bytes,
        type: "insertPages",
      },
    },
  ];
}

async function referencedAnnotations(bytes: Uint8Array) {
  const entries = await annotationEntries(bytes);
  return new Map(
    entries.flatMap((page, pageIndex) =>
      page.map(
        (entry) => [entry.reference, { pageIndex, text: entry.text }] as const,
      ),
    ),
  );
}

for (const shape of ["as it is", "with the page removed first"] as const) {
  test(`every operation ${shape} leaves each annotation under a name the file has`, async () => {
    const original = await indirectAnnotationPdf(INDIRECT_PAGES);
    // The second shape is delete-then-undo: the operation under test is the
    // inversion that brings the page back.
    const bytes =
      shape === "as it is"
        ? original
        : (
            await applyStructuralOperation(original, {
              count: 1,
              startIndex: 1,
              type: "removePages",
            })
          ).bytes;

    for (const { name, operation } of await structuralOperations(original)) {
      if (
        shape === "with the page removed first" &&
        operation.type !== "insertPages"
      ) {
        continue;
      }

      const before = await referencedAnnotations(bytes);
      const { bytes: after, renames } = await applyStructuralOperation(
        bytes,
        operation,
      );
      const held = await referencedAnnotations(after);

      // The one legitimate way for a name to stop naming anything: the page it was on
      // left the document, and the dictionary left with it.
      const mapping = pageMappingFor(pageOrderChangeOfOperation(operation));

      for (const [reference, { pageIndex, text }] of before) {
        if (mapping.forward(pageIndex) === null) {
          continue;
        }

        const key = canonicalReferenceKey(reference);
        const renamed = renames.get(key);
        const nameNow = renamed ?? reference;
        assert.equal(
          held.get(nameNow)?.text,
          text,
          `${name}: ${text} was ${reference}, is named ${nameNow}, and the file holds ${JSON.stringify([...held])}`,
        );
      }
    }
  });
}

function canonicalReferenceKey(reference: string) {
  const match = /^(\d+)\s+(\d+)\s+R$/.exec(reference);
  return match ? `ref:${Number(match[1])}:${Number(match[2])}` : reference;
}

test("the three operations that relink rename nothing", async () => {
  const bytes = await indirectAnnotationPdf(INDIRECT_PAGES);
  for (const { name, operation } of await structuralOperations(bytes)) {
    if (operation.type === "insertPages") {
      continue;
    }
    const { renames } = await applyStructuralOperation(bytes, operation);
    assert.equal(renames.size, 0, `${name} reported a rename`);
  }
});

// A merged file's `5 0 R` is not this document's, so reporting it would rename a
// live identity onto a stranger's annotation.
test("inserted pages that never left this document rename nothing", async () => {
  const target = await indirectAnnotationPdf(["A", "B"]);
  const elsewhere = await indirectAnnotationPdf(["X"]);
  const { renames } = await insertPagesFromBytes(target, 1, elsewhere);
  assert.equal(renames.size, 0);
});

test("the undo of a delete reports the name every annotation came back under", async () => {
  const bytes = await indirectAnnotationPdf(INDIRECT_PAGES);
  const extracted = await extractPagesBytes(bytes, 1, 1);
  const { bytes: afterDelete } = await applyStructuralOperation(bytes, {
    count: 1,
    startIndex: 1,
    type: "removePages",
  });
  const before = await referencedAnnotations(bytes);
  const { bytes: afterUndo, renames } = await applyStructuralOperation(
    afterDelete,
    {
      atIndex: 1,
      copiedNames: extracted.copiedNames,
      pageCount: extracted.pageCount,
      pagesBytes: extracted.bytes,
      type: "insertPages",
    },
  );

  assert.equal(renames.size, 1);
  const [[key, renamed]] = [...renames];
  const wasCalled = [...before].find(
    ([reference]) => canonicalReferenceKey(reference) === key,
  );
  assert.ok(wasCalled, `renamed ${key}, which the file never held`);
  assert.notEqual(renamed, wasCalled[0]);
  assert.equal(
    (await referencedAnnotations(afterUndo)).get(renamed)?.text,
    "B",
  );
});

// Copying a page renames every annotation on it and removing one leaves
// everything it owned in the context, so a second call to either is a second
// place for that to go unreported. `movePageBy` is the one that must not go
// through `dropPages`, because it re-links the same page. The scan is over the
// whole of `src/`: a copy added in `pdfWriter.ts` would pass a narrower check.
test("only pdfPageOperations copies or drops a page, and only where it says", async () => {
  const sourceDir = new URL("../src/", import.meta.url);
  const files = await readdir(sourceDir, { recursive: true });
  const callers: string[] = [];
  for (const file of files.sort()) {
    if (!/\.tsx?$/.test(file)) {
      continue;
    }
    const source = await readFile(new URL(file, sourceDir), "utf8");
    for (const line of source.split("\n")) {
      if (/\.(copyPages|removePage)\(/.test(line)) {
        callers.push(`${file}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(callers.sort(), [
    "pdfdocumenteditor/pdfPageOperations.ts: const pages = await target.copyPages(source, pageIndexes);",
    "pdfdocumenteditor/pdfPageOperations.ts: pdfDoc.removePage(pageIndex);",
    "pdfdocumenteditor/pdfPageOperations.ts: pdfDoc.removePage(startIndex);",
  ]);
});
