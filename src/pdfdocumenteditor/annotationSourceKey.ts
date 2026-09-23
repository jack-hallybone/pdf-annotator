// Source keys match an existing PDF annotation, read from pdf-lib or pdf.js in
// slightly different raw shapes, to an in-memory PdfAnnotation.

export function normalizedRectValues(values: number[]) {
  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3]),
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
  fallback: number,
) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

/*
 * A direct dictionary has no name, so its position in /Annots is its identity,
 * and pdf.js's display array is neither the raw array nor a prefix of it.
 */
export const DIRECT_SOURCE_ID_PREFIX = "direct:";
export const UNRESOLVED_SOURCE_ID_PREFIX = "unresolved:";

type UnresolvedSourceReason = "ambiguous" | "shifted";

export function directSourceId(pageIndex: number, annotationIndex: number) {
  return `${DIRECT_SOURCE_ID_PREFIX}${pageIndex}:${annotationIndex}`;
}

export function unresolvedSourceId(
  reason: UnresolvedSourceReason,
  pageIndex: number,
  annotationIndex: number,
) {
  return `${UNRESOLVED_SOURCE_ID_PREFIX}${reason}:${pageIndex}:${annotationIndex}`;
}

export function unresolvedSourceReason(
  sourceId: string,
): UnresolvedSourceReason | null {
  const match = /^unresolved:(ambiguous|shifted):/i.exec(sourceId.trim());
  return match ? (match[1].toLowerCase() as UnresolvedSourceReason) : null;
}

/** The page and /Annots index a `direct:` identity names, else null. */
export function directSourcePosition(sourceId: string) {
  const match = /^direct:(\d+):(\d+)$/i.exec(sourceId.trim());
  return match
    ? { annotationIndex: Number(match[2]), pageIndex: Number(match[1]) }
    : null;
}

/*
 * `5 0 R` in the file, `5R` or `50R1` out of pdf.js: three spellings of one
 * indirect reference, canonicalised so the two libraries' answers compare.
 */
export function canonicalPdfReferenceKey(sourceId: string) {
  const compact = sourceId.trim();
  const spaced = /^(\d+)\s+(\d+)\s+r$/i.exec(compact);
  if (spaced) {
    return `ref:${Number(spaced[1])}:${Number(spaced[2])}`;
  }
  const pdfJs = /^(\d+)r(\d*)$/i.exec(compact);
  if (pdfJs) {
    return `ref:${Number(pdfJs[1])}:${pdfJs[2] ? Number(pdfJs[2]) : 0}`;
  }
  return null;
}

/**
 * The reference key of a whole identity, or null when it names a position.
 */
export function referenceSourceKey(sourceId: string) {
  for (const part of sourceId.split("|")) {
    const key = canonicalPdfReferenceKey(part.trim());
    if (key) {
      return key;
    }
  }
  return null;
}
