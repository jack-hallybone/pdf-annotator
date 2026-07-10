// Ink drawing-gesture capture: turning a stream of raw pointer points into a
// clean stored ink path. Extracted from PdfPageView so the capture tuning
// (how densely to sample, how aggressively to simplify, what counts as a dot
// vs a stroke) lives apart from the canvas rendering of the finished strokes.
// All distances are derived from real millimetres via pdfUnits so they stay
// consistent across zoom levels and page /UserUnit scales.
import { resampleInkPath, simplifyInkPath } from './annotationGeometry';
import { millimetresToPdfUnits } from './pdfUnits';
import type { PageViewport, PdfPoint } from './types';

const INK_CAPTURE_SPACING_MM = 0.05;
const INK_POINT_SPACING_MM = 0.15;
const INK_SIMPLIFICATION_TOLERANCE_MM = 0.05;
const INK_DOT_MAX_LENGTH_MM = 0.35;
const FREEHAND_HIGHLIGHT_MIN_LENGTH_MM = 1;

export function appendDraftInkPoints(
  path: PdfPoint[],
  points: PdfPoint[],
  viewport: PageViewport
) {
  const minDistance = inkCaptureSpacing(viewport);
  for (const point of points) {
    appendMutableInkPoint(path, point, minDistance);
  }
  return path;
}

export function appendMutableInkPoint(
  path: PdfPoint[],
  point: PdfPoint,
  minDistance: number
) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return;
  }

  const previous = path[path.length - 1];
  if (
    previous &&
    Math.hypot(point.x - previous.x, point.y - previous.y) < minDistance
  ) {
    return;
  }

  path.push(point);
}

export function normalizeDraftInkPath(path: PdfPoint[], viewport: PageViewport) {
  const resampled = resampleInkPath(path, inkPointSpacing(viewport));
  return simplifyInkPath(resampled, inkSimplificationTolerance(viewport));
}

function inkCaptureSpacing(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_CAPTURE_SPACING_MM, viewport);
}

function inkPointSpacing(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_POINT_SPACING_MM, viewport);
}

function inkSimplificationTolerance(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_SIMPLIFICATION_TOLERANCE_MM, viewport);
}

export function inkDotMaxLength(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_DOT_MAX_LENGTH_MM, viewport);
}

export function freehandHighlightMinLength(viewport: PageViewport) {
  return millimetresToPdfUnits(FREEHAND_HIGHLIGHT_MIN_LENGTH_MM, viewport);
}
