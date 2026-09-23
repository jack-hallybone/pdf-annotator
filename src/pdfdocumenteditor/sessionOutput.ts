/*
 * Serialising a document that is not mounted, in the same steps PdfDocumentEditor's
 * own save takes, or a tab saved parked differs from one saved while open.
 */
import {
  annotationReplacementPageIndexes,
  annotationSourceIdsForReplacement,
  byteFingerprint,
  createWorkSignature,
  hasAnnotationContent,
  normalizeAnnotationLayout,
} from "./annotationState";
import { writableAnnotations } from "./pdfDocumentEditorHelpers";
import type { SensitivePdfDocumentEditorSession } from "./PdfDocumentEditor";
import { markNonSerializable } from "./sensitiveSession";
import { remapHistoryAnnotationSources } from "./historyStack";
import { UNCHANGED_PAGE_ORDER } from "./pageIdentity";
import {
  assertAnnotationsTextIsSupported,
  remapAnnotationSources,
  remapRemovedAnnotationSources,
  writeAnnotatedPdf,
} from "./pdfWriter";
import type { WrittenAnnotationSources } from "./pdfWriter";

type DocumentEditorSessionOutput = {
  bytes: Uint8Array;
  sources: WrittenAnnotationSources | null;
};

/**
 * The bytes this session would write and what the writer did to the source
 * identities: a baseline describing the previous file lands the next save's
 * edit on whichever annotation moved into the slot.
 */
export async function documentEditorSessionOutput(
  session: SensitivePdfDocumentEditorSession,
): Promise<DocumentEditorSessionOutput> {
  const annotationsForOutput = session.annotations.filter(hasAnnotationContent);
  const annotationsToWrite = writableAnnotations(
    annotationsForOutput,
    session.cleanAnnotations,
  );
  assertAnnotationsTextIsSupported(annotationsToWrite);

  if (!session.hasUnsavedChanges) {
    return {
      bytes: session.cleanPdfBytes ?? session.pdfBytes,
      sources: null,
    };
  }

  const replaceAnnotationSourceIds = annotationSourceIdsForReplacement(
    annotationsToWrite,
    new Set(session.removedAnnotationSourceIds),
    annotationsForOutput,
    session.annotations,
  );

  if (
    annotationsToWrite.length === 0 &&
    replaceAnnotationSourceIds.size === 0
  ) {
    return { bytes: session.pdfBytes, sources: null };
  }

  return writeAnnotatedPdf(session.pdfBytes, annotationsToWrite, {
    replaceAnnotationSourceIds,
    replacePageIndexes: annotationReplacementPageIndexes(
      new Set(session.managedAnnotationPageIndexes),
      annotationsForOutput,
    ),
  });
}

/**
 * The undo history is restated as well as the baseline, so undoing past this
 * save does not bring the previous file's positions back.
 */
export function documentEditorSessionAfterSave(
  session: SensitivePdfDocumentEditorSession,
  output: DocumentEditorSessionOutput,
): SensitivePdfDocumentEditorSession {
  const { bytes: savedBytes, sources } = output;
  // The same set applyWrittenAnnotationSources restates on the mounted side.
  const restated = sources
    ? {
        annotations: remapAnnotationSources(
          session.annotations,
          sources,
          // These identities describe the file just written; only the history
          // stacks reach past it.
          UNCHANGED_PAGE_ORDER,
        ),
        redoStack: remapHistoryAnnotationSources(session.redoStack, sources),
        removedAnnotationSourceIds: remapRemovedAnnotationSources(
          session.removedAnnotationSourceIds,
          sources,
          UNCHANGED_PAGE_ORDER,
        ),
        undoStack: remapHistoryAnnotationSources(session.undoStack, sources),
      }
    : {
        annotations: session.annotations,
        redoStack: session.redoStack,
        removedAnnotationSourceIds: session.removedAnnotationSourceIds,
        undoStack: session.undoStack,
      };
  const cleanAnnotations = restated.annotations
    .filter(hasAnnotationContent)
    .map(normalizeAnnotationLayout);
  const pdfFingerprint = byteFingerprint(savedBytes);

  return markNonSerializable<SensitivePdfDocumentEditorSession>({
    ...session,
    ...restated,
    cleanAnnotations,
    cleanPdfBytes: savedBytes,
    cleanSignatureRefreshEnabled: true,
    cleanWorkSignature: createWorkSignature(pdfFingerprint, cleanAnnotations),
    hasUnsavedChanges: false,
    pdfBytes: savedBytes,
    pdfFingerprint,
  });
}
