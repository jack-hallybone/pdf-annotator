// Page geometry for the built-in templates, kept apart from pdfTemplates.ts so
// that the shell can read these numbers without pulling in pdf-lib.

export type PdfTemplateKind = "a4Blank" | "a4Lined" | "a4Cornell";

export const A4_SIZE: [number, number] = [595.28, 841.89];
export const templateMarginX = 36;

const cornellTitleTopMargin = 35;
const millimetresPerInch = 25.4;
const pdfPointsPerInch = 72;

const cornellTop = A4_SIZE[1] - 48;
export const cornellHeaderDividerY = cornellTop - 54;
export const lineSpacing = (8 / millimetresPerInch) * pdfPointsPerInch;
export const ruledTop = A4_SIZE[1] - 60;
export const ruledBottom = 60 - lineSpacing;
export const ruledLineEpsilon = 0.01;

export const CORNELL_CONTENT_BOUNDS = {
  left: templateMarginX,
  right: A4_SIZE[0] - templateMarginX,
  titleTop: A4_SIZE[1] - cornellTitleTopMargin,
  titleWidth: A4_SIZE[0] - templateMarginX * 2,
};

// Snaps a y to the nearest ruled line, so dividers sit on the ruling rather
// than between two lines.
function ruledLineNear(targetY: number) {
  const maxIndex = Math.floor((ruledTop - ruledBottom) / lineSpacing);
  const index = Math.min(
    Math.max(Math.round((targetY - ruledBottom) / lineSpacing), 0),
    maxIndex,
  );
  return ruledBottom + index * lineSpacing;
}

export const cornellSummaryDividerY = ruledLineNear(168);

export function templateFileName(kind: PdfTemplateKind) {
  switch (kind) {
    case "a4Blank":
      return "a4-blank.pdf";
    case "a4Lined":
      return "a4-lined.pdf";
    case "a4Cornell":
      return "a4-cornell-notes.pdf";
  }
}
