import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';

export type PdfTemplateKind = 'a4Blank' | 'a4Lined' | 'a4Cornell';

const A4_SIZE: [number, number] = [595.28, 841.89];
const templateMarginX = 42;
const cornellTitleTopMargin = 35;
const cornellTop = A4_SIZE[1] - 48;
const cornellHeaderDividerY = cornellTop - 54;
const templateLineColor = rgb(0.58, 0.66, 0.7);
const templateDividerColor = rgb(0.5, 0.56, 0.58);
const templateMarginColor = rgb(0.68, 0.72, 0.74);
const lineSpacing = 24;

export const CORNELL_CONTENT_BOUNDS = {
  left: templateMarginX,
  right: A4_SIZE[0] - templateMarginX,
  titleTop: A4_SIZE[1] - cornellTitleTopMargin,
  titleWidth: A4_SIZE[0] - templateMarginX * 2
};

export async function createPdfTemplate(kind: PdfTemplateKind) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage(A4_SIZE);

  if (kind === 'a4Lined') {
    drawLinedPage(page);
  }

  if (kind === 'a4Cornell') {
    drawCornellPage(page);
  }

  return {
    bytes: await pdfDoc.save(),
    name: templateFileName(kind)
  };
}

function drawLinedPage(page: PDFPage) {
  const left = templateMarginX;
  const right = A4_SIZE[0] - templateMarginX;
  const top = A4_SIZE[1] - 60;
  const bottom = 60;

  drawVerticalGuide(page, {
    bottom,
    top,
    x: left + 30
  });
  drawHorizontalLines(page, {
    left,
    right,
    top,
    bottom,
    step: lineSpacing
  });
}

function drawCornellPage(page: PDFPage) {
  const left = CORNELL_CONTENT_BOUNDS.left;
  const right = CORNELL_CONTENT_BOUNDS.right;
  const bottom = 48;
  const cueColumnRight = 184;
  const summaryTop = 168;
  const headerDividerY = cornellHeaderDividerY;
  const firstNoteLineY = headerDividerY - lineSpacing;

  page.drawLine({
    start: { x: cueColumnRight, y: summaryTop },
    end: { x: cueColumnRight, y: headerDividerY },
    color: templateDividerColor,
    thickness: 1
  });
  page.drawLine({
    start: { x: left, y: summaryTop },
    end: { x: right, y: summaryTop },
    color: templateDividerColor,
    thickness: 1
  });
  page.drawLine({
    start: { x: left, y: headerDividerY },
    end: { x: right, y: headerDividerY },
    color: templateDividerColor,
    opacity: 0.82,
    thickness: 0.8
  });

  drawHorizontalLines(page, {
    left: cueColumnRight + 18,
    right,
    top: firstNoteLineY,
    bottom: summaryTop + 18,
    step: lineSpacing
  });
  drawHorizontalLines(page, {
    left,
    right: cueColumnRight - 18,
    top: firstNoteLineY,
    bottom: summaryTop + 18,
    step: lineSpacing
  });
  drawHorizontalLines(page, {
    left,
    right,
    top: summaryTop - lineSpacing,
    bottom,
    step: lineSpacing
  });
}

function drawHorizontalLines(
  page: PDFPage,
  {
    bottom,
    left,
    right,
    step,
    top
  }: {
    bottom: number;
    left: number;
    right: number;
    step: number;
    top: number;
  }
) {
  for (let y = top; y >= bottom; y -= step) {
    page.drawLine({
      start: { x: left, y },
      end: { x: right, y },
      color: templateLineColor,
      opacity: 0.58,
      thickness: 0.6
    });
  }
}

function drawVerticalGuide(
  page: PDFPage,
  {
    bottom,
    top,
    x
  }: {
    bottom: number;
    top: number;
    x: number;
  }
) {
  page.drawLine({
    start: { x, y: bottom },
    end: { x, y: top },
    color: templateMarginColor,
    opacity: 0.34,
    thickness: 0.6
  });
}

function templateFileName(kind: PdfTemplateKind) {
  switch (kind) {
    case 'a4Blank':
      return 'a4-blank.pdf';
    case 'a4Lined':
      return 'a4-lined.pdf';
    case 'a4Cornell':
      return 'a4-cornell-notes.pdf';
  }
}
