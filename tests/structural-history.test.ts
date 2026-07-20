import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  applyStructuralOperation,
  extractPagesBytes,
  insertPagesFromBytes,
  invertStructuralOperation,
  movePageBy,
  removePagesRange,
  rotatePageByDelta,
  type PdfStructuralOperation
} from '../src/workspace/pdfPageOperations';
import { loadTestPdf } from './pdfTestUtils';

// Each page gets a distinct width so page identity/order can be verified
// through operations without needing real content or text extraction.
async function buildFingerprintedPdf(pageCount: number, startWidth = 600) {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    doc.addPage([startWidth + index, 792]);
  }
  return doc.save();
}

async function pageWidths(bytes: Uint8Array) {
  const doc = await loadTestPdf(bytes);
  return doc.getPages().map((page) => page.getWidth());
}

test('rotatePageByDelta applies and normalizes rotation deltas', async () => {
  const bytes = await buildFingerprintedPdf(1);
  const rotated = await rotatePageByDelta(bytes, 0, 90);
  const doc = await loadTestPdf(rotated);
  assert.equal(doc.getPage(0).getRotation().angle, 90);

  const rotatedBack = await rotatePageByDelta(rotated, 0, -90);
  assert.equal(
    (await loadTestPdf(rotatedBack)).getPage(0).getRotation().angle,
    0
  );

  const negativeNormalized = await rotatePageByDelta(bytes, 0, -90);
  assert.equal(
    (await loadTestPdf(negativeNormalized)).getPage(0).getRotation().angle,
    270
  );
});

test('removePagesRange removes the correct contiguous pages', async () => {
  const bytes = await buildFingerprintedPdf(5); // widths 600..604
  const removed = await removePagesRange(bytes, 1, 2); // remove widths 601, 602
  assert.deepEqual(await pageWidths(removed), [600, 603, 604]);
});

test('insertPagesFromBytes inserts pages at the correct index and order', async () => {
  const target = await buildFingerprintedPdf(3, 600); // 600,601,602
  const source = await buildFingerprintedPdf(2, 900); // 900,901
  const inserted = await insertPagesFromBytes(target, 1, source);
  assert.deepEqual(await pageWidths(inserted), [600, 900, 901, 601, 602]);
});

test('extractPagesBytes produces a standalone document with the right pages', async () => {
  const bytes = await buildFingerprintedPdf(5); // 600..604
  const extracted = await extractPagesBytes(bytes, 2, 2); // widths 602, 603
  assert.equal(extracted.pageCount, 2);
  assert.deepEqual(await pageWidths(extracted.bytes), [602, 603]);
});

test('delete-then-undo round trip (removePages inverted via extraction) restores original pages', async () => {
  const original = await buildFingerprintedPdf(5); // 600..604
  const deleteOp: PdfStructuralOperation = {
    type: 'removePages',
    startIndex: 2,
    count: 1
  };

  // Mirrors handleDeletePage: extract the page being deleted BEFORE
  // removing it, to build the undo operation.
  const extracted = await extractPagesBytes(original, 2, 1);
  const undoOp: PdfStructuralOperation = {
    type: 'insertPages',
    atIndex: 2,
    pageCount: extracted.pageCount,
    pagesBytes: extracted.bytes
  };

  const afterDelete = await applyStructuralOperation(original, deleteOp);
  assert.deepEqual(await pageWidths(afterDelete), [600, 601, 603, 604]);

  const undone = await applyStructuralOperation(afterDelete, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602, 603, 604]);

  // invertStructuralOperation should derive the same redo operation back
  const redoOp = await invertStructuralOperation(undoOp, undone);
  assert.equal(redoOp.type, 'removePages');
  const redone = await applyStructuralOperation(undone, redoOp);
  assert.deepEqual(await pageWidths(redone), [600, 601, 603, 604]);
});

test('add-then-undo round trip (insertPages inverted to removePages) restores original pages', async () => {
  const original = await buildFingerprintedPdf(3); // 600,601,602
  const blankPage = await buildFingerprintedPdf(1, 950);
  const addOp: PdfStructuralOperation = {
    type: 'insertPages',
    atIndex: 1,
    pageCount: 1,
    pagesBytes: blankPage
  };

  const afterAdd = await applyStructuralOperation(original, addOp);
  assert.deepEqual(await pageWidths(afterAdd), [600, 950, 601, 602]);

  const undoOp = await invertStructuralOperation(addOp, afterAdd);
  assert.deepEqual(undoOp, { type: 'removePages', startIndex: 1, count: 1 });

  const undone = await applyStructuralOperation(afterAdd, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602]);
});

test('rotate-then-undo round trip inverts the rotation delta', async () => {
  const original = await buildFingerprintedPdf(2);
  const rotateOp: PdfStructuralOperation = {
    type: 'rotatePage',
    pageIndex: 1,
    deltaDegrees: 90
  };

  const afterRotate = await applyStructuralOperation(original, rotateOp);
  assert.equal(
    (await loadTestPdf(afterRotate)).getPage(1).getRotation().angle,
    90
  );

  const undoOp = await invertStructuralOperation(rotateOp, afterRotate);
  assert.deepEqual(undoOp, {
    type: 'rotatePage',
    pageIndex: 1,
    deltaDegrees: -90
  });

  const undone = await applyStructuralOperation(afterRotate, undoOp);
  assert.equal(
    (await loadTestPdf(undone)).getPage(1).getRotation().angle,
    0
  );
});

