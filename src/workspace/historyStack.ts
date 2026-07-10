// Pure undo/redo history-stack logic, extracted from PdfWorkspace so the
// stack's size/trim/normalize/signature rules live in one testable place
// instead of buried in the component. These functions never touch component
// state - they take history entries in and return new ones. The history
// entry/snapshot types stay declared in PdfWorkspace (they're part of the
// public API surface) and are imported type-only here, which the compiler
// erases, so there is no runtime import cycle.
import { createWorkSignature } from './annotationState';
import type { PdfAnnotation } from './types';
import type {
  PdfWorkspaceDocumentHistorySnapshot,
  PdfWorkspaceHistoryEntry
} from './PdfWorkspace';

const MAX_HISTORY_ENTRIES = 20;
const MAX_DOCUMENT_HISTORY_ENTRIES = 5;
const MAX_DOCUMENT_HISTORY_TOTAL_BYTES = 128 * 1024 * 1024;

export function annotationHistorySignature(annotations: PdfAnnotation[]) {
  return createWorkSignature('', annotations);
}

export function annotationHistoryEntry(
  annotations: PdfAnnotation[]
): PdfWorkspaceHistoryEntry {
  return {
    annotations,
    kind: 'annotations'
  };
}

export function normalizeHistoryStack(
  stack: unknown
): PdfWorkspaceHistoryEntry[] {
  if (!Array.isArray(stack)) {
    return [];
  }

  return stack.flatMap((entry): PdfWorkspaceHistoryEntry[] => {
    if (isHistoryEntry(entry)) {
      return [entry];
    }

    if (Array.isArray(entry)) {
      return [annotationHistoryEntry(entry as PdfAnnotation[])];
    }

    return [];
  });
}

function isHistoryEntry(entry: unknown): entry is PdfWorkspaceHistoryEntry {
  if (!entry || typeof entry !== 'object') {
    return false;
  }

  const kind = (entry as { kind?: unknown }).kind;
  return kind === 'annotations' || kind === 'document';
}

export function trimHistoryStack(entries: PdfWorkspaceHistoryEntry[]) {
  const trimmed =
    entries.length > MAX_HISTORY_ENTRIES
      ? entries.slice(entries.length - MAX_HISTORY_ENTRIES)
      : [...entries];
  let documentEntries = trimmed.filter(
    (entry) => entry.kind === 'document'
  ).length;

  while (
    documentEntries > MAX_DOCUMENT_HISTORY_ENTRIES &&
    trimmed.length > 0
  ) {
    const [removed] = trimmed.splice(0, 1);
    if (removed?.kind === 'document') {
      documentEntries -= 1;
    }
  }

  while (
    documentHistoryStackByteSize(trimmed) > MAX_DOCUMENT_HISTORY_TOTAL_BYTES &&
    trimmed.some((entry) => entry.kind === 'document')
  ) {
    const removeIndex = trimmed.findIndex((entry) => entry.kind === 'document');
    if (removeIndex < 0) {
      break;
    }
    trimmed.splice(removeIndex, 1);
  }

  return trimmed;
}

function documentHistoryStackByteSize(entries: PdfWorkspaceHistoryEntry[]) {
  return entries.reduce(
    (total, entry) =>
      entry.kind === 'document'
        ? total + documentHistorySnapshotByteSize(entry.snapshot)
        : total,
    0
  );
}

export function documentHistorySnapshotByteSize(
  snapshot: PdfWorkspaceDocumentHistorySnapshot
) {
  const byteArrays = new Set<Uint8Array>();
  if (snapshot.operation.type === 'insertPages') {
    byteArrays.add(snapshot.operation.pagesBytes);
  }
  if (snapshot.cleanPdfBytes) {
    byteArrays.add(snapshot.cleanPdfBytes);
  }
  return Array.from(byteArrays).reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  );
}
