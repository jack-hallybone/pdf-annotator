import { PDFDocument, rgb } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import {
  A4_SIZE,
  cornellHeaderDividerY,
  cornellSummaryDividerY,
  lineSpacing,
  ruledBottom,
  ruledLineEpsilon,
  ruledTop,
  templateFileName,
  templateMarginX,
  type PdfTemplateKind,
} from "./pdfTemplateGeometry";

// Drawing only - the shared geometry lives in pdfTemplateGeometry.ts so the tab
// shell can read it without pulling pdf-lib into the initial chunk.
const templateLineColor = rgb(0.58, 0.66, 0.7);
const templateDividerColor = rgb(0.5, 0.56, 0.58);
const templateMarginColor = rgb(0.68, 0.72, 0.74);

export async function createPdfTemplate(kind: PdfTemplateKind) {
  const pdfDoc = await PDFDocument.create();
  // Overrides pdf-lib's own default Producer/Creator string: a template this
  // app creates from nothing must not name anything else, personal or not.
  pdfDoc.setAuthor("");
  pdfDoc.setCreator("PDF Annotator");
  pdfDoc.setKeywords([]);
  pdfDoc.setProducer("PDF Annotator");
  pdfDoc.setSubject("");
  pdfDoc.setTitle("");
  const page = pdfDoc.addPage(A4_SIZE);

  if (kind === "a4Lined") {
    drawLinedPage(page);
  }

  if (kind === "a4Cornell") {
    drawCornellPage(page);
  }

  return {
    bytes: await pdfDoc.save(),
    name: templateFileName(kind),
  };
}

function drawLinedPage(page: PDFPage) {
  const left = templateMarginX;

  drawVerticalGuide(page, {
    bottom: 0,
    top: A4_SIZE[1],
    x: left + 24,
  });
  drawRuledLines(page, {
    bottom: ruledBottom,
    left: 0,
    right: A4_SIZE[0],
    top: ruledTop,
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
    top: headerDividerY,
  });
  drawRuledLines(page, {
    bottom: ruledBottom,
    left: 0,
    right: A4_SIZE[0],
    top: summaryTop - ruledLineEpsilon,
  });

  page.drawLine({
    start: { x: cueColumnRight, y: summaryTop },
    end: { x: cueColumnRight, y: headerDividerY },
    color: templateDividerColor,
    thickness: 1,
  });
  page.drawLine({
    start: { x: 0, y: summaryTop },
    end: { x: A4_SIZE[0], y: summaryTop },
    color: templateDividerColor,
    thickness: 1,
  });
  page.drawLine({
    start: { x: 0, y: headerDividerY },
    end: { x: A4_SIZE[0], y: headerDividerY },
    color: templateDividerColor,
    opacity: 0.82,
    thickness: 0.8,
  });
}

function drawRuledLines(
  page: PDFPage,
  {
    bottom,
    left,
    right,
    top,
  }: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  },
) {
  for (const y of ruledLineYs(top, bottom)) {
    page.drawLine({
      start: { x: left, y },
      end: { x: right, y },
      color: templateLineColor,
      opacity: 0.58,
      thickness: 0.6,
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

function drawVerticalGuide(
  page: PDFPage,
  {
    bottom,
    top,
    x,
  }: {
    bottom: number;
    top: number;
    x: number;
  },
) {
  page.drawLine({
    start: { x, y: bottom },
    end: { x, y: top },
    color: templateMarginColor,
    opacity: 0.34,
    thickness: 0.6,
  });
}
