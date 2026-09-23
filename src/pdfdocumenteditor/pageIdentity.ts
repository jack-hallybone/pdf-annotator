/*
 * A page edit moves both halves of an identity: the page half of a `direct:`
 * position, and the object numbers a copy re-creates.
 */
import {
  directSourceId,
  directSourcePosition,
  referenceSourceKey,
  unresolvedSourceId,
} from "./annotationSourceKey";
import type { PdfStructuralOperation } from "./pdfPageOperations";
import type { PdfAnnotation } from "./types";

/** `keep` is a real answer: rotating a page changes no page's index. */
export type PdfPageOrderChange =
  | { type: "keep" }
  | { type: "insert"; atIndex: number; count: number }
  | { type: "remove"; startIndex: number; count: number }
  | { type: "swap"; indexA: number; indexB: number };

/** Old reference to new; only an operation that copies pages renames. */
export type PdfAnnotationRenames = ReadonlyMap<string, string>;

export const NO_ANNOTATION_RENAMES: PdfAnnotationRenames = new Map();

export type PdfPageMapping = {
  /** Where a page of the document before the edit is, or null if removed. */
  forward: (pageIndex: number) => number | null;
  /** Which page became this one, or null if the edit brought it in. */
  backward: (pageIndex: number) => number | null;
};

export const UNCHANGED_PAGE_ORDER: PdfPageMapping = {
  backward: (pageIndex) => pageIndex,
  forward: (pageIndex) => pageIndex,
};

export function pageMappingFor(change: PdfPageOrderChange): PdfPageMapping {
  switch (change.type) {
    case "keep":
      return UNCHANGED_PAGE_ORDER;
    case "insert":
      return {
        backward: (pageIndex) => {
          if (pageIndex < change.atIndex) {
            return pageIndex;
          }
          return pageIndex >= change.atIndex + change.count
            ? pageIndex - change.count
            : null;
        },
        forward: (pageIndex) =>
          pageIndex >= change.atIndex ? pageIndex + change.count : pageIndex,
      };
    case "remove":
      return {
        backward: (pageIndex) =>
          pageIndex < change.startIndex ? pageIndex : pageIndex + change.count,
        forward: (pageIndex) => {
          if (pageIndex < change.startIndex) {
            return pageIndex;
          }
          return pageIndex >= change.startIndex + change.count
            ? pageIndex - change.count
            : null;
        },
      };
    case "swap": {
      const swap = (pageIndex: number) => {
        if (pageIndex === change.indexA) {
          return change.indexB;
        }
        return pageIndex === change.indexB ? change.indexA : pageIndex;
      };
      return { backward: swap, forward: swap };
    }
  }
}

export function pageOrderChangeOfOperation(
  operation: PdfStructuralOperation,
): PdfPageOrderChange {
  switch (operation.type) {
    case "rotatePage":
      return { type: "keep" };
    case "insertPages":
      return {
        atIndex: operation.atIndex,
        count: operation.pageCount,
        type: "insert",
      };
    case "removePages":
      return {
        count: operation.count,
        startIndex: operation.startIndex,
        type: "remove",
      };
    case "movePage":
      return {
        indexA: operation.pageIndex,
        indexB: operation.pageIndex + operation.direction,
        type: "swap",
      };
  }
}

/** `first`, and then `second`: the two edits as one map, in that order. */
export function composePageMappings(
  first: PdfPageMapping,
  second: PdfPageMapping,
): PdfPageMapping {
  return {
    backward: (pageIndex) => {
      const between = second.backward(pageIndex);
      return between === null ? null : first.backward(between);
    },
    forward: (pageIndex) => {
      const between = first.forward(pageIndex);
      return between === null ? null : second.forward(between);
    },
  };
}

/**
 * An identity whose page the edit removed must become `unresolved:`, which
 * stops the next save: a restated position would resolve to whichever
 * annotation now sits in that slot.
 */
export function restatedSourceIdAcrossPages(
  sourceId: string,
  mapping: PdfPageMapping,
  renames: PdfAnnotationRenames = NO_ANNOTATION_RENAMES,
) {
  const renamed = renamedSourceId(sourceId, renames);
  const position = directSourcePosition(renamed);
  if (!position) {
    return renamed;
  }

  const pageIndex = mapping.forward(position.pageIndex);
  return pageIndex === null
    ? unresolvedSourceId(
        "shifted",
        position.pageIndex,
        position.annotationIndex,
      )
    : directSourceId(pageIndex, position.annotationIndex);
}

/**
 * A composite (`5 0 R|geom:...`) is answered by its reference part, which is
 * the part the writer resolves it by.
 */
function renamedSourceId(sourceId: string, renames: PdfAnnotationRenames) {
  if (renames.size === 0) {
    return sourceId;
  }

  const key = referenceSourceKey(sourceId);
  return (key && renames.get(key)) || sourceId;
}

/**
 * Returns the array it was handed when nothing moved, so React's reference
 * survives.
 */
export function remapAnnotationsAcrossPageEdit<T extends PdfAnnotation>(
  annotations: T[],
  mapping: PdfPageMapping,
  renames: PdfAnnotationRenames = NO_ANNOTATION_RENAMES,
): T[] {
  let changed = false;
  const next: T[] = [];
  for (const annotation of annotations) {
    const pageIndex = mapping.forward(annotation.pageIndex);
    if (pageIndex === null) {
      changed = true;
      continue;
    }

    const sourceId = annotation.sourceId
      ? restatedSourceIdAcrossPages(annotation.sourceId, mapping, renames)
      : annotation.sourceId;
    if (
      pageIndex === annotation.pageIndex &&
      sourceId === annotation.sourceId
    ) {
      next.push(annotation);
      continue;
    }

    changed = true;
    next.push({ ...annotation, pageIndex, sourceId });
  }

  return changed ? next : annotations;
}

/**
 * A removal whose page the edit took out is dropped rather than restated:
 * carrying the position forward would delete whichever annotation moved into
 * that slot.
 */
export function remapRemovedSourcesAcrossPageEdit(
  removedSourceIds: Iterable<string>,
  mapping: PdfPageMapping,
  pageOfRemovedSource: (sourceId: string) => number | null = () => null,
  renames: PdfAnnotationRenames = NO_ANNOTATION_RENAMES,
) {
  const next: string[] = [];
  for (const sourceId of removedSourceIds) {
    const position = directSourcePosition(sourceId);
    if (position) {
      if (mapping.forward(position.pageIndex) === null) {
        continue;
      }
    } else {
      const pageIndex = pageOfRemovedSource(sourceId);
      if (pageIndex !== null && mapping.forward(pageIndex) === null) {
        continue;
      }
    }

    next.push(restatedSourceIdAcrossPages(sourceId, mapping, renames));
  }
  return next;
}

export function remapPageSetAcrossPageEdit(
  pageIndexes: Iterable<number>,
  mapping: PdfPageMapping,
) {
  const next = new Set<number>();
  for (const pageIndex of pageIndexes) {
    const mapped = mapping.forward(pageIndex);
    if (mapped !== null) {
      next.add(mapped);
    }
  }
  return next;
}
