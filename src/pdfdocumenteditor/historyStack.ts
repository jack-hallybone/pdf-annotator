// The history entry types are imported type-only, which the compiler erases,
// so there is no runtime import cycle with PdfDocumentEditor.
import { createWorkSignature } from "./annotationState";
import {
  UNCHANGED_PAGE_ORDER,
  composePageMappings,
  pageMappingFor,
  pageOrderChangeOfOperation,
  remapAnnotationsAcrossPageEdit,
  remapRemovedSourcesAcrossPageEdit,
} from "./pageIdentity";
import type { PdfAnnotationRenames, PdfPageMapping } from "./pageIdentity";
import {
  remapAnnotationSources,
  remapRemovedAnnotationSources,
} from "./pdfWriter";
import type { WrittenAnnotationSources } from "./pdfWriter";
import type { PdfAnnotation } from "./types";
import type {
  PdfDocumentEditorHistorySnapshot,
  PdfDocumentEditorHistoryEntry,
} from "./PdfDocumentEditor";

/* An undo stack is the one place data the reader deleted lives, so it is
 * bounded: past these, the oldest entry goes and what only it held goes too. */
export const MAX_HISTORY_ENTRIES = 20;
export const MAX_DOCUMENT_HISTORY_ENTRIES = 5;
const MAX_DOCUMENT_HISTORY_TOTAL_BYTES = 128 * 1024 * 1024;
/* The one bound that reads an annotation's payload: an image stamp carries its
 * PNG as base64, which a count of versions cannot see. */
export const MAX_IMAGE_HISTORY_TOTAL_BYTES = 64 * 1024 * 1024;

export function annotationHistorySignature(annotations: PdfAnnotation[]) {
  return createWorkSignature("", annotations);
}

export function annotationHistoryEntry(
  annotations: PdfAnnotation[],
): PdfDocumentEditorHistoryEntry {
  return {
    annotations,
    kind: "annotations",
  };
}

/*
 * A save that shifts positions leaves the stacks describing a file that no
 * longer exists, so the save's report is applied to them too.
 */
export function remapHistoryAnnotationSources(
  entries: PdfDocumentEditorHistoryEntry[],
  sources: WrittenAnnotationSources,
): PdfDocumentEditorHistoryEntry[] {
  let changed = false;
  let pageMapping = UNCHANGED_PAGE_ORDER;
  const next: PdfDocumentEditorHistoryEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "document") {
      pageMapping = composePageMappings(
        pageMapping,
        pageMappingFor(pageOrderChangeOfOperation(entry.snapshot.operation)),
      );
    }

    const remapped = remapHistoryEntry(entry, sources, pageMapping);
    if (remapped !== entry) {
      changed = true;
    }
    next.push(remapped);
  }

  next.reverse();
  return changed ? next : entries;
}

function remapHistoryEntry(
  entry: PdfDocumentEditorHistoryEntry,
  sources: WrittenAnnotationSources,
  pageMapping: PdfPageMapping,
): PdfDocumentEditorHistoryEntry {
  if (entry.kind === "annotations") {
    const annotations = remapAnnotationSources(
      entry.annotations,
      sources,
      pageMapping,
    );
    return annotations === entry.annotations
      ? entry
      : { ...entry, annotations };
  }

  const { snapshot } = entry;
  const annotations = remapAnnotationSources(
    snapshot.annotations,
    sources,
    pageMapping,
  );
  const cleanAnnotations = remapAnnotationSources(
    snapshot.cleanAnnotations,
    sources,
    pageMapping,
  );
  const removedAnnotationSourceIds = remapRemovedAnnotationSources(
    snapshot.removedAnnotationSourceIds,
    sources,
    pageMapping,
    // Which page this entry's document holds each removal on; the clean
    // baseline is where that is known.
    pageOfSourceKey(snapshot.cleanAnnotations),
  );
  if (
    annotations === snapshot.annotations &&
    cleanAnnotations === snapshot.cleanAnnotations &&
    removedAnnotationSourceIds.length ===
      snapshot.removedAnnotationSourceIds.length &&
    removedAnnotationSourceIds.every(
      (sourceId, index) =>
        sourceId === snapshot.removedAnnotationSourceIds[index],
    )
  ) {
    return entry;
  }

  return {
    ...entry,
    snapshot: {
      ...snapshot,
      annotations,
      cleanAnnotations,
      removedAnnotationSourceIds,
    },
  };
}

/*
 * The same stacks, against the object numbers a page operation produced: a copy
 * re-creates every annotation dictionary on the page, in every entry that names
 * one.
 */
export function renameHistoryAnnotationSources(
  entries: PdfDocumentEditorHistoryEntry[],
  renames: PdfAnnotationRenames,
): PdfDocumentEditorHistoryEntry[] {
  if (renames.size === 0) {
    return entries;
  }

  let changed = false;
  const next = entries.map((entry) => {
    const renamed = renameHistoryEntry(entry, renames);
    if (renamed !== entry) {
      changed = true;
    }
    return renamed;
  });
  return changed ? next : entries;
}

