import { PDFDocument, PDFPage, ParseSpeeds, degrees, rgb } from 'pdf-lib';

const linedPageLineColor = rgb(0.58, 0.66, 0.7);
const linedPageMarginColor = rgb(0.68, 0.72, 0.74);
const millimetresPerInch = 25.4;
const pdfPointsPerInch = 72;
const linedPageLineSpacing = (8 / millimetresPerInch) * pdfPointsPerInch;
const pdfLoadOptions = {
  parseSpeed: ParseSpeeds.Fastest,
  updateMetadata: false
};
const pdfSaveOptions = {
  // pdf-lib yields to the event loop every objectsPerTick objects; Infinity
  // disables that entirely; serializing a large document then blocks the
  // main thread (and freezes the UI) for the whole save. A finite value
  // keeps the page responsive during saves on large/many-page documents.
  objectsPerTick: 500,
  updateFieldAppearances: false
};

export function loadEditablePdf(bytes: Uint8Array) {
  return PDFDocument.load(bytes, pdfLoadOptions);
}

export function saveEditedPdf(pdfDoc: PDFDocument) {
  return pdfDoc.save(pdfSaveOptions);
}

export async function addBlankPageAt(
  bytes: Uint8Array,
  pageIndex: number,
  templatePageIndex: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourcePage = pdfDoc.getPage(templatePageIndex);
  const { width, height } = sourcePage.getSize();
  pdfDoc.insertPage(pageIndex, [width, height]);
  return saveEditedPdf(pdfDoc);
}

export async function addLinedPageAt(
  bytes: Uint8Array,
  pageIndex: number,
  templatePageIndex: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourcePage = pdfDoc.getPage(templatePageIndex);
  const { width, height } = sourcePage.getSize();
  const page = pdfDoc.insertPage(pageIndex, [width, height]);
  drawLinedPage(page, width, height);
  return saveEditedPdf(pdfDoc);
}

export async function removePage(bytes: Uint8Array, pageIndex: number) {
  const pdfDoc = await loadEditablePdf(bytes);
  if (pdfDoc.getPageCount() <= 1) {
    throw new Error('A PDF must keep at least one page.');
  }

  pdfDoc.removePage(pageIndex);
  return saveEditedPdf(pdfDoc);
}

export async function rotatePageClockwise(bytes: Uint8Array, pageIndex: number) {
  const pdfDoc = await loadEditablePdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const currentAngle = page.getRotation().angle;
  page.setRotation(degrees((currentAngle + 90) % 360));
  return saveEditedPdf(pdfDoc);
}

export async function mergePdfAfterPage(
  bytes: Uint8Array,
  mergeBytes: Uint8Array,
  afterPageIndex: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const mergeDoc = await loadEditablePdf(mergeBytes);
  const pageIndexes = mergeDoc.getPageIndices();
  const copiedPages = await pdfDoc.copyPages(mergeDoc, pageIndexes);
  const insertAt = Math.min(
    Math.max(afterPageIndex + 1, 0),
    pdfDoc.getPageCount()
  );

  copiedPages.forEach((page, index) => {
    pdfDoc.insertPage(insertAt + index, page);
  });

  return {
    bytes: await saveEditedPdf(pdfDoc),
    insertAt,
    insertedPageCount: copiedPages.length
  };
}

// The following are used to build small, edit-sized undo/redo history
// entries for structural page operations, instead of retaining a full copy
// of the document's bytes per undo step. They're additive - the functions
// above remain the actual forward-edit path and are untouched.

export async function rotatePageByDelta(
  bytes: Uint8Array,
  pageIndex: number,
  deltaDegrees: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const currentAngle = page.getRotation().angle;
  const nextAngle = ((currentAngle + deltaDegrees) % 360 + 360) % 360;
  page.setRotation(degrees(nextAngle));
  return saveEditedPdf(pdfDoc);
}

export async function removePagesRange(
  bytes: Uint8Array,
  startIndex: number,
  count: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  for (let i = 0; i < count; i += 1) {
    pdfDoc.removePage(startIndex);
  }
  return saveEditedPdf(pdfDoc);
}