test('movePageBy swaps a page with its neighbor in either direction', async () => {
  const bytes = await buildFingerprintedPdf(4); // 600,601,602,603
  const movedDown = await movePageBy(bytes, 1, 1); // swap 601 and 602
  assert.deepEqual(await pageWidths(movedDown), [600, 602, 601, 603]);

  const movedUp = await movePageBy(bytes, 2, -1); // swap 601 and 602
  assert.deepEqual(await pageWidths(movedUp), [600, 602, 601, 603]);

  // Boundary swaps (first/last page) work the same way.
  assert.deepEqual(
    await pageWidths(await movePageBy(bytes, 0, 1)),
    [601, 600, 602, 603]
  );
  assert.deepEqual(
    await pageWidths(await movePageBy(bytes, 3, -1)),
    [600, 601, 603, 602]
  );
});

test('movePageBy rejects moving past either edge of the document', async () => {
  const bytes = await buildFingerprintedPdf(3);
  await assert.rejects(() => movePageBy(bytes, 0, -1));
  await assert.rejects(() => movePageBy(bytes, 2, 1));
});

test('move-then-undo round trip (movePage inverted) restores original order', async () => {
  const original = await buildFingerprintedPdf(4); // 600,601,602,603
  const moveOp: PdfStructuralOperation = {
    type: 'movePage',
    pageIndex: 1,
    direction: 1
  };

  const afterMove = await applyStructuralOperation(original, moveOp);
  assert.deepEqual(await pageWidths(afterMove), [600, 602, 601, 603]);

  const undoOp = await invertStructuralOperation(moveOp, afterMove);
  assert.deepEqual(undoOp, { type: 'movePage', pageIndex: 2, direction: -1 });

  const undone = await applyStructuralOperation(afterMove, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602, 603]);

  const redoOp = await invertStructuralOperation(undoOp, undone);
  assert.deepEqual(redoOp, moveOp);
  const redone = await applyStructuralOperation(undone, redoOp);
  assert.deepEqual(await pageWidths(redone), [600, 602, 601, 603]);
});

test('merge-then-undo round trip (insertPages of merged pages, inverted) restores original pages', async () => {
  const original = await buildFingerprintedPdf(3, 600); // 600,601,602
  const mergeSource = await buildFingerprintedPdf(2, 900); // 900,901
  const insertAt = 3; // merge after the last page
  const mergeOp: PdfStructuralOperation = {
    type: 'insertPages',
    atIndex: insertAt,
    pageCount: 2,
    pagesBytes: mergeSource
  };

  const afterMerge = await applyStructuralOperation(original, mergeOp);
  assert.deepEqual(await pageWidths(afterMerge), [600, 601, 602, 900, 901]);

  const undoOp = await invertStructuralOperation(mergeOp, afterMerge);
  assert.deepEqual(undoOp, {
    type: 'removePages',
    startIndex: insertAt,
    count: 2
  });

  const undone = await applyStructuralOperation(afterMerge, undoOp);
  assert.deepEqual(await pageWidths(undone), [600, 601, 602]);
});

test('multi-step sequence: rotate, delete, add, then undo x3, redo x3 stays consistent', async () => {
  let bytes = await buildFingerprintedPdf(4); // 600,601,602,603
  const undoStack: PdfStructuralOperation[] = [];
  const redoStack: PdfStructuralOperation[] = [];

  async function apply(operation: PdfStructuralOperation) {
    const undoOperation = await invertStructuralOperation(operation, bytes);
    bytes = await applyStructuralOperation(bytes, operation);
    undoStack.push(undoOperation);
    redoStack.length = 0;
  }

  async function undo() {
    const operation = undoStack.pop();
    if (!operation) return;
    const redoOperation = await invertStructuralOperation(operation, bytes);
    bytes = await applyStructuralOperation(bytes, operation);
    redoStack.push(redoOperation);
  }

  async function redo() {
    const operation = redoStack.pop();
    if (!operation) return;
    const undoOperation = await invertStructuralOperation(operation, bytes);
    bytes = await applyStructuralOperation(bytes, operation);
    undoStack.push(undoOperation);
  }

  // Step 1: rotate page 0
  await apply({ type: 'rotatePage', pageIndex: 0, deltaDegrees: 90 });
  assert.deepEqual(await pageWidths(bytes), [600, 601, 602, 603]);
  assert.equal((await loadTestPdf(bytes)).getPage(0).getRotation().angle, 90);

  // Step 2: delete page 2 (width 602) - apply() extracts it internally via
  // invertStructuralOperation, mirroring how handleDeletePage builds undo.
  await apply({
    type: 'removePages',
    startIndex: 2,
    count: 1
  });
  assert.deepEqual(await pageWidths(bytes), [600, 601, 603]);

  // Step 3: add a new page at index 1
  const newPage = await buildFingerprintedPdf(1, 950);
  await apply({
    type: 'insertPages',
    atIndex: 1,
    pageCount: 1,
    pagesBytes: newPage
  });
  assert.deepEqual(await pageWidths(bytes), [600, 950, 601, 603]);

  // Undo x3 back to original
  await undo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 603]);
  await undo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 602, 603]);
  await undo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 602, 603]);
  assert.equal((await loadTestPdf(bytes)).getPage(0).getRotation().angle, 0);

  // Redo x3 forward again
  await redo();
  assert.equal((await loadTestPdf(bytes)).getPage(0).getRotation().angle, 90);
  await redo();
  assert.deepEqual(await pageWidths(bytes), [600, 601, 603]);
  await redo();
  assert.deepEqual(await pageWidths(bytes), [600, 950, 601, 603]);
});