function renameHistoryEntry(
  entry: PdfDocumentEditorHistoryEntry,
  renames: PdfAnnotationRenames,
): PdfDocumentEditorHistoryEntry {
  if (entry.kind === "annotations") {
    const annotations = remapAnnotationsAcrossPageEdit(
      entry.annotations,
      UNCHANGED_PAGE_ORDER,
      renames,
    );
    return annotations === entry.annotations
      ? entry
      : { ...entry, annotations };
  }

  const { snapshot } = entry;
  const annotations = remapAnnotationsAcrossPageEdit(
    snapshot.annotations,
    UNCHANGED_PAGE_ORDER,
    renames,
  );
  const cleanAnnotations = remapAnnotationsAcrossPageEdit(
    snapshot.cleanAnnotations,
    UNCHANGED_PAGE_ORDER,
    renames,
  );
  const removedAnnotationSourceIds = remapRemovedSourcesAcrossPageEdit(
    snapshot.removedAnnotationSourceIds,
    UNCHANGED_PAGE_ORDER,
    () => null,
    renames,
  );
  if (
    annotations === snapshot.annotations &&
    cleanAnnotations === snapshot.cleanAnnotations &&
    removedAnnotationSourceIds.every(
      (sourceId, index) =>
        sourceId === snapshot.removedAnnotationSourceIds[index],
    )
  ) {
    return entry;
  }

  return {
    ...entry,
    snapshot: {
      ...snapshot,
      annotations,
      cleanAnnotations,
      removedAnnotationSourceIds,
    },
  };
}

/** Which page each annotation sits on, keyed as a pending removal names it. */
function pageOfSourceKey(annotations: PdfAnnotation[]) {
  const pages = new Map<string, number>();
  for (const annotation of annotations) {
    pages.set(annotation.sourceId ?? annotation.id, annotation.pageIndex);
  }
  return (sourceId: string) => pages.get(sourceId) ?? null;
}

export function trimHistoryStack(entries: PdfDocumentEditorHistoryEntry[]) {
  const trimmed =
    entries.length > MAX_HISTORY_ENTRIES
      ? entries.slice(entries.length - MAX_HISTORY_ENTRIES)
      : [...entries];
  let documentEntries = trimmed.filter(
    (entry) => entry.kind === "document",
  ).length;

  while (documentEntries > MAX_DOCUMENT_HISTORY_ENTRIES && trimmed.length > 0) {
    const [removed] = trimmed.splice(0, 1);
    if (removed?.kind === "document") {
      documentEntries -= 1;
    }
  }

  while (
    documentHistoryStackByteSize(trimmed) > MAX_DOCUMENT_HISTORY_TOTAL_BYTES &&
    trimmed.some((entry) => entry.kind === "document")
  ) {
    const removeIndex = trimmed.findIndex((entry) => entry.kind === "document");
    if (removeIndex < 0) {
      break;
    }
    trimmed.splice(removeIndex, 1);
  }

  /* Oldest first, any entry rather than only ones holding an image: dropping
   * from the middle would leave an undo that skips a step. */
  while (
    trimmed.length > 0 &&
    historyStackImageByteSize(trimmed) > MAX_IMAGE_HISTORY_TOTAL_BYTES
  ) {
    trimmed.shift();
  }

  return trimmed;
}

/**
 * The image bytes these entries hold, counted once per image: entries share one
 * array by reference, so counting occurrences would evict undo steps to free
 * nothing.
 */
export function historyStackImageByteSize(
  entries: PdfDocumentEditorHistoryEntry[],
) {
  const images = new Map<string, number>();
  for (const entry of entries) {
    const held =
      entry.kind === "annotations"
        ? [entry.annotations]
        : [entry.snapshot.annotations, entry.snapshot.cleanAnnotations];
    for (const annotation of held.flat()) {
      if (annotation.kind === "imageStamp") {
        const bytes = annotation.imageData.length;
        images.set(`${annotation.id}:${bytes}`, bytes);
      }
    }
  }

  let total = 0;
  for (const bytes of images.values()) {
    total += bytes;
  }
  return total;
}

function documentHistoryStackByteSize(
  entries: PdfDocumentEditorHistoryEntry[],
) {
  return entries.reduce(
    (total, entry) =>
      entry.kind === "document"
        ? total + documentHistorySnapshotByteSize(entry.snapshot)
        : total,
    0,
  );
}

export function documentHistorySnapshotByteSize(
  snapshot: PdfDocumentEditorHistorySnapshot,
) {
  const byteArrays = new Set<Uint8Array>();
  if (snapshot.operation.type === "insertPages") {
    byteArrays.add(snapshot.operation.pagesBytes);
  }
  if (snapshot.cleanPdfBytes) {
    byteArrays.add(snapshot.cleanPdfBytes);
  }
  return Array.from(byteArrays).reduce(
    (total, bytes) => total + bytes.byteLength,
    0,
  );
}