export async function insertPagesFromBytes(
  bytes: Uint8Array,
  atIndex: number,
  pagesBytes: Uint8Array
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourceDoc = await loadEditablePdf(pagesBytes);
  const pageIndexes = sourceDoc.getPageIndices();
  const copiedPages = await pdfDoc.copyPages(sourceDoc, pageIndexes);
  copiedPages.forEach((page, index) => {
    pdfDoc.insertPage(atIndex + index, page);
  });
  return saveEditedPdf(pdfDoc);
}

export async function extractPagesBytes(
  bytes: Uint8Array,
  startIndex: number,
  count: number
) {
  const sourceDoc = await loadEditablePdf(bytes);
  const pageIndexes = Array.from({ length: count }, (_, index) => startIndex + index);
  const extractedDoc = await PDFDocument.create();
  const copiedPages = await extractedDoc.copyPages(sourceDoc, pageIndexes);
  copiedPages.forEach((page) => extractedDoc.addPage(page));
  return {
    bytes: await saveEditedPdf(extractedDoc),
    pageCount: copiedPages.length
  };
}

export type PdfStructuralOperation =
  | { type: 'rotatePage'; pageIndex: number; deltaDegrees: number }
  | {
      type: 'insertPages';
      atIndex: number;
      pageCount: number;
      pagesBytes: Uint8Array;
    }
  | { type: 'removePages'; startIndex: number; count: number };

export function applyStructuralOperation(
  bytes: Uint8Array,
  operation: PdfStructuralOperation
) {
  switch (operation.type) {
    case 'rotatePage':
      return rotatePageByDelta(bytes, operation.pageIndex, operation.deltaDegrees);
    case 'insertPages':
      return insertPagesFromBytes(bytes, operation.atIndex, operation.pagesBytes);
    case 'removePages':
      return removePagesRange(bytes, operation.startIndex, operation.count);
  }
}

// Given the operation that reaches one history entry's state from the
// current bytes, produces the operation that reaches the OTHER direction
// (current bytes are needed only to extract page content for the
// removePages -> insertPages case; the other two directions are cheap and
// don't need to read the document at all).
export async function invertStructuralOperation(
  operation: PdfStructuralOperation,
  currentBytes: Uint8Array
): Promise<PdfStructuralOperation> {
  switch (operation.type) {
    case 'rotatePage':
      return {
        type: 'rotatePage',
        pageIndex: operation.pageIndex,
        deltaDegrees: -operation.deltaDegrees
      };
    case 'insertPages':
      return {
        type: 'removePages',
        startIndex: operation.atIndex,
        count: operation.pageCount
      };
    case 'removePages': {
      const extracted = await extractPagesBytes(
        currentBytes,
        operation.startIndex,
        operation.count
      );
      return {
        type: 'insertPages',
        atIndex: operation.startIndex,
        pageCount: extracted.pageCount,
        pagesBytes: extracted.bytes
      };
    }
  }
}

function drawLinedPage(page: PDFPage, width: number, height: number) {
  const marginX = Math.min(36, width * 0.075);
  const top = height - Math.min(60, height * 0.08);
  const bottom = Math.max(
    0,
    Math.min(60, height * 0.08) - linedPageLineSpacing
  );
  const guideX = marginX + Math.min(24, width * 0.04);

  page.drawLine({
    start: { x: guideX, y: 0 },
    end: { x: guideX, y: height },
    color: linedPageMarginColor,
    opacity: 0.34,
    thickness: 0.6
  });

  const lineYs: number[] = [];
  for (let y = bottom; y <= top; y += linedPageLineSpacing) {
    lineYs.push(y);
  }
  for (const y of lineYs.reverse()) {
    drawLinedPageRule(page, width, y);
  }
}

function drawLinedPageRule(page: PDFPage, width: number, y: number) {
  page.drawLine({
    start: { x: 0, y },
    end: { x: width, y },
    color: linedPageLineColor,
    opacity: 0.58,
    thickness: 0.6
  });
}
