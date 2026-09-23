import type { PdfAnnotation, PdfRect } from "./types";
import { resizeFreeTextRect } from "./freeTextLayout";

export function hasAnnotationContent(annotation: PdfAnnotation) {
  if (annotation.kind === "freeText" || annotation.kind === "stickyNote") {
    return annotation.text.trim().length > 0;
  }

  return true;
}

// Reuses a page's previous bucket array by reference when nothing on that page
// changed, so unaffected pages do not re-render downstream.
export function groupAnnotationsByPageStable(
  annotations: PdfAnnotation[],
  previousByPage: Map<number, PdfAnnotation[]>,
) {
  const grouped = new Map<number, PdfAnnotation[]>();
  const matchesPrevious = new Map<number, boolean>();

  for (const annotation of annotations) {
    const pageIndex = annotation.pageIndex;
    let bucket = grouped.get(pageIndex);
    if (!bucket) {
      bucket = [];
      grouped.set(pageIndex, bucket);
      matchesPrevious.set(pageIndex, true);
    }

    if (matchesPrevious.get(pageIndex)) {
      const previousBucket = previousByPage.get(pageIndex);
      if (previousBucket?.[bucket.length] !== annotation) {
        matchesPrevious.set(pageIndex, false);
      }
    }

    bucket.push(annotation);
  }

  for (const [pageIndex, bucket] of grouped) {
    const previousBucket = previousByPage.get(pageIndex);
    if (
      matchesPrevious.get(pageIndex) &&
      previousBucket &&
      previousBucket.length === bucket.length
    ) {
      grouped.set(pageIndex, previousBucket);
    }
  }

  previousByPage.clear();
  for (const [pageIndex, bucket] of grouped) {
    previousByPage.set(pageIndex, bucket);
  }
  return grouped;
}

export function annotationReplacementPageIndexes(
  managedPageIndexes: Set<number>,
  annotations: PdfAnnotation[],
) {
  const pageIndexes = new Set(managedPageIndexes);
  for (const annotation of annotations) {
    pageIndexes.add(annotation.pageIndex);
  }
  return pageIndexes;
}

export function annotationSourceIdsForReplacement(
  annotations: PdfAnnotation[],
  removedSourceIds: Set<string>,
  currentAnnotations: PdfAnnotation[],
  allAnnotations: PdfAnnotation[] = currentAnnotations,
) {
  const currentReplacementKeys = new Set(
    currentAnnotations.flatMap(annotationPresenceKeys),
  );
  const sourceIds = new Set(
    Array.from(removedSourceIds).filter(
      (sourceId) => !currentReplacementKeys.has(sourceId),
    ),
  );

  for (const annotation of annotations) {
    for (const key of annotationReplacementKeys(annotation)) {
      sourceIds.add(key);
    }
  }

  for (const annotation of allAnnotations) {
    if (!hasAnnotationContent(annotation)) {
      for (const key of annotationReplacementKeys(annotation)) {
        sourceIds.add(key);
      }
    }
  }

  return sourceIds;
}

export function createWorkSignature(
  pdfFingerprint: string,
  annotations: PdfAnnotation[],
) {
  return JSON.stringify({
    annotations: annotations
      .map(annotationSignature)
      .sort((a, b) => a.id.localeCompare(b.id)),
    pdfFingerprint,
  });
}

export function annotationFingerprint(annotation: PdfAnnotation) {
  return JSON.stringify(annotationSignature(annotation));
}

