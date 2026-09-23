// Millimetres to PDF user-space units, honouring a page's /UserUnit scale.
import type { PageViewport } from "./types";

const MILLIMETRES_PER_INCH = 25.4;
const PDF_UNITS_PER_INCH = 72;

function viewportUserUnit(viewport: PageViewport) {
  return Number.isFinite(viewport.userUnit) && viewport.userUnit > 0
    ? viewport.userUnit
    : 1;
}

export function millimetresToPdfUnits(
  millimetres: number,
  viewport: PageViewport,
) {
  return (
    (millimetres * PDF_UNITS_PER_INCH) /
    MILLIMETRES_PER_INCH /
    viewportUserUnit(viewport)
  );
}

export function pdfUnitsToMillimetres(
  pdfUnits: number,
  viewport: PageViewport,
) {
  return (
    (pdfUnits * MILLIMETRES_PER_INCH * viewportUserUnit(viewport)) /
    PDF_UNITS_PER_INCH
  );
}
