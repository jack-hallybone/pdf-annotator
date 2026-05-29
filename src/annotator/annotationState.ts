import type { PdfAnnotation, PdfRect } from './types';
import { clamp } from './viewerConfig';

export function hasAnnotationContent(annotation: PdfAnnotation) {
  if (annotation.kind === 'freeText' || annotation.kind === 'stickyNote') {
    return annotation.text.trim().length > 0;
  }

  return true;
}

export function groupAnnotationsByPage(annotations: PdfAnnotation[]) {
  const byPage = new Map<number, PdfAnnotation[]>();
  for (const annotation of annotations) {
    const pageAnnotations = byPage.get(annotation.pageIndex);
    if (pageAnnotations) {
      pageAnnotations.push(annotation);
    } else {
      byPage.set(annotation.pageIndex, [annotation]);
    }
  }
  return byPage;
}

export function annotationReplacementPageIndexes(
  managedPageIndexes: Set<number>,
  annotations: PdfAnnotation[]
) {
  const pageIndexes = new Set(managedPageIndexes);
  for (const annotation of annotations) {
    pageIndexes.add(annotation.pageIndex);
  }
  return pageIndexes;
}

export function remapPageSetAfterDelete(
  pageIndexes: Set<number>,
  deletedPage: number
) {
  const next = new Set<number>();
  for (const pageIndex of pageIndexes) {
    if (pageIndex < deletedPage) {
      next.add(pageIndex);
    } else if (pageIndex > deletedPage) {
      next.add(pageIndex - 1);
    }
  }
  return next;
}

export function remapPageSetAfterInsert(
  pageIndexes: Set<number>,
  insertIndex: number
) {
  const next = new Set<number>();
  for (const pageIndex of pageIndexes) {
    next.add(pageIndex >= insertIndex ? pageIndex + 1 : pageIndex);
  }
  return next;
}

export function createWorkSignature(
  pdfFingerprint: string,
  annotations: PdfAnnotation[]
) {
  return JSON.stringify({
    annotations: annotations
      .map(annotationSignature)
      .sort((a, b) => a.id.localeCompare(b.id)),
    pdfFingerprint
  });
}

export function annotationFingerprint(annotation: PdfAnnotation) {
  return JSON.stringify(annotationSignature(annotation));
}

function annotationSignature(annotation: PdfAnnotation) {
  const base = {
    color: annotation.color.map(signatureNumber),
    id: annotation.id,
    kind: annotation.kind,
    pageIndex: annotation.pageIndex,
    sourceId: annotation.sourceId ?? ''
  };

  switch (annotation.kind) {
    case 'textHighlight':
      return {
        ...base,
        contents: annotation.contents,
        opacity: signatureNumber(annotation.opacity),
        quadPoints: annotation.quadPoints.map((quad) =>
          quad.map(signatureNumber)
        ),
        rects: annotation.rects.map(rectSignature)
      };
    case 'draw':
    case 'freehandHighlight':
      return {
        ...base,
        contents: annotation.contents,
        filled: annotation.filled ?? false,
        opacity: signatureNumber(annotation.opacity),
        paths: annotation.paths.map((path) =>
          path.map((point) => ({
            x: signatureNumber(point.x),
            y: signatureNumber(point.y)
          }))
        ),
        width: signatureNumber(annotation.width)
      };
    case 'freeText':
      return {
        ...base,
        fontSize: signatureNumber(annotation.fontSize),
        opacity: signatureNumber(annotation.opacity),
        rect: rectSignature(annotation.rect),
        text: annotation.text
      };
    case 'stickyNote':
      return {
        ...base,
        rect: rectSignature(annotation.rect),
        text: annotation.text
      };
  }
}

function rectSignature(rect: PdfRect) {
  return {
    x1: signatureNumber(rect.x1),
    x2: signatureNumber(rect.x2),
    y1: signatureNumber(rect.y1),
    y2: signatureNumber(rect.y2)
  };
}

function signatureNumber(value: number) {
  return Number(value.toFixed(4));
}

export function mergeImportedAnnotations(
  current: PdfAnnotation[],
  imported: PdfAnnotation[]
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
  annotation: PdfAnnotation
): PdfAnnotation {
  if (annotation.kind !== 'freeText') {
    return annotation;
  }

  return {
    ...annotation,
    opacity: annotation.opacity ?? 1,
    rect: resizeFreeTextRect(annotation.rect, annotation.text, annotation.fontSize)
  };
}

export function byteFingerprint(bytes: Uint8Array) {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(bytes.length / 65536));

  for (let index = 0; index < bytes.length; index += step) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }

  for (
    let index = Math.max(0, bytes.length - 1024);
    index < bytes.length;
    index += 1
  ) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }

  return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}

function resizeFreeTextRect(rect: PdfRect, text: string, fontSize: number) {
  const empty = text.trim().length === 0;
  const lines = empty ? ['Type...'] : text.split(/\r?\n/);
  const longestLineLength = Math.max(
    1,
    ...lines.map((line) => line.trimEnd().length)
  );
  const width = clamp(
    longestLineLength * fontSize * 0.54 + 10,
    empty ? 96 : 28,
    420
  );
  const height = Math.max(
    fontSize * 1.35 + 4,
    lines.length * fontSize * 1.35 + 4
  );
  const left = Math.min(rect.x1, rect.x2);
  const top = Math.max(rect.y1, rect.y2);

  return {
    x1: left,
    y1: top - height,
    x2: left + width,
    y2: top
  };
}
