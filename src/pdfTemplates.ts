import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';

export type PdfTemplateKind = 'a4Blank' | 'a4Lined' | 'a4Cornell';

const A4_SIZE: [number, number] = [595.28, 841.89];
const templateMarginX = 36;
const cornellTitleTopMargin = 35;
const cornellTop = A4_SIZE[1] - 48;
const cornellHeaderDividerY = cornellTop - 54;
const templateLineColor = rgb(0.58, 0.66, 0.7);
const templateDividerColor = rgb(0.5, 0.56, 0.58);
const templateMarginColor = rgb(0.68, 0.72, 0.74);
const millimetresPerInch = 25.4;
const pdfPointsPerInch = 72;
const lineSpacing = (8 / millimetresPerInch) * pdfPointsPerInch;
const ruledTop = A4_SIZE[1] - 60;
const ruledBottom = 60 - lineSpacing;
const ruledLineEpsilon = 0.01;
const cornellSummaryDividerY = ruledLineNear(168);

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

  drawVerticalGuide(page, {
    bottom: 0,
    top: A4_SIZE[1],
    x: left + 24
  });
  drawRuledLines(page, {
    bottom: ruledBottom,
    left: 0,
    right: A4_SIZE[0],
    top: ruledTop
  });
}

function drawCornellPage(page: PDFPage) {
  const cueColumnRight = 184;
  const summaryTop = cornellSummaryDividerY;
  const headerDividerY = cornellHeaderDividerY;

  drawRuledLines(page, {
    bottom: summaryTop + ruledLineEpsilon,
    left: 0,
    right: A4_SIZE[0],
    top: headerDividerY
  });
  drawRuledLines(page, {
    bottom: ruledBottom,
    left: 0,
    right: A4_SIZE[0],
    top: summaryTop - ruledLineEpsilon
  });

  page.drawLine({
    start: { x: cueColumnRight, y: summaryTop },
    end: { x: cueColumnRight, y: headerDividerY },
    color: templateDividerColor,
    thickness: 1
  });
  page.drawLine({
    start: { x: 0, y: summaryTop },
    end: { x: A4_SIZE[0], y: summaryTop },
    color: templateDividerColor,
    thickness: 1
  });
  page.drawLine({
    start: { x: 0, y: headerDividerY },
    end: { x: A4_SIZE[0], y: headerDividerY },
    color: templateDividerColor,
    opacity: 0.82,
    thickness: 0.8
  });
}

function drawRuledLines(
  page: PDFPage,
  {
    bottom,
    left,
    right,
    top
  }: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  }
) {
  for (const y of ruledLineYs(top, bottom)) {
    page.drawLine({
      start: { x: left, y },
      end: { x: right, y },
      color: templateLineColor,
      opacity: 0.58,
      thickness: 0.6
    });
  }
}

function ruledLineYs(top: number, bottom: number) {
  const lines: number[] = [];
  for (let y = ruledBottom; y <= ruledTop; y += lineSpacing) {
    if (y <= top && y >= bottom) {
      lines.push(y);
    }
  }
  return lines.reverse();
}

function ruledLineNear(targetY: number) {
  const maxIndex = Math.floor((ruledTop - ruledBottom) / lineSpacing);
  const index = Math.min(
    Math.max(Math.round((targetY - ruledBottom) / lineSpacing), 0),
    maxIndex
  );
  return ruledBottom + index * lineSpacing;
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