function annotationSignature(annotation: PdfAnnotation) {
  const base = {
    // `coveredText` is left out because it is re-derived and never written, and
    // including it would make merely reopening a file look like an edit.
    bookmarked: annotation.bookmarked ?? false,
    id: annotation.id,
    kind: annotation.kind,
    pageIndex: annotation.pageIndex,
    sourceId: annotation.sourceId ?? "",
  };

  switch (annotation.kind) {
    case "textHighlight":
      return {
        ...base,
        color: annotation.color.map(signatureNumber),
        comment: annotation.comment,
        opacity: signatureNumber(annotation.opacity),
        quadPoints: annotation.quadPoints.map((quad) =>
          quad.map(signatureNumber),
        ),
        rects: annotation.rects.map(rectSignature),
      };
    case "draw":
    case "freehandHighlight":
      return {
        ...base,
        color: annotation.color.map(signatureNumber),
        comment: annotation.comment,
        filled: annotation.filled ?? false,
        opacity: signatureNumber(annotation.opacity),
        paths: annotation.paths.map((path) =>
          path.map((point) => ({
            x: signatureNumber(point.x),
            y: signatureNumber(point.y),
          })),
        ),
        width: signatureNumber(annotation.width),
      };
    case "freeText":
      return {
        ...base,
        color: annotation.color.map(signatureNumber),
        fontSize: signatureNumber(annotation.fontSize),
        layoutWidth:
          annotation.layoutWidth === undefined
            ? undefined
            : signatureNumber(annotation.layoutWidth),
        opacity: signatureNumber(annotation.opacity),
        rect: rectSignature(annotation.rect),
        rotation: annotation.rotation ?? 0,
        text: annotation.text,
      };
    case "stickyNote":
      return {
        ...base,
        color: annotation.color.map(signatureNumber),
        rect: rectSignature(annotation.rect),
        text: annotation.text,
      };
    case "imageStamp":
      return {
        ...base,
        comment: annotation.comment,
        dataHash: stringHash(annotation.imageData),
        heightPx: annotation.heightPx,
        mimeType: annotation.mimeType,
        rect: rectSignature(annotation.rect),
        rotation: annotation.rotation ?? 0,
        widthPx: annotation.widthPx,
      };
  }
}

function rectSignature(rect: PdfRect) {
  return {
    x1: signatureNumber(rect.x1),
    x2: signatureNumber(rect.x2),
    y1: signatureNumber(rect.y1),
    y2: signatureNumber(rect.y2),
  };
}

function signatureNumber(value: number) {
  return Number(value.toFixed(4));
}

export function mergeImportedAnnotations(
  current: PdfAnnotation[],
  imported: PdfAnnotation[],
) {
  if (imported.length === 0) {
    return current;
  }

  const existingIds = new Set(current.map((annotation) => annotation.id));
  const next = imported
    .map(normalizeAnnotationLayout)
    .filter((annotation) => !existingIds.has(annotation.id));

  return next.length > 0 ? [...current, ...next] : current;
}

export function normalizeAnnotationLayout(
  annotation: PdfAnnotation,
): PdfAnnotation {
  if (annotation.kind !== "freeText") {
    return annotation;
  }

  return {
    ...annotation,
    opacity: annotation.opacity ?? 1,
    rect: resizeFreeTextRect(
      annotation.rect,
      annotation.text,
      annotation.fontSize,
      {
        layoutWidth: annotation.layoutWidth,
      },
    ),
  };
}

function stringHash(value: string) {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(value.length / 65536));
  for (let index = 0; index < value.length; index += step) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

export function byteFingerprint(bytes: Uint8Array) {
  let primaryHash = 2166136261;
  let secondaryHash = 0x9e3779b9;

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    primaryHash ^= byte;
    primaryHash = Math.imul(primaryHash, 16777619);
    secondaryHash ^= byte + ((index & 0xff) << 8);
    secondaryHash = Math.imul(secondaryHash, 16777619);
  }

  return `${bytes.length}:${hashHex(primaryHash)}:${hashHex(secondaryHash)}`;
}

function annotationReplacementKeys(annotation: PdfAnnotation) {
  // The source identity is the authoritative key: adding the display id as an
  // equal alias would let one edit match two PDF objects.
  return [annotation.sourceId ?? annotation.id];
}

function annotationPresenceKeys(annotation: PdfAnnotation) {
  return [annotation.sourceId, annotation.id].filter((key): key is string =>
    Boolean(key),
  );
}

function hashHex(value: number) {
  return (value >>> 0).toString(16).padStart(8, "0");
}
