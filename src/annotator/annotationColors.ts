import { AnnotationType } from 'pdfjs-dist';
import type { ExistingPdfAnnotation } from './annotationImport';

export function rgbToCss([r, g, b]: [number, number, number]) {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(
    b * 255
  )})`;
}

export function rgbToCssWithAlpha(
  [r, g, b]: [number, number, number],
  alpha: number
) {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(
    b * 255
  )} / ${alpha})`;
}

export function pdfjsColorToCss(
  color: number[] | Uint8ClampedArray | null | undefined,
  fallback: string
) {
  if (!color || color.length < 3) {
    return fallback;
  }

  const multiplier = Math.max(...Array.from(color)) <= 1 ? 255 : 1;
  return `rgb(${Math.round(color[0] * multiplier)} ${Math.round(
    color[1] * multiplier
  )} ${Math.round(color[2] * multiplier)})`;
}

export function existingInkColor(
  annotation: ExistingPdfAnnotation,
  fallback: string,
  asHighlight: boolean
) {
  const highlightFallback = 'rgb(255 209 31)';
  const color = pdfjsColorToRgbValue(
    annotation.interiorColor ?? annotation.color,
    asHighlight ? [1, 0.82, 0.12] : [0, 0, 0]
  );

  if (asHighlight && color[0] < 0.08 && color[1] < 0.08 && color[2] < 0.08) {
    return highlightFallback;
  }

  return pdfjsColorToCss(
    annotation.interiorColor ?? annotation.color,
    asHighlight ? highlightFallback : fallback
  );
}

export function existingInkOpacity(
  annotation: ExistingPdfAnnotation,
  asHighlight: boolean
) {
  const opacity = existingInkRawOpacity(annotation);
  if (opacity !== null && (!asHighlight || opacity < 0.95)) {
    return opacity;
  }

  return asHighlight ? 0.35 : 1;
}

function existingInkRawOpacity(annotation: ExistingPdfAnnotation) {
  const opacity = annotation.ca ?? annotation.opacity;
  return typeof opacity === 'number' ? opacity : null;
}

export function existingInkWidth(
  annotation: ExistingPdfAnnotation,
  asHighlight = false
) {
  const width = Math.max(annotation.borderStyle?.width ?? annotation.width ?? 2, 1.5);
  return asHighlight ? Math.max(width, 8) : width;
}

function pdfjsColorToRgbValue(
  color: number[] | Uint8ClampedArray | null | undefined,
  fallback: [number, number, number]
): [number, number, number] {
  if (!color || color.length < 3) {
    return fallback;
  }

  const divisor = Math.max(...Array.from(color)) > 1 ? 255 : 1;
  return [color[0] / divisor, color[1] / divisor, color[2] / divisor];
}

export function isSvgRenderedExistingAnnotation(annotation: ExistingPdfAnnotation) {
  return [
    AnnotationType.HIGHLIGHT,
    AnnotationType.UNDERLINE,
    AnnotationType.SQUIGGLY,
    AnnotationType.STRIKEOUT,
    AnnotationType.INK,
    AnnotationType.FREETEXT,
    AnnotationType.TEXT,
    AnnotationType.SQUARE,
    AnnotationType.CIRCLE,
    AnnotationType.LINE
  ].includes(annotation.annotationType);
}

export function isEditableExistingAnnotation(annotation: ExistingPdfAnnotation) {
  return [
    AnnotationType.HIGHLIGHT,
    AnnotationType.INK,
    AnnotationType.FREETEXT,
    AnnotationType.TEXT
  ].includes(annotation.annotationType);
}
