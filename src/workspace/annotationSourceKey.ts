// Shared low-level primitives for building annotation "source keys" - stable
// identifiers used to match an existing PDF annotation (read from pdf-lib or
// pdfjs, in slightly different raw shapes) to one of our in-memory
// PdfAnnotation objects across saves/imports. Used by both pdfWriter.ts
// (writing back to pdf-lib) and annotationImport.ts (importing from pdfjs).

export function normalizedRectValues(values: number[]) {
  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3])
  ];
}

export function sourceKeyNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}

export function textHash(text: string) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function clampPdfNumber(
  value: number,
  min: number,
  max: number,
  fallback: number
) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}
