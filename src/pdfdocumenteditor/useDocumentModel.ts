// The document owner: views attach through `PdfDocumentEditorViewBridge` refs and
// there may be more than one.
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useEventCallback } from "../useEventCallback";
import {
  getDocument,
  PasswordResponses,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  annotationTextCharacters,
  importExistingAnnotationsForPage,
  MAX_DOCUMENT_ANNOTATION_TEXT_CHARACTERS,
} from "./annotationImport";
import { loadPdfOutline } from "./pdfOutline";
import type { PdfOutlineEntry } from "./pdfOutline";
import {
  annotationReplacementPageIndexes,
  annotationSourceIdsForReplacement,
  byteFingerprint,
  createWorkSignature,
  groupAnnotationsByPageStable,
  hasAnnotationContent,
  mergeImportedAnnotations,
  normalizeAnnotationLayout,
} from "./annotationState";
import {
  NO_ANNOTATION_RENAMES,
  UNCHANGED_PAGE_ORDER,
  pageMappingFor,
  pageOrderChangeOfOperation,
  remapAnnotationsAcrossPageEdit,
  remapPageSetAcrossPageEdit,
  remapRemovedSourcesAcrossPageEdit,
} from "./pageIdentity";
import type { PdfAnnotationRenames, PdfPageOrderChange } from "./pageIdentity";
import {
  PdfAnnotationIntegrityError,
  assertAnnotationsTextIsSupported,
  remapAnnotationSources,
  remapRemovedAnnotationSources,
  unwritableAnnotations,
  writeAnnotatedPdf,
  writePdfAnnotations,
} from "./pdfWriter";
import type { WrittenAnnotationSources } from "./pdfWriter";
import {
  addBlankPageAt,
  addLinedPageAt,
  applyStructuralOperation,
  extractPagesBytes,
  invertStructuralOperation,
  mergePdfAfterPage,
  movePageBy,
  removePage,
  rotatePageClockwise,
  type PdfStructuralOperation,
} from "./pdfPageOperations";
import {
  annotationHistoryEntry,
  annotationHistorySignature,
  renameHistoryAnnotationSources,
  documentHistorySnapshotByteSize,
  remapHistoryAnnotationSources,
  trimHistoryStack,
} from "./historyStack";
import { markNonSerializable } from "./sensitiveSession";
import { PDFJS_DOCUMENT_OPTIONS } from "./pdfRender";
import {
  detectReadOnlyReason,
  type PdfDocumentEditorReadOnlyReason,
} from "./pdfProtection";
import { canCreateOutputCopy, canEditReadOnlyCopy } from "./readOnlyPolicy";
import type {
  PdfDocumentEditorCapabilities,
  PdfDownloadTarget,
  PdfSaveAsTarget,
  PdfSaveTarget,
  PdfSaveWithResult,
  PdfDocumentEditorSource,
} from "./host";
import type {
  PdfDocumentEditorNoticeOptions,
  PdfDocumentEditorNoticeReporter,
} from "./notices";
import type {
  LoadedPage,
  PageViewport,
  PageSize,
  PdfAnnotation,
  Tool,
  VisiblePageRange,
} from "./types";
import { ACTUAL_SIZE_ZOOM, clamp, EAGER_PAGE_LIMIT } from "./viewerConfig";
import { usePageCache } from "./usePageCache";
import {
  annotatedName,
  copyName,
  downloadPdf,
  inPlaceSaveFailureNotice,
  initialReloadPageIndexes,
  originalFileStateAfterSaveFailure,
  preparationErrorNotice,
  UNPROVEN_PAGE_DELETE_NOTICE,
  printableName,
  scheduleAfterVisiblePaint,
  writableAnnotations,
} from "./pdfDocumentEditorHelpers";
import { displayableFileName, safePdfFileName } from "../fileNames";
import type {
  PdfDocumentEditorViewPosition,
  PdfDocumentEditorViewSnapshot,
} from "./viewSnapshot";

const EMPTY_OUTLINE: PdfOutlineEntry[] = [];
const UNNAMED_DOCUMENT = "document.pdf";
const RENDER_RESOURCE_RELEASE_DELAY_MS = 500;
const MAX_DOCUMENT_HISTORY_ENTRY_BYTES = 96 * 1024 * 1024;

// `sources` is null when nothing was written.
type PdfOutput = {
  bytes: Uint8Array;
  sources: WrittenAnnotationSources | null;
};

// What a structural page edit rewrites beside the bytes, all of which a failed
// reload has to put back.
type DocumentEditorAncillaryState = {
  annotations: PdfAnnotation[];
  cleanAnnotations: PdfAnnotation[];
  cleanPdfBytes?: Uint8Array | null;
  cleanSignatureRefreshEnabled: boolean;
  cleanWorkSignature: string;
  importedAnnotationPageIndexes: number[];
  managedAnnotationPageIndexes: number[];
  removedAnnotationSourceIds: string[];
  shouldImportAnnotations: boolean;
};

// `operation` is applied to the current bytes to reach this entry's state.
export type PdfDocumentEditorHistorySnapshot = {
  annotations: PdfAnnotation[];
  cleanAnnotations: PdfAnnotation[];
  cleanPdfBytes?: Uint8Array | null;
  cleanSignatureRefreshEnabled: boolean;
  cleanWorkSignature: string;
  importedAnnotationPageIndexes: number[];
  managedAnnotationPageIndexes: number[];
  operation: PdfStructuralOperation;
  pdfFingerprint: string;
  removedAnnotationSourceIds: string[];
  shouldImportAnnotations: boolean;
};

export type PdfDocumentEditorCloseRequest = {
  fileName: string;
  hasUnsavedChanges: boolean;
};

export type PdfDocumentEditorHistoryEntry =
  | {
      annotations: PdfAnnotation[];
      kind: "annotations";
    }
  | {
      kind: "document";
      snapshot: PdfDocumentEditorHistorySnapshot;
      /** Where the view that made this edit was looking. */
      view: PdfDocumentEditorViewSnapshot;
    };

// Full PDF bytes, annotation state, history and save targets: never logged,
// sent over a network, stored in browser storage or persisted to disk.
export type SensitivePdfDocumentEditorSession = {
  annotations: PdfAnnotation[];
  cleanAnnotations: PdfAnnotation[];
  cleanPdfBytes?: Uint8Array | null;
  cleanSignatureRefreshEnabled?: boolean;
  cleanWorkSignature: string;
  editingEnabled?: boolean;
  fileName: string;
  fileKey?: string;
  hasUnsavedChanges: boolean;
  importedAnnotationPageIndexes: number[];
  managedAnnotationPageIndexes: number[];
  pdfBytes: Uint8Array;
  pdfFingerprint: string;
  redoStack: PdfDocumentEditorHistoryEntry[];
  removedAnnotationSourceIds: string[];
  readOnlyReason?: PdfDocumentEditorReadOnlyReason | null;
  downloadTarget?: PdfDownloadTarget | null;
  saveAsTarget?: PdfSaveAsTarget | null;
  saveTarget?: PdfSaveTarget | null;
  shouldImportAnnotations: boolean;
  sourceId: string;
  undoStack: PdfDocumentEditorHistoryEntry[];
  view: PdfDocumentEditorViewSnapshot;
  version: 1;
};

type PasswordRequest = {
  failed: boolean;
  generation: number;
  updatePassword: (password: string) => void;
};

// The only way this hook reaches a view.
export type PdfDocumentEditorViewBridge = {
  activePageIndex: number;
  /** The same page, one render ahead of state while scrolling. */
  activePageIndexRef: RefObject<number>;
  captureViewSnapshot: () => PdfDocumentEditorViewSnapshot;
  /** Drops the first-paint gate; `commitState` is false during teardown. */
  clearInitialVisualReadiness: (commitState: boolean) => void;
  markInitialAnnotationsReady: (pageIndex: number, generation: number) => void;
  resetInitialVisualReadiness: (pageIndex?: number) => void;
  restoreViewPosition: (viewPosition: PdfDocumentEditorViewPosition) => void;
  revealPreparationError: (error: unknown) => void;
  runAfterInitialVisualReady: (callback: () => void) => void;
  setActivePageIndex: Dispatch<SetStateAction<number>>;
  setFocusedAnnotationId: Dispatch<SetStateAction<string | null>>;
  setScale: (scale: number) => void;
  setSelectedAnnotationIds: Dispatch<SetStateAction<string[]>>;
  // Page residency reads this, never a band around `activePageIndexRef`.
  visiblePageRangeRef: RefObject<VisiblePageRange>;
};

// Only `source`, `onNotice` and `onClose` are required.
type DocumentModelOptions = PdfDocumentEditorCapabilities & {
  allowEditing?: boolean;
  allowImageAnnotations?: boolean;
  confirmDiscardChanges?: (
    request: PdfDocumentEditorCloseRequest,
  ) => boolean | Promise<boolean>;
  emptyTitle?: string;
  initialSession?: SensitivePdfDocumentEditorSession | null;
  manageDocumentTitle?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
  onDirtyChange?: (hasUnsavedChanges: boolean) => void;
  onDocumentReplaced?: () => void;
  onDocumentReset?: () => void;
  onMalformedAnnotations?: (count: number) => void;
  onNotice: PdfDocumentEditorNoticeReporter;
  onSessionRestore?: () => void;
  onShowAnnotationsChange?: (showAnnotations: boolean) => void;
  onToolChange?: (tool: Tool) => void;
  showAnnotations?: boolean;
  source: PdfDocumentEditorSource;
};

export type PdfDocumentEditorModel = ReturnType<typeof useDocumentModel>;

export function useDocumentModel({
  allowEditing = true,
  allowImageAnnotations = true,
  confirmDiscardChanges,
  emptyTitle,
  initialSession = null,
  manageDocumentTitle = true,
  onBusyChange,
  onClose,
  onDirtyChange,
  onDocumentReplaced,
  onDocumentReset,
  onMalformedAnnotations,
  onNotice,
  onSessionRestore,
  onShowAnnotationsChange,
  onToolChange,
  pickImageFile,
  pickMergePdfFile,
  printTarget = null,
  showAnnotations = true,
  source,
}: DocumentModelOptions) {
  // Coalescing window that merges rapid discrete commits into one undo entry.
  const lastUndoCommitTimeRef = useRef(0);
  // An in-progress annotation edit, held so it commits as a single undo entry.
  const liveAnnotationEditRef = useRef<
    | { kind: "idle" }
    | {
        kind: "pending";
        snapshot: { annotations: PdfAnnotation[]; signature: string };
      }
    | {
        kind: "liveEdit";
        snapshot: { annotations: PdfAnnotation[]; signature: string };
        finishOnPointerUp: boolean;
      }
  >({ kind: "idle" });
  const annotationsByPageCacheRef = useRef<Map<number, PdfAnnotation[]>>(
    new Map(),
  );
  const annotationsRef = useRef<PdfAnnotation[]>([]);
  const undoStackRef = useRef<PdfDocumentEditorHistoryEntry[]>([]);
  const redoStackRef = useRef<PdfDocumentEditorHistoryEntry[]>([]);
  const pagesRef = useRef<LoadedPage[]>([]);
  const loadingPagesRef = useRef<Set<number>>(new Set());
  const importedAnnotationPagesRef = useRef<Set<number>>(new Set());
  const managedAnnotationPagesRef = useRef<Set<number>>(new Set());
  const removedAnnotationSourceIdsRef = useRef<Set<string>>(new Set());
  const largeDocumentHistoryNoticeShownRef = useRef(false);
  const shouldImportAnnotationsRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const loadingTaskRef = useRef<ReturnType<typeof getDocument> | null>(null);
  const structureReloadInProgressRef = useRef(false);
  const pdfFingerprintRef = useRef("");
  const cleanWorkSignatureRef = useRef("");
  const cleanPdfBytesRef = useRef<Uint8Array | null>(null);
  const cleanAnnotationsRef = useRef<PdfAnnotation[]>([]);
  const cleanSignatureRefreshEnabledRef = useRef(true);
  const passwordProtectedLoadRef = useRef(false);
  // A Set of bridge refs, not of bridges: a view rewrites its bridge object on
  // every render.
  const viewsRef = useRef<Set<RefObject<PdfDocumentEditorViewBridge>>>(
    new Set(),
  );
  const {
    claimPageResidency,
    markPageAccess,
    evictOldLoadedPages,
    scheduleLoadedPagesCleanup,
    resetPageCache,
  } = usePageCache();
  const downloadTargetRef = useRef<PdfDownloadTarget | null>(null);
  const saveAsTargetRef = useRef<PdfSaveAsTarget | null>(null);
  const saveTargetRef = useRef<PdfSaveTarget | null>(null);
  const fileKeyRef = useRef<string | null>(source.fileKey ?? null);
  const sourceLoadRef = useRef<string | null>(null);
  const sourceIdRef = useRef(source.sourceId);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfBytesRef = useRef<Uint8Array | null>(null);
  const mountedRef = useRef(false);
  const unmountCleanupTimerRef = useRef<number | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFingerprint, setPdfFingerprint] = useState("");
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  // Bumped on every commit of a different proxy, so a view keyed on it re-runs.
  const [documentVersion, setDocumentVersion] = useState(0);
  const [outline, setOutline] = useState<PdfOutlineEntry[]>(EMPTY_OUTLINE);
  const [pages, setPages] = useState<LoadedPage[]>([]);
  // True only once a pass has actually visited every page.
  const [annotationsComplete, setAnnotationsComplete] = useState(true);
  const annotationScanRef = useRef<{
    generation: number;
    promise: Promise<void>;
  } | null>(null);
  const [pageSize, setPageSize] = useState<PageSize | null>(null);
  const [fileName, setRawFileName] = useState(UNNAMED_DOCUMENT);
  // The one place the untrusted name enters; every surface downstream reads it
  // from this state.
  const setFileName = (next: string | ((current: string) => string)) => {
    setRawFileName(
      (current) =>
        displayableFileName(
          typeof next === "function" ? next(current) : next,
        ) || UNNAMED_DOCUMENT,
    );
  };
  // Includes empty or in-progress annotations that are not yet content.
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [undoStack, setUndoStack] = useState<PdfDocumentEditorHistoryEntry[]>(
    [],
  );
  const [redoStack, setRedoStack] = useState<PdfDocumentEditorHistoryEntry[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [passwordRequest, setPasswordRequest] =
    useState<PasswordRequest | null>(null);
  const [readOnlyReason, setReadOnlyReason] =
    useState<PdfDocumentEditorReadOnlyReason | null>(null);
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [sourceRetryKey, setSourceRetryKey] = useState(0);
  const showNotice = useCallback(
    (message: string, options?: PdfDocumentEditorNoticeOptions) => {
      onNotice(message, options);
    },
    [onNotice],
  );
  const reportMalformedAnnotations = useCallback(
    (count: number) => {
      if (count > 0) {
        onMalformedAnnotations?.(count);
      }
    },
    [onMalformedAnnotations],
  );
  // `annotations` filtered to those with content: what a save would write.
  const persistedAnnotations = useMemo(
    () => annotations.filter(hasAnnotationContent),
    [annotations],
  );
  const annotationsByPage = useMemo(
    () =>
      groupAnnotationsByPageStable(
        annotations,
        annotationsByPageCacheRef.current,
      ),
    [annotations],
  );
  // Deferred so React coalesces rapid drag frames into one recomputation.
  const deferredPersistedAnnotations = useDeferredValue(persistedAnnotations);
  const currentWorkSignature = useMemo(
    () => createWorkSignature(pdfFingerprint, deferredPersistedAnnotations),
    [deferredPersistedAnnotations, pdfFingerprint],
  );
  const [cleanWorkSignature, setCleanWorkSignature] = useState("");
  const hasUnsavedChanges =
    Boolean(pdfBytes) &&
    cleanWorkSignature.length > 0 &&
    currentWorkSignature !== cleanWorkSignature;
  const hostReadOnly = !allowEditing;
  const fileReadOnly = readOnlyReason !== null && !editingEnabled;
  const readOnly = fileReadOnly || hostReadOnly;
  const outputCopyAvailable = canCreateOutputCopy(readOnlyReason);
  const saveAvailable =
    !hostReadOnly &&
    outputCopyAvailable &&
    Boolean(saveTargetRef.current || saveAsTargetRef.current);
  const saveAsAvailable =
    !hostReadOnly && outputCopyAvailable && Boolean(saveAsTargetRef.current);
  const downloadAvailable =
    !hostReadOnly && outputCopyAvailable && Boolean(downloadTargetRef.current);
  const printAvailable =
    !hostReadOnly && outputCopyAvailable && Boolean(printTarget);
  const mergePdfVisible = !hostReadOnly && Boolean(pickMergePdfFile);
  const imageAnnotationsVisible =
    !hostReadOnly && allowImageAnnotations && Boolean(pickImageFile);
  annotationsRef.current = annotations;
  pdfBytesRef.current = pdfBytes;
  pdfDocRef.current = pdfDoc;
  cleanWorkSignatureRef.current = cleanWorkSignature;
  undoStackRef.current = undoStack;
  redoStackRef.current = redoStack;
  const clearRenderCacheEvent = useEventCallback(clearRenderCache);
  const restoreSessionEvent = useEventCallback(restoreSession);
  const loadSourceEvent = useEventCallback(loadSource);
  const finishAnnotationEditEvent = useEventCallback(finishAnnotationEdit);
  const importAnnotationsForLoadedPageRef = useRef(
    importAnnotationsForLoadedPage,
  );
  importAnnotationsForLoadedPageRef.current = importAnnotationsForLoadedPage;
  const handleThumbnailPageLoad = useCallback(
    (page: PDFPageProxy, pageIndex: number) => {
      void importAnnotationsForLoadedPageRef.current(
        page,
        pageIndex,
        loadGenerationRef.current,
        pdfBytesRef.current,
      );
    },
    [],
  );

  // Keyed on the document object: page surgery replaces the whole proxy, and an
  // outline read before the rewrite points at pages that have since moved.
  useEffect(() => {
    if (!pdfDoc) {
      setOutline(EMPTY_OUTLINE);
      return;
    }

    let cancelled = false;
    void loadPdfOutline(pdfDoc).then((entries) => {
      if (!cancelled) {
        setOutline(entries.length > 0 ? entries : EMPTY_OUTLINE);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pdfDoc]);

  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );

  useLayoutEffect(() => {
    mountedRef.current = true;

    if (unmountCleanupTimerRef.current !== null) {
      window.clearTimeout(unmountCleanupTimerRef.current);
      unmountCleanupTimerRef.current = null;
    }

    return () => {
      mountedRef.current = false;
      unmountCleanupTimerRef.current = window.setTimeout(() => {
        const currentPdfDoc = pdfDocRef.current;
        pdfDocRef.current = null;
        sourceLoadRef.current = null;
        loadGenerationRef.current += 1;
        clearRenderCacheEvent({ clearState: false });
        void cancelLoadingTask();
        void destroyPdfDocument(currentPdfDoc);
      }, RENDER_RESOURCE_RELEASE_DELAY_MS);
    };
  }, [clearRenderCacheEvent]);

  useEffect(() => {
    if (!pdfBytes) {
      return;
    }

    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange, pdfBytes]);

  useLayoutEffect(() => {
    const nextSourceId = initialSession?.sourceId ?? source.sourceId;
    const nextLoadKey = `${nextSourceId}:${sourceRetryKey}`;
    if (sourceLoadRef.current === nextLoadKey) {
      return;
    }

    sourceLoadRef.current = nextLoadKey;
    if (initialSession) {
      void restoreSessionEvent(initialSession);
      return;
    }

    sourceIdRef.current = source.sourceId;
    void loadSourceEvent(source, nextLoadKey);
  }, [
    initialSession,
    loadSourceEvent,
    restoreSessionEvent,
    source,
    sourceRetryKey,
  ]);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    function endPointerLiveEdit() {
      const state = liveAnnotationEditRef.current;
      if (state.kind !== "liveEdit") {
        return;
      }

      if (!state.finishOnPointerUp) {
        liveAnnotationEditRef.current = {
          kind: "pending",
          snapshot: state.snapshot,
        };
        return;
      }

      window.setTimeout(() => {
        finishAnnotationEditEvent();
      }, 0);
    }

    window.addEventListener("pointerup", endPointerLiveEdit, true);
    window.addEventListener("blur", finishAnnotationEditEvent);
    return () => {
      window.removeEventListener("pointerup", endPointerLiveEdit, true);
      window.removeEventListener("blur", finishAnnotationEditEvent);
    };
  }, [finishAnnotationEditEvent]);

  // The page-residency claim is released here, so an unmounting viewport
  // cannot forget to give back its hold.
  const attachView = useCallback(
    (bridge: RefObject<PdfDocumentEditorViewBridge>) => {
      viewsRef.current.add(bridge);
      // A view may attach to a document that is already open, and has then
      // missed the once-only announcement that a page's annotations are in.
      for (const pageIndex of importedAnnotationPagesRef.current) {
        bridge.current.markInitialAnnotationsReady(
          pageIndex,
          loadGenerationRef.current,
        );
      }

      const claim = claimPageResidency(
        () => bridge.current.visiblePageRangeRef.current,
      );
      return () => {
        viewsRef.current.delete(bridge);
        claim.release();
      };
    },
    [claimPageResidency],
  );

  function primaryView(): PdfDocumentEditorViewBridge | null {
    for (const bridge of viewsRef.current) {
      return bridge.current;
    }

    return null;
  }

  function eachView(run: (attached: PdfDocumentEditorViewBridge) => void) {
    for (const bridge of [...viewsRef.current]) {
      run(bridge.current);
    }
  }

  /** What a page-surgery command means by "this page" when nobody said. */
  function primaryActivePageIndex() {
    return primaryView()?.activePageIndex ?? 0;
  }

  function capturePrimaryViewSnapshot(): PdfDocumentEditorViewSnapshot {
    return (
      primaryView()?.captureViewSnapshot() ?? {
        activePageIndex: 0,
        scale: ACTUAL_SIZE_ZOOM,
      }
    );
  }

  // Document work that waits for a viewport's first paint runs once however
  // many views are attached, so it follows the primary one.
  function afterPrimaryViewReady(callback: () => void) {
    const attached = primaryView();
    if (!attached) {
      callback();
      return;
    }

    attached.runAfterInitialVisualReady(callback);
  }

  function moveViewsToPage(pageIndex: number) {
    eachView((attached) => {
      attached.activePageIndexRef.current = pageIndex;
      attached.setActivePageIndex(pageIndex);
    });
  }

  function resetViewsToPage(pageIndex: number) {
    moveViewsToPage(pageIndex);
    clearViewSelections();
  }

  function clearViewSelections() {
    eachView((attached) => {
      attached.setSelectedAnnotationIds([]);
      attached.setFocusedAnnotationId(null);
    });
  }

  function commitPdfDocument(nextPdfDoc: PDFDocumentProxy | null) {
    setPdfDoc(nextPdfDoc);
    setDocumentVersion((version) => version + 1);
  }

  function createDocumentEditorSession(): SensitivePdfDocumentEditorSession | null {
    if (!pdfBytes) {
      return null;
    }

    return markNonSerializable<SensitivePdfDocumentEditorSession>({
      annotations,
      cleanAnnotations: cleanAnnotationsRef.current,
      cleanPdfBytes: cleanPdfBytesRef.current,
      cleanSignatureRefreshEnabled: cleanSignatureRefreshEnabledRef.current,
      cleanWorkSignature,
      editingEnabled,
      fileName,
      fileKey: fileKeyRef.current ?? undefined,
      hasUnsavedChanges,
      importedAnnotationPageIndexes: Array.from(
        importedAnnotationPagesRef.current,
      ),
      managedAnnotationPageIndexes: Array.from(
        managedAnnotationPagesRef.current,
      ),
      pdfBytes,
      pdfFingerprint,
      redoStack: redoStackRef.current,
      removedAnnotationSourceIds: Array.from(
        removedAnnotationSourceIdsRef.current,
      ),
      readOnlyReason,
      downloadTarget: downloadTargetRef.current,
      saveAsTarget: saveAsTargetRef.current,
      saveTarget: saveTargetRef.current,
      shouldImportAnnotations: shouldImportAnnotationsRef.current,
      sourceId: sourceIdRef.current,
      undoStack: undoStackRef.current,
      view: capturePrimaryViewSnapshot(),
      version: 1,
    });
  }

  async function releaseRenderResources() {
    const currentPdfDoc = pdfDocRef.current;
    pdfDocRef.current = null;
    loadGenerationRef.current += 1;
    clearRenderCache({ clearState: true });
    await cancelLoadingTask();
    await destroyPdfDocument(currentPdfDoc);
  }

  function commitAnnotations(
    updater: (current: PdfAnnotation[]) => PdfAnnotation[],
    options: {
      assumeChanged?: boolean;
      coalesce?: boolean;
      recordUndo?: boolean;
    } = {},
  ) {
    const current = annotationsRef.current;
    const next = updater(current);
    let currentSignature: string | null = null;
    if (!options.assumeChanged) {
      currentSignature = annotationHistorySignature(current);
      const nextSignature = annotationHistorySignature(next);
      if (currentSignature === nextSignature) {
        return;
      }
    }

    if (
      options.recordUndo === false &&
      liveAnnotationEditRef.current.kind === "idle"
    ) {
      currentSignature ??= annotationHistorySignature(current);
      liveAnnotationEditRef.current = {
        kind: "pending",
        snapshot: { annotations: current, signature: currentSignature },
      };
    }

    setAnnotationsState(next);
    if (
      options.recordUndo === false ||
      liveAnnotationEditRef.current.kind !== "idle"
    ) {
      return;
    }

    const now = Date.now();
    const shouldCoalesce =
      options.coalesce &&
      now - lastUndoCommitTimeRef.current < 600 &&
      undoStackRef.current.at(-1)?.kind === "annotations";

    updateUndoStack((stack) =>
      shouldCoalesce && stack.length > 0
        ? stack
        : [...stack, annotationHistoryEntry(current)],
    );
    lastUndoCommitTimeRef.current = now;
    updateRedoStack([]);
  }

  function beginAnnotationEdit({
    finishOnPointerUp = false,
  }: { finishOnPointerUp?: boolean } = {}) {
    const state = liveAnnotationEditRef.current;
    if (state.kind === "liveEdit") {
      liveAnnotationEditRef.current = {
        ...state,
        finishOnPointerUp: state.finishOnPointerUp || finishOnPointerUp,
      };
      return;
    }

    const snapshot =
      state.kind === "pending"
        ? state.snapshot
        : {
            annotations: annotationsRef.current,
            signature: annotationHistorySignature(annotationsRef.current),
          };

    liveAnnotationEditRef.current = {
      kind: "liveEdit",
      snapshot,
      finishOnPointerUp,
    };
    lastUndoCommitTimeRef.current = Date.now();
  }

  function finishAnnotationEdit() {
    const state = liveAnnotationEditRef.current;
    liveAnnotationEditRef.current = { kind: "idle" };
    if (state.kind === "idle") {
      return;
    }

    const pendingSnapshot = state.snapshot;

    const currentSignature = annotationHistorySignature(annotationsRef.current);
    if (currentSignature === pendingSnapshot.signature) {
      return;
    }

    updateUndoStack((stack) => {
      const previous = stack.at(-1);
      if (
        previous?.kind === "annotations" &&
        annotationHistorySignature(previous.annotations) ===
          pendingSnapshot.signature
      ) {
        return stack;
      }

      return [...stack, annotationHistoryEntry(pendingSnapshot.annotations)];
    });
    updateRedoStack([]);
    lastUndoCommitTimeRef.current = Date.now();
  }

  async function undoHistory() {
    // Must lock from this synchronous entry point: a save started between this
    // check and the first await could write pre-undo bytes to disk.
    if (!beginBusyOperation()) {
      return;
    }

    // Set once restoreDocumentHistory is invoked: from there on it owns the
    // busy flag's lifecycle, so this function must not also clear it.
    let handedOffBusyState = false;
    try {
      finishAnnotationEdit();
      const entry = undoStackRef.current.at(-1);
      if (!entry) {
        return;
      }

      if (entry.kind === "document") {
        if (!pdfBytes) {
          return;
        }

        const redoOperation = await invertStructuralOperation(
          entry.snapshot.operation,
          pdfBytes,
        );
        const redoEntry = documentHistoryEntry(redoOperation);
        handedOffBusyState = true;
        const renames = redoEntry
          ? await restoreDocumentHistory(entry.snapshot, entry.view)
          : null;
        if (!redoEntry || !renames) {
          showNotice("Could not undo this change.", {
            tone: "danger",
          });
          return;
        }

        popUndoEntry(entry);
        // Restated here, not inside the restore: renaming an entry replaces it,
        // and popUndoEntry finds its entry by identity.
        renameStacksAcrossRestore(renames);
        updateRedoStack((stack) => [...stack, redoEntry]);
        lastUndoCommitTimeRef.current = 0;
        return;
      }

      popUndoEntry(entry);
      updateRedoStack((stack) => [
        ...stack,
        annotationHistoryEntry(annotationsRef.current),
      ]);
      applyAnnotationHistory(entry.annotations);
      lastUndoCommitTimeRef.current = 0;
    } finally {
      if (!handedOffBusyState) {
        finishBusyOperation();
      }
    }
  }

  async function redoHistory() {
    // See undoHistory's identical guard for why this must lock synchronously.
    if (!beginBusyOperation()) {
      return;
    }

    let handedOffBusyState = false;
    try {
      finishAnnotationEdit();
      const entry = redoStackRef.current.at(-1);
      if (!entry) {
        return;
      }

      if (entry.kind === "document") {
        if (!pdfBytes) {
          return;
        }

        const undoOperation = await invertStructuralOperation(
          entry.snapshot.operation,
          pdfBytes,
        );
        const undoEntry = documentHistoryEntry(undoOperation);
        handedOffBusyState = true;
        const renames = undoEntry
          ? await restoreDocumentHistory(entry.snapshot, entry.view)
          : null;
        if (!undoEntry || !renames) {
          showNotice("Could not redo this change.", {
            tone: "danger",
          });
          return;
        }

        popRedoEntry(entry);
        // See undoHistory: the same restatement, in the other direction.
        renameStacksAcrossRestore(renames);
        updateUndoStack((stack) => [...stack, undoEntry]);
        lastUndoCommitTimeRef.current = 0;
        return;
      }

      popRedoEntry(entry);
      updateUndoStack((stack) => [
        ...stack,
        annotationHistoryEntry(annotationsRef.current),
      ]);
      applyAnnotationHistory(entry.annotations);
      lastUndoCommitTimeRef.current = 0;
    } finally {
      if (!handedOffBusyState) {
        finishBusyOperation();
      }
    }
  }

  function updateUndoStack(
    next:
      | PdfDocumentEditorHistoryEntry[]
      | ((
          current: PdfDocumentEditorHistoryEntry[],
        ) => PdfDocumentEditorHistoryEntry[]),
  ) {
    const nextStack = trimHistoryStack(
      typeof next === "function" ? next(undoStackRef.current) : next,
    );
    undoStackRef.current = nextStack;
    setUndoStack(nextStack);
  }

  function updateRedoStack(
    next:
      | PdfDocumentEditorHistoryEntry[]
      | ((
          current: PdfDocumentEditorHistoryEntry[],
        ) => PdfDocumentEditorHistoryEntry[]),
  ) {
    const nextStack = trimHistoryStack(
      typeof next === "function" ? next(redoStackRef.current) : next,
    );
    redoStackRef.current = nextStack;
    setRedoStack(nextStack);
  }

  function renameStacksAcrossRestore(renames: PdfAnnotationRenames) {
    if (renames.size === 0) {
      return;
    }

    updateUndoStack((stack) => renameHistoryAnnotationSources(stack, renames));
    updateRedoStack((stack) => renameHistoryAnnotationSources(stack, renames));
  }

  function popUndoEntry(entry: PdfDocumentEditorHistoryEntry) {
    updateUndoStack((stack) =>
      stack.at(-1) === entry ? stack.slice(0, -1) : stack,
    );
  }

  function popRedoEntry(entry: PdfDocumentEditorHistoryEntry) {
    updateRedoStack((stack) =>
      stack.at(-1) === entry ? stack.slice(0, -1) : stack,
    );
  }

  function pushDocumentUndoEntry(entry: PdfDocumentEditorHistoryEntry | null) {
    if (!entry) {
      return;
    }

    updateUndoStack((stack) => [...stack, entry]);
    updateRedoStack([]);
  }

  // Sole place that writes `annotations` state; annotationsRef is updated
  // synchronously inside the updater so every write site gets a live ref.
  function setAnnotationsState(
    update: PdfAnnotation[] | ((current: PdfAnnotation[]) => PdfAnnotation[]),
  ) {
    setAnnotations((current) => {
      const next = typeof update === "function" ? update(current) : update;
      annotationsRef.current = next;
      return next;
    });
  }

  function applyAnnotationHistory(nextAnnotations: PdfAnnotation[]) {
    setAnnotationsState(nextAnnotations);
    clearViewSelections();
  }

  function replaceAnnotationsWithoutHistory(nextAnnotations: PdfAnnotation[]) {
    setAnnotationsState(nextAnnotations.map(normalizeAnnotationLayout));
  }

  function documentHistoryEntry(
    operation: PdfStructuralOperation,
  ): PdfDocumentEditorHistoryEntry | null {
    const snapshot = createDocumentHistorySnapshot(operation);
    return snapshot
      ? {
          kind: "document",
          snapshot,
          view: capturePrimaryViewSnapshot(),
        }
      : null;
  }

  function createDocumentHistorySnapshot(
    operation: PdfStructuralOperation,
  ): PdfDocumentEditorHistorySnapshot | null {
    if (!pdfBytes) {
      return null;
    }

    const snapshot = {
      annotations: annotationsRef.current.map(normalizeAnnotationLayout),
      cleanAnnotations: cleanAnnotationsRef.current.map(
        normalizeAnnotationLayout,
      ),
      cleanPdfBytes: cleanPdfBytesRef.current,
      cleanSignatureRefreshEnabled: cleanSignatureRefreshEnabledRef.current,
      cleanWorkSignature,
      importedAnnotationPageIndexes: Array.from(
        importedAnnotationPagesRef.current,
      ),
      managedAnnotationPageIndexes: Array.from(
        managedAnnotationPagesRef.current,
      ),
      operation,
      pdfFingerprint: pdfFingerprintRef.current,
      removedAnnotationSourceIds: Array.from(
        removedAnnotationSourceIdsRef.current,
      ),
      shouldImportAnnotations: shouldImportAnnotationsRef.current,
    };

    if (
      documentHistorySnapshotByteSize(snapshot) >
      MAX_DOCUMENT_HISTORY_ENTRY_BYTES
    ) {
      if (!largeDocumentHistoryNoticeShownRef.current) {
        largeDocumentHistoryNoticeShownRef.current = true;
        showNotice(
          "Page edit undo is limited for this large PDF to reduce memory use.",
          {
            tone: "warning",
          },
        );
      }
      return null;
    }

    return markNonSerializable(snapshot);
  }

  function resetPdfState({
    clearAnnotations = true,
    clearFileInfo = true,
  }: {
    clearAnnotations?: boolean;
    clearFileInfo?: boolean;
  } = {}) {
    scheduleLoadedPagesCleanup(pagesRef.current);
    pagesRef.current = [];
    loadingPagesRef.current.clear();
    resetPageCache();
    importedAnnotationPagesRef.current.clear();
    setAnnotationsComplete(false);
    liveAnnotationEditRef.current = { kind: "idle" };
    structureReloadInProgressRef.current = false;
    removedAnnotationSourceIdsRef.current.clear();
    largeDocumentHistoryNoticeShownRef.current = false;
    pdfFingerprintRef.current = "";
    cleanPdfBytesRef.current = null;
    cleanSignatureRefreshEnabledRef.current = true;
    downloadTargetRef.current = null;
    saveAsTargetRef.current = null;
    saveTargetRef.current = null;
    fileKeyRef.current = null;
    passwordProtectedLoadRef.current = false;
    setPdfBytes(null);
    setPdfFingerprint("");
    commitPdfDocument(null);
    setPages([]);
    setPageSize(null);
    eachView((attached) => {
      attached.setScale(ACTUAL_SIZE_ZOOM);
      attached.resetInitialVisualReadiness();
    });
    resetViewsToPage(0);
    onShowAnnotationsChange?.(true);
    onDocumentReset?.();
    setPasswordRequest(null);
    setReadOnlyReason(null);
    setEditingEnabled(false);
    if (clearFileInfo) {
      setFileName(UNNAMED_DOCUMENT);
      if (manageDocumentTitle && emptyTitle) {
        document.title = emptyTitle;
      }
    }

    if (clearAnnotations) {
      cleanAnnotationsRef.current = [];
      managedAnnotationPagesRef.current.clear();
      setAnnotationsState([]);
      updateUndoStack([]);
      updateRedoStack([]);
      setCurrentCleanWorkSignature("");
    }
  }

  function setCurrentCleanWorkSignature(signature: string) {
    cleanWorkSignatureRef.current = signature;
    setCleanWorkSignature(signature);
  }

  function setCurrentBusy(nextBusy: boolean) {
    busyRef.current = nextBusy;
    onBusyChange?.(nextBusy);
    setBusy(nextBusy);
  }

  function beginBusyOperation() {
    if (busyRef.current) {
      return false;
    }

    setCurrentBusy(true);
    return true;
  }

  function finishBusyOperation() {
    setCurrentBusy(false);
  }

  function clearRenderCache({ clearState }: { clearState: boolean }) {
    scheduleLoadedPagesCleanup(pagesRef.current);
    pagesRef.current = [];
    loadingPagesRef.current.clear();
    resetPageCache();
    const commitState = clearState && mountedRef.current;
    eachView((attached) => attached.clearInitialVisualReadiness(commitState));

    if (!commitState) {
      return;
    }

    commitPdfDocument(null);
    setPages([]);
    setPageSize(null);
  }

  async function destroyPdfDocument(doc: PDFDocumentProxy | null) {
    try {
      await doc?.cleanup();
    } catch {
      // Rendering may still be cancelling; destroy remains the authoritative release.
    }

    try {
      await (doc as { destroy?: () => Promise<void> } | null)?.destroy?.();
    } catch {
      // Teardown only.
    }
  }

  async function cancelLoadingTask() {
    const loadingTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    try {
      await loadingTask?.destroy();
    } catch {
      // Teardown only.
    }
  }

  function startPdfLoading(bytes: Uint8Array, generation: number) {
    passwordProtectedLoadRef.current = false;
    setPasswordRequest(null);
    const loadingTask = getDocument({
      ...PDFJS_DOCUMENT_OPTIONS,
      data: bytes.slice(),
    });

    loadingTask.onPassword = (
      updatePassword: (password: string) => void,
      reason: number,
    ) => {
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      passwordProtectedLoadRef.current = true;
      setCurrentBusy(false);
      setLoadError(null);
      setPasswordRequest({
        failed: reason === PasswordResponses.INCORRECT_PASSWORD,
        generation,
        updatePassword,
      });
    };

    loadingTaskRef.current = loadingTask;
    return loadingTask;
  }

  // An empty string is ignored rather than sent, so a blank submit does not
  // burn one of PDF.js's attempts.

  function handlePasswordUnlock(password: string) {
    const request = passwordRequest;
    if (!request || request.generation !== loadGenerationRef.current) {
      return;
    }

    if (!password) {
      return;
    }

    setPasswordRequest(null);
    setCurrentBusy(true);
    request.updatePassword(password);
  }

  async function confirmDiscardUnsavedChanges() {
    if (!hasUnsavedChanges) {
      return true;
    }

    if (confirmDiscardChanges) {
      try {
        return await confirmDiscardChanges({
          fileName,
          hasUnsavedChanges,
        });
      } catch {
        showNotice("Could not confirm. Nothing was closed.", {
          tone: "danger",
        });
        return false;
      }
    }

    return false;
  }

  async function handleClosePdf() {
    if (busyRef.current) {
      return;
    }

    if (!(await confirmDiscardUnsavedChanges())) {
      return;
    }

    const currentPdfDoc = pdfDoc;
    pdfDocRef.current = null;
    loadGenerationRef.current += 1;
    onClose();
    await cancelLoadingTask();
    await destroyPdfDocument(currentPdfDoc);
  }

  async function handlePrint() {
    if (
      !pdfBytes ||
      pages.length === 0 ||
      !printTarget ||
      !beginBusyOperation()
    ) {
      return;
    }

    try {
      const printableBytes = await printablePdfBytes();
      await printTarget(printableBytes, printableName(fileName));
    } catch (error) {
      eachView((attached) => attached.revealPreparationError(error));
      showNotice(
        preparationErrorNotice(
          error,
          "Could not prepare this PDF for printing.",
        ),
        { tone: "danger" },
      );
    } finally {
      finishBusyOperation();
    }
  }

  async function restoreSession(session: SensitivePdfDocumentEditorSession) {
    await loadPdfBytes(session.pdfBytes, session.fileName, {
      activePage:
        session.view.viewPosition?.pageIndex ?? session.view.activePageIndex,
      clearWorkingAnnotations: false,
      restoredSession: session,
      downloadTarget: session.downloadTarget ?? source.downloadTarget ?? null,
      saveTarget: session.saveTarget ?? source.saveTarget ?? null,
      saveAsTarget: session.saveAsTarget ?? source.saveAsTarget ?? null,
      fileKey: session.fileKey ?? source.fileKey,
      sourceId: session.sourceId,
    });
  }

  async function loadSource(
    nextSource: PdfDocumentEditorSource,
    loadKey: string,
  ) {
    let bytes: Uint8Array;
    setLoadError(null);

    try {
      if (nextSource.kind === "loader") {
        resetPdfState({
          clearAnnotations: true,
          clearFileInfo: false,
        });
        setFileName(nextSource.name);
        setCurrentBusy(true);
        bytes = await nextSource.loadBytes();
        if (!mountedRef.current || sourceLoadRef.current !== loadKey) {
          return;
        }
      } else {
        bytes = nextSource.bytes;
      }

      await loadPdfBytes(bytes, nextSource.name, {
        initialAnnotations: nextSource.initialAnnotations,
        downloadTarget: nextSource.downloadTarget ?? null,
        fileKey: nextSource.fileKey,
        saveAsTarget: nextSource.saveAsTarget ?? null,
        saveTarget: nextSource.saveTarget ?? null,
        sourceId: nextSource.sourceId,
      });

      if (
        mountedRef.current &&
        nextSource.markDirty &&
        sourceLoadRef.current === loadKey
      ) {
        cleanSignatureRefreshEnabledRef.current = false;
        setCurrentCleanWorkSignature(
          createWorkSignature(`unsaved:${byteFingerprint(bytes)}`, []),
        );
      }
    } catch (error) {
      if (!mountedRef.current || sourceLoadRef.current !== loadKey) {
        return;
      }

      const message =
        error instanceof Error ? error.message : "Could not load PDF.";
      resetPdfState({
        clearAnnotations: true,
        clearFileInfo: false,
      });
      setFileName(nextSource.name);
      setCurrentBusy(false);
      setLoadError(message);
    }
  }

  async function loadPdfBytes(
    bytes: Uint8Array,
    name: string,
    options: {
      activePage?: number;
      clearWorkingAnnotations?: boolean;
      initialAnnotations?: PdfAnnotation[];
      restoredSession?: SensitivePdfDocumentEditorSession | null;
      downloadTarget?: PdfDownloadTarget | null;
      fileKey?: string;
      saveAsTarget?: PdfSaveAsTarget | null;
      saveTarget?: PdfSaveTarget | null;
      sourceId?: string;
    } = {},
  ) {
    const currentPdfDoc = pdfDoc;
    const generation = loadGenerationRef.current + 1;
    const restoredSession = options.restoredSession ?? null;
    loadGenerationRef.current = generation;
    resetPdfState({
      clearAnnotations: options.clearWorkingAnnotations ?? true,
      clearFileInfo: false,
    });
    sourceIdRef.current = options.sourceId ?? sourceIdRef.current;
    if (restoredSession) {
      importedAnnotationPagesRef.current = new Set(
        restoredSession.importedAnnotationPageIndexes,
      );
      managedAnnotationPagesRef.current = new Set(
        restoredSession.managedAnnotationPageIndexes,
      );
      removedAnnotationSourceIdsRef.current = new Set(
        restoredSession.removedAnnotationSourceIds,
      );
      shouldImportAnnotationsRef.current =
        restoredSession.shouldImportAnnotations;
    } else {
      shouldImportAnnotationsRef.current = true;
    }
    setLoadError(null);
    setCurrentBusy(true);

    try {
      await cancelLoadingTask();
      await destroyPdfDocument(currentPdfDoc);
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      const loadingTask = startPdfLoading(bytes, generation);
      // Hashed while pdf.js parses in its worker; not needed until later.
      const nextPdfFingerprint = byteFingerprint(bytes);
      const loadedPdf = await loadingTask.promise;
      if (loadingTaskRef.current === loadingTask) {
        loadingTaskRef.current = null;
      }
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        return;
      }

      // The file is refused here or not at all; a restored tab was weighed when
      // it was opened.
      if (!restoredSession) {
        const annotationCharacters = await annotationTextCharacters(
          loadedPdf,
          MAX_DOCUMENT_ANNOTATION_TEXT_CHARACTERS,
        );
        if (!mountedRef.current || generation !== loadGenerationRef.current) {
          await destroyPdfDocument(loadedPdf);
          return;
        }

        if (annotationCharacters > MAX_DOCUMENT_ANNOTATION_TEXT_CHARACTERS) {
          await destroyPdfDocument(loadedPdf);
          throw new Error(
            `The selected PDF's notes and comments hold more than ${MAX_DOCUMENT_ANNOTATION_TEXT_CHARACTERS / 1_000_000} million characters of text, which is the current safety limit. It has not been opened.`,
          );
        }
      }

      // Gates only the banner and the editing toggle, so it need not block
      // page 1.
      const activePage = Math.min(
        options.activePage ?? 0,
        loadedPdf.numPages - 1,
      );
      const [nextReadOnlyReason, firstPage] = await Promise.all([
        restoredSession?.readOnlyReason
          ? Promise.resolve(restoredSession.readOnlyReason)
          : detectReadOnlyReason(
              bytes,
              loadedPdf,
              passwordProtectedLoadRef.current,
            ),
        loadedPdf.getPage(activePage + 1),
      ]);
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        return;
      }

      const firstViewport = firstPage.getViewport({ scale: 1 });
      const initialPages = Array<LoadedPage>(loadedPdf.numPages).fill(null);
      initialPages[activePage] = firstPage;
      pagesRef.current = initialPages;
      markPageAccess(activePage);
      eachView((attached) => attached.resetInitialVisualReadiness(activePage));

      pdfFingerprintRef.current = nextPdfFingerprint;
      cleanPdfBytesRef.current = restoredSession?.cleanPdfBytes ?? bytes;
      setPdfBytes(bytes);
      setPdfFingerprint(nextPdfFingerprint);
      commitPdfDocument(loadedPdf);
      setPageSize({
        width: firstViewport.width,
        height: firstViewport.height,
      });
      setPages(initialPages);
      setFileName(name);
      fileKeyRef.current = restoredSession?.fileKey ?? options.fileKey ?? null;
      downloadTargetRef.current = options.downloadTarget ?? null;
      saveAsTargetRef.current = options.saveAsTarget ?? null;
      const nextEditingEnabled =
        nextReadOnlyReason === "password protected"
          ? false
          : (restoredSession?.editingEnabled ?? false);
      const nextSaveTarget =
        nextReadOnlyReason && nextEditingEnabled
          ? null
          : (options.saveTarget ?? null);
      saveTargetRef.current = nextSaveTarget;
      setReadOnlyReason(nextReadOnlyReason);
      setEditingEnabled(nextEditingEnabled);
      moveViewsToPage(activePage);

      if (restoredSession) {
        cleanAnnotationsRef.current = restoredSession.cleanAnnotations.map(
          normalizeAnnotationLayout,
        );
        eachView((attached) => attached.setScale(restoredSession.view.scale));
        // After the reset above, not before: a restored tab must not flash
        // back to the defaults resetPdfState just announced.
        onSessionRestore?.();
        cleanSignatureRefreshEnabledRef.current =
          restoredSession.cleanSignatureRefreshEnabled ?? true;
        setCurrentCleanWorkSignature(restoredSession.cleanWorkSignature);
        const restoredAnnotations = restoredSession.annotations.map(
          normalizeAnnotationLayout,
        );
        setAnnotationsState(restoredAnnotations);
        clearViewSelections();
        updateUndoStack(restoredSession.undoStack);
        updateRedoStack(restoredSession.redoStack);
      } else if (options.clearWorkingAnnotations ?? true) {
        const initialAnnotations =
          options.initialAnnotations?.map(normalizeAnnotationLayout) ?? [];
        onToolChange?.("select");
        cleanSignatureRefreshEnabledRef.current = true;
        cleanAnnotationsRef.current = [];
        setCurrentCleanWorkSignature(
          createWorkSignature(nextPdfFingerprint, []),
        );
        setAnnotationsState(initialAnnotations);
        clearViewSelections();
        updateUndoStack([]);
        updateRedoStack([]);
      }

      void importInitialPageAnnotations(
        firstPage,
        activePage,
        generation,
        bytes,
      );
      const restoredViewPosition = restoredSession?.view.viewPosition;
      if (restoredViewPosition) {
        eachView((attached) =>
          attached.runAfterInitialVisualReady(() =>
            attached.restoreViewPosition(restoredViewPosition),
          ),
        );
      }

      const remainingPageIndexes = Array.from(
        { length: loadedPdf.numPages },
        (_, index) => index,
      ).filter((pageIndex) => pageIndex !== activePage);

      if (remainingPageIndexes.length === 0) {
        return;
      }

      if (loadedPdf.numPages <= EAGER_PAGE_LIMIT) {
        afterPrimaryViewReady(() => {
          if (!mountedRef.current || generation !== loadGenerationRef.current) {
            return;
          }

          // A failure leaves those pages for ensurePageLoaded to retry.
          void loadPagesEagerly(
            remainingPageIndexes,
            loadedPdf,
            generation,
            bytes,
          ).catch(() => undefined);
        });
        return;
      }
    } catch (error) {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        const message =
          error instanceof Error ? error.message : "Could not load PDF.";
        setLoadError(message);
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setCurrentBusy(false);
      }
    }
  }

  type ReloadedDocument = {
    activeLoadedPage: PDFPageProxy;
    activePage: number;
    activeViewport: PageViewport;
    initialPageIndexes: number[];
    loadedPages: { page: PDFPageProxy; pageIndex: number }[];
    loadedPdf: PDFDocumentProxy;
    nextPages: LoadedPage[];
  };

  // Commits nothing: the two callers differ in which state they set and in what
  // order, and that ordering is load-bearing.
  async function openReloadedDocument(
    bytes: Uint8Array,
    generation: number,
    requestedActivePage: number,
  ): Promise<ReloadedDocument | null> {
    await cancelLoadingTask();
    const loadingTask = startPdfLoading(bytes, generation);
    const loadedPdf = await loadingTask.promise;
    if (loadingTaskRef.current === loadingTask) {
      loadingTaskRef.current = null;
    }
    if (generation !== loadGenerationRef.current) {
      await destroyPdfDocument(loadedPdf);
      return null;
    }

    const activePage = clamp(
      requestedActivePage,
      0,
      Math.max(0, loadedPdf.numPages - 1),
    );
    // What the viewport is displaying, not a band around one index.
    const initialPageIndexes = initialReloadPageIndexes(
      loadedPdf.numPages,
      activePage,
      primaryView()?.visiblePageRangeRef.current ?? null,
    );
    const loadedPages = await Promise.all(
      initialPageIndexes.map(async (pageIndex) => ({
        page: await loadedPdf.getPage(pageIndex + 1),
        pageIndex,
      })),
    );
    if (generation !== loadGenerationRef.current) {
      await destroyPdfDocument(loadedPdf);
      return null;
    }

    const nextPages = Array<LoadedPage>(loadedPdf.numPages).fill(null);
    for (const { page, pageIndex } of loadedPages) {
      nextPages[pageIndex] = page;
      markPageAccess(pageIndex);
    }

    const activeLoadedPage =
      nextPages[activePage] ??
      loadedPages[0]?.page ??
      (await loadedPdf.getPage(activePage + 1));
    if (!nextPages[activePage]) {
      nextPages[activePage] = activeLoadedPage;
      markPageAccess(activePage);
    }

    return {
      activeLoadedPage,
      activePage,
      activeViewport: activeLoadedPage.getViewport({ scale: 1 }),
      initialPageIndexes,
      loadedPages,
      loadedPdf,
      nextPages,
    };
  }

  // The reload claims the generation before it can fail, so both outcomes it
  // owns report one; `superseded` carries none.
  type StructureReloadOutcome =
    | { generation: number; state: "committed" }
    | { generation: number; state: "failed" }
    | { state: "superseded" };

  async function replacePdfAfterStructureEdit(
    bytes: Uint8Array,
    options: { activePage: number },
  ): Promise<StructureReloadOutcome> {
    const currentPdfDoc = pdfDoc;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    cleanSignatureRefreshEnabledRef.current = false;
    shouldImportAnnotationsRef.current = true;
    importedAnnotationPagesRef.current.clear();
    setAnnotationsComplete(false);
    loadingPagesRef.current.clear();
    resetPageCache();
    let pendingPdf: PDFDocumentProxy | null = null;
    structureReloadInProgressRef.current = true;
    try {
      const nextPdfFingerprint = byteFingerprint(bytes);
      const opened = await openReloadedDocument(
        bytes,
        generation,
        options.activePage,
      );
      if (!opened) {
        return { state: "superseded" };
      }

      const {
        activePage,
        activeViewport,
        initialPageIndexes,
        loadedPages,
        loadedPdf,
        nextPages,
      } = opened;
      // Held so this function's own catch can destroy it if the commit below
      // throws; openReloadedDocument cleans up its own failures.
      pendingPdf = loadedPdf;
      pdfFingerprintRef.current = nextPdfFingerprint;
      cleanPdfBytesRef.current = null;
      pagesRef.current = nextPages;
      setPdfBytes(bytes);
      setPdfFingerprint(nextPdfFingerprint);
      commitPdfDocument(loadedPdf);
      setPageSize({
        width: activeViewport.width,
        height: activeViewport.height,
      });
      setPages(nextPages);
      pendingPdf = null;
      resetViewsToPage(activePage);
      onDocumentReplaced?.();

      for (const { page, pageIndex } of loadedPages) {
        void importAnnotationsForLoadedPage(page, pageIndex, generation, bytes);
      }

      scheduleAfterVisiblePaint(() => {
        void destroyPdfDocument(currentPdfDoc);
      });

      const initialPageIndexSet = new Set(initialPageIndexes);
      const remainingPageIndexes = Array.from(
        { length: loadedPdf.numPages },
        (_, index) => index,
      ).filter((pageIndex) => !initialPageIndexSet.has(pageIndex));
      if (
        loadedPdf.numPages <= EAGER_PAGE_LIMIT &&
        remainingPageIndexes.length > 0
      ) {
        afterPrimaryViewReady(() => {
          if (generation !== loadGenerationRef.current) {
            return;
          }

          void loadPagesEagerly(
            remainingPageIndexes,
            loadedPdf,
            generation,
            bytes,
          ).catch(() => undefined);
        });
      }

      return { generation, state: "committed" };
    } catch {
      if (pendingPdf) {
        await destroyPdfDocument(pendingPdf);
      }
      // Nothing was committed: bytes, document and page table are unchanged.
      return { generation, state: "failed" };
    } finally {
      if (generation === loadGenerationRef.current) {
        structureReloadInProgressRef.current = false;
      }
    }
  }

  // Covers everything but the history stacks, whose entries describe the page
  // order before this edit.
  function restateIdentitiesAcrossPageEdit(
    change: PdfPageOrderChange,
    renames: PdfAnnotationRenames,
  ) {
    const mapping = pageMappingFor(change);
    // Read off the baseline before it is restated: an indirect reference
    // carries no page of its own.
    const removedSourcePages = pageIndexesBySourceKey(
      cleanAnnotationsRef.current,
    );
    managedAnnotationPagesRef.current = remapPageSetAcrossPageEdit(
      managedAnnotationPagesRef.current,
      mapping,
    );
    importedAnnotationPagesRef.current = remapPageSetAcrossPageEdit(
      importedAnnotationPagesRef.current,
      mapping,
    );
    cleanAnnotationsRef.current = remapAnnotationsAcrossPageEdit(
      cleanAnnotationsRef.current,
      mapping,
      renames,
    );
    removedAnnotationSourceIdsRef.current = new Set(
      remapRemovedSourcesAcrossPageEdit(
        removedAnnotationSourceIdsRef.current,
        mapping,
        (sourceId) => removedSourcePages.get(sourceId) ?? null,
        renames,
      ),
    );
    const nextAnnotations = remapAnnotationsAcrossPageEdit(
      annotationsRef.current,
      mapping,
      renames,
    );
    if (nextAnnotations !== annotationsRef.current) {
      replaceAnnotationsWithoutHistory(nextAnnotations);
    }
  }

  // Keyed the way a pending removal names it (`sourceId ?? id`).
  function pageIndexesBySourceKey(annotations: PdfAnnotation[]) {
    const pages = new Map<string, number>();
    for (const annotation of annotations) {
      pages.set(annotation.sourceId ?? annotation.id, annotation.pageIndex);
    }
    return pages;
  }

  // An edit that fails after the restatement has to put this back.
  function captureAncillaryState(): DocumentEditorAncillaryState {
    return {
      annotations: annotationsRef.current,
      cleanAnnotations: cleanAnnotationsRef.current,
      cleanPdfBytes: cleanPdfBytesRef.current,
      cleanSignatureRefreshEnabled: cleanSignatureRefreshEnabledRef.current,
      cleanWorkSignature: cleanWorkSignatureRef.current,
      importedAnnotationPageIndexes: Array.from(
        importedAnnotationPagesRef.current,
      ),
      managedAnnotationPageIndexes: Array.from(
        managedAnnotationPagesRef.current,
      ),
      removedAnnotationSourceIds: Array.from(
        removedAnnotationSourceIdsRef.current,
      ),
      shouldImportAnnotations: shouldImportAnnotationsRef.current,
    };
  }

  // Not restoreDocumentHistory, which applies the entry's operation to bytes it
  // assumes were already committed.
  function rollbackAncillaryStateOnly(snapshot: DocumentEditorAncillaryState) {
    cleanSignatureRefreshEnabledRef.current =
      snapshot.cleanSignatureRefreshEnabled ?? true;
    importedAnnotationPagesRef.current = new Set(
      snapshot.importedAnnotationPageIndexes,
    );
    setAnnotationsComplete(false);
    managedAnnotationPagesRef.current = new Set(
      snapshot.managedAnnotationPageIndexes,
    );
    removedAnnotationSourceIdsRef.current = new Set(
      snapshot.removedAnnotationSourceIds,
    );
    shouldImportAnnotationsRef.current = snapshot.shouldImportAnnotations;
    cleanPdfBytesRef.current = snapshot.cleanPdfBytes ?? null;
    cleanAnnotationsRef.current = snapshot.cleanAnnotations.map(
      normalizeAnnotationLayout,
    );
    setCurrentCleanWorkSignature(snapshot.cleanWorkSignature);
    replaceAnnotationsWithoutHistory(snapshot.annotations);
    clearViewSelections();
  }

  // After a save since the snapshot: the pages this restore keeps are the
  // written file's, while the pages it brings back keep the snapshot's record.
  function cleanBaselineAcrossRestore(
    snapshot: PdfDocumentEditorHistorySnapshot,
    currentCleanAnnotations: PdfAnnotation[],
  ) {
    const mapping = pageMappingFor(
      pageOrderChangeOfOperation(snapshot.operation),
    );
    return [
      ...remapAnnotationsAcrossPageEdit(currentCleanAnnotations, mapping),
      ...snapshot.cleanAnnotations.filter(
        (annotation) => mapping.backward(annotation.pageIndex) === null,
      ),
    ];
  }

  // `viewSnapshot`'s zoom is deliberately not applied: undoing a page deletion
  // is not a request to re-zoom the document.
  async function restoreDocumentHistory(
    snapshot: PdfDocumentEditorHistorySnapshot,
    viewSnapshot: PdfDocumentEditorViewSnapshot,
  ): Promise<PdfAnnotationRenames | null> {
    if (!pdfBytes) {
      return null;
    }

    const currentPdfDoc = pdfDoc;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    cleanSignatureRefreshEnabledRef.current =
      snapshot.cleanSignatureRefreshEnabled ?? true;
    importedAnnotationPagesRef.current = new Set(
      snapshot.importedAnnotationPageIndexes,
    );
    setAnnotationsComplete(false);
    managedAnnotationPagesRef.current = new Set(
      snapshot.managedAnnotationPageIndexes,
    );
    removedAnnotationSourceIdsRef.current = new Set(
      snapshot.removedAnnotationSourceIds,
    );
    shouldImportAnnotationsRef.current = snapshot.shouldImportAnnotations;
    loadingPagesRef.current.clear();
    resetPageCache();
    let pendingPdf: PDFDocumentProxy | null = null;
    structureReloadInProgressRef.current = true;
    setCurrentBusy(true);

    try {
      // Both halves: the page half the snapshot's identities already describe,
      // and this object report, because a copy re-creates every dictionary.
      const {
        bytes: restoredBytes,
        descriptionsUnproven,
        renames,
      } = await applyStructuralOperation(pdfBytes, snapshot.operation);
      if (descriptionsUnproven) {
        showNotice(UNPROVEN_PAGE_DELETE_NOTICE, { tone: "warning" });
      }
      const opened = await openReloadedDocument(
        restoredBytes,
        generation,
        viewSnapshot.viewPosition?.pageIndex ?? viewSnapshot.activePageIndex,
      );
      if (!opened) {
        return null;
      }

      const {
        activePage,
        activeViewport,
        initialPageIndexes,
        loadedPages,
        loadedPdf,
        nextPages,
      } = opened;
      pendingPdf = loadedPdf;
      const restoredAnnotations = remapAnnotationsAcrossPageEdit(
        snapshot.annotations,
        UNCHANGED_PAGE_ORDER,
        renames,
      ).map(normalizeAnnotationLayout);
      // The clean baseline has to describe the file this restore lands on, and
      // a save since the snapshot describes one that no longer exists.
      const cleanBaselineIsStale =
        (cleanPdfBytesRef.current ?? null) !== (snapshot.cleanPdfBytes ?? null);
      const restoredCleanAnnotations = remapAnnotationsAcrossPageEdit(
        cleanBaselineIsStale
          ? cleanBaselineAcrossRestore(snapshot, cleanAnnotationsRef.current)
          : snapshot.cleanAnnotations,
        UNCHANGED_PAGE_ORDER,
        renames,
      ).map(normalizeAnnotationLayout);

      // A removal replayed against a re-created object deletes nothing and
      // stops the save.
      removedAnnotationSourceIdsRef.current = new Set(
        remapRemovedSourcesAcrossPageEdit(
          removedAnnotationSourceIdsRef.current,
          UNCHANGED_PAGE_ORDER,
          () => null,
          renames,
        ),
      );

      pdfFingerprintRef.current = snapshot.pdfFingerprint;
      // With no clean byte copy, the save path falls back to the live bytes.
      cleanPdfBytesRef.current = cleanBaselineIsStale
        ? null
        : (snapshot.cleanPdfBytes ?? null);
      cleanAnnotationsRef.current = restoredCleanAnnotations;
      pagesRef.current = nextPages;
      eachView((attached) => attached.resetInitialVisualReadiness(activePage));
      setPdfBytes(restoredBytes);
      setPdfFingerprint(snapshot.pdfFingerprint);
      commitPdfDocument(loadedPdf);
      setPageSize({
        width: activeViewport.width,
        height: activeViewport.height,
      });
      setPages(nextPages);
      setCurrentCleanWorkSignature(
        cleanBaselineIsStale
          ? createWorkSignature(
              snapshot.pdfFingerprint,
              restoredCleanAnnotations,
            )
          : snapshot.cleanWorkSignature,
      );
      setAnnotationsState(restoredAnnotations);
      pendingPdf = null;
      resetViewsToPage(activePage);
      onDocumentReplaced?.();

      for (const { page, pageIndex } of loadedPages) {
        if (pageIndex === activePage) {
          void importInitialPageAnnotations(
            page,
            pageIndex,
            generation,
            restoredBytes,
          );
        } else {
          void importAnnotationsForLoadedPage(
            page,
            pageIndex,
            generation,
            restoredBytes,
          );
        }
      }

      const restoredViewPosition = viewSnapshot.viewPosition;
      if (restoredViewPosition) {
        eachView((attached) =>
          attached.runAfterInitialVisualReady(() =>
            attached.restoreViewPosition(restoredViewPosition),
          ),
        );
      }

      scheduleAfterVisiblePaint(() => {
        void destroyPdfDocument(currentPdfDoc);
      });

      const initialPageIndexSet = new Set(initialPageIndexes);
      const remainingPageIndexes = Array.from(
        { length: loadedPdf.numPages },
        (_, index) => index,
      ).filter((pageIndex) => !initialPageIndexSet.has(pageIndex));
      if (
        loadedPdf.numPages <= EAGER_PAGE_LIMIT &&
        remainingPageIndexes.length > 0
      ) {
        afterPrimaryViewReady(() => {
          if (generation !== loadGenerationRef.current) {
            return;
          }

          void loadPagesEagerly(
            remainingPageIndexes,
            loadedPdf,
            generation,
            restoredBytes,
          ).catch(() => undefined);
        });
      }

      return renames;
    } catch {
      if (pendingPdf) {
        await destroyPdfDocument(pendingPdf);
      }
      return null;
    } finally {
      if (generation === loadGenerationRef.current) {
        structureReloadInProgressRef.current = false;
        setCurrentBusy(false);
      }
    }
  }

  async function ensurePageLoaded(
    pageIndex: number,
    doc: PDFDocumentProxy | null = pdfDoc,
    generation = loadGenerationRef.current,
    options: { evictOldPages?: boolean } = {},
    pdfBytes: Uint8Array | null = pdfBytesRef.current,
  ) {
    if (
      !doc ||
      structureReloadInProgressRef.current ||
      pageIndex < 0 ||
      pageIndex >= doc.numPages ||
      generation !== loadGenerationRef.current
    ) {
      return null;
    }

    const loadedPage = pagesRef.current[pageIndex];
    if (loadedPage) {
      markPageAccess(pageIndex);
      return loadedPage;
    }

    if (loadingPagesRef.current.has(pageIndex)) {
      return null;
    }

    loadingPagesRef.current.add(pageIndex);
    try {
      const page = await doc.getPage(pageIndex + 1);
      if (generation !== loadGenerationRef.current) {
        return null;
      }

      setPages((current) => {
        if (current[pageIndex]) {
          markPageAccess(pageIndex);
          return current;
        }

        const next = [...current];
        next[pageIndex] = page;
        markPageAccess(pageIndex);
        const retained =
          options.evictOldPages === false
            ? next
            : evictOldLoadedPages(next, pageIndex);
        pagesRef.current = retained;
        return retained;
      });

      await importAnnotationsForLoadedPage(
        page,
        pageIndex,
        generation,
        pdfBytes,
      );
      return page;
    } catch {
      if (generation === loadGenerationRef.current) {
        showNotice(`Could not load page ${pageIndex + 1}.`, {
          tone: "danger",
        });
      }
      return null;
    } finally {
      loadingPagesRef.current.delete(pageIndex);
    }
  }

  async function loadPagesEagerly(
    pageIndexes: number[],
    doc: PDFDocumentProxy,
    generation: number,
    pdfBytes: Uint8Array | null,
  ) {
    for (const pageIndex of pageIndexes) {
      loadingPagesRef.current.add(pageIndex);
    }

    let loadedPages: Array<{ page: PDFPageProxy; pageIndex: number }>;
    try {
      loadedPages = await Promise.all(
        pageIndexes.map(async (pageIndex) => ({
          page: await doc.getPage(pageIndex + 1),
          pageIndex,
        })),
      );
    } finally {
      for (const pageIndex of pageIndexes) {
        loadingPagesRef.current.delete(pageIndex);
      }
    }

    if (generation !== loadGenerationRef.current) {
      return;
    }

    setPages((current) => {
      const next = [...current];
      for (const { page, pageIndex } of loadedPages) {
        next[pageIndex] = page;
        markPageAccess(pageIndex);
      }
      pagesRef.current = next;
      return next;
    });

    if (!shouldImportAnnotationsRef.current) {
      return;
    }

    // Reading a page this session already manages mints a second annotation for
    // every dictionary on it, and both then resolve to one on save.
    const pagesToImport = loadedPages.filter(
      ({ pageIndex }) =>
        !importedAnnotationPagesRef.current.has(pageIndex) &&
        !managedAnnotationPagesRef.current.has(pageIndex),
    );
    for (const { pageIndex } of loadedPages) {
      importedAnnotationPagesRef.current.add(pageIndex);
      managedAnnotationPagesRef.current.add(pageIndex);
    }

    if (!pdfBytes || pagesToImport.length === 0) {
      return;
    }

    const importResults = await Promise.all(
      pagesToImport.map(({ page, pageIndex }) =>
        importExistingAnnotationsForPage(page, pageIndex, pdfBytes),
      ),
    );
    if (generation !== loadGenerationRef.current) {
      return;
    }

    commitImportedAnnotations(
      importResults.flatMap((result) => result.annotations),
      importResults.reduce((sum, result) => sum + result.malformedCount, 0),
    );
  }

  // They join the clean set as well as the working one: an annotation already
  // in the file is not an edit.
  function commitImportedAnnotations(
    importedAnnotations: PdfAnnotation[],
    malformedCount: number,
  ) {
    reportMalformedAnnotations(malformedCount);
    if (importedAnnotations.length === 0) {
      return;
    }

    cleanAnnotationsRef.current = mergeImportedAnnotations(
      cleanAnnotationsRef.current,
      importedAnnotations,
    );
    refreshCleanWorkSignatureFromImports();
    setAnnotationsState((current) =>
      mergeImportedAnnotations(current, importedAnnotations),
    );
  }

  async function importAnnotationsForLoadedPage(
    page: PDFPageProxy,
    pageIndex: number,
    generation: number,
    pdfBytes: Uint8Array | null,
  ) {
    if (
      !shouldImportAnnotationsRef.current ||
      importedAnnotationPagesRef.current.has(pageIndex) ||
      managedAnnotationPagesRef.current.has(pageIndex)
    ) {
      importedAnnotationPagesRef.current.add(pageIndex);
      return;
    }

    importedAnnotationPagesRef.current.add(pageIndex);
    managedAnnotationPagesRef.current.add(pageIndex);
    if (!pdfBytes) {
      return;
    }

    const { annotations: importedAnnotations, malformedCount } =
      await importExistingAnnotationsForPage(page, pageIndex, pdfBytes);
    if (generation !== loadGenerationRef.current) {
      return;
    }

    commitImportedAnnotations(importedAnnotations, malformedCount);
  }

  // A page fetched here never enters `pages`, so no canvas is made for it and
  // the LRU never sees it.
  const ANNOTATION_SCAN_CHUNK = 8;

  async function scanDocumentAnnotations() {
    const doc = pdfDocRef.current;
    const bytes = pdfBytesRef.current;
    const generation = loadGenerationRef.current;
    if (structureReloadInProgressRef.current) {
      // Mid-reload, reading now would import old page indexes and mark those
      // pages done, so the reload's own import would skip them.
      return;
    }

    if (!doc || !bytes || !shouldImportAnnotationsRef.current) {
      // Nothing more can arrive: no document, or no importing in this session.
      if (mountedRef.current) {
        setAnnotationsComplete(true);
      }
      return;
    }

    let unreadablePages = 0;
    let pending: Array<{ page: PDFPageProxy; pageIndex: number }> = [];

    const flush = async () => {
      const chunk = pending;
      pending = [];
      if (chunk.length === 0) {
        return;
      }

      const results = [];
      for (const { page, pageIndex } of chunk) {
        try {
          results.push(
            await importExistingAnnotationsForPage(page, pageIndex, bytes),
          );
        } catch (error) {
          unreadablePages += 1;
          console.error(
            `Could not read annotations on page ${pageIndex + 1}.`,
            error,
          );
        } finally {
          // Only pages this pass fetched itself; a shown page owns its own.
          if (!pagesRef.current[pageIndex]) {
            try {
              page.cleanup();
            } catch {
              // Resource bookkeeping only.
            }
          }
        }
      }

      if (generation !== loadGenerationRef.current) {
        return;
      }

      commitImportedAnnotations(
        results.flatMap((result) => result.annotations),
        results.reduce((sum, result) => sum + result.malformedCount, 0),
      );
    };

    for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      if (
        importedAnnotationPagesRef.current.has(pageIndex) ||
        managedAnnotationPagesRef.current.has(pageIndex)
      ) {
        continue;
      }

      // Marked before the await: scrolling here mid-pass must not import twice.
      importedAnnotationPagesRef.current.add(pageIndex);
      managedAnnotationPagesRef.current.add(pageIndex);
      try {
        pending.push({
          page:
            pagesRef.current[pageIndex] ?? (await doc.getPage(pageIndex + 1)),
          pageIndex,
        });
      } catch (error) {
        unreadablePages += 1;
        console.error(`Could not load page ${pageIndex + 1}.`, error);
      }

      if (pending.length >= ANNOTATION_SCAN_CHUNK) {
        await flush();
      }
    }

    await flush();
    if (!mountedRef.current || generation !== loadGenerationRef.current) {
      return;
    }

    if (unreadablePages > 0) {
      showNotice(
        `Annotations on ${unreadablePages} page${unreadablePages === 1 ? "" : "s"} could not be read, so the list is incomplete.`,
        { tone: "danger" },
      );
    }
    setAnnotationsComplete(true);
  }

  function importAllAnnotations() {
    const generation = loadGenerationRef.current;
    const running = annotationScanRef.current;
    // An older pass aborts on its own generation check, so is not worth joining.
    if (running && running.generation === generation) {
      return running.promise;
    }

    const promise = scanDocumentAnnotations()
      .catch((error: unknown) => {
        // The pass reports per-page failures; nothing here may go unhandled.
        console.error("Could not read the document's annotations.", error);
      })
      .finally(() => {
        if (annotationScanRef.current?.promise === promise) {
          annotationScanRef.current = null;
        }
      });
    annotationScanRef.current = { generation, promise };
    return promise;
  }

  async function importInitialPageAnnotations(
    page: PDFPageProxy,
    pageIndex: number,
    generation: number,
    pdfBytes: Uint8Array | null,
  ) {
    try {
      await importAnnotationsForLoadedPage(
        page,
        pageIndex,
        generation,
        pdfBytes,
      );
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        showNotice(`Could not load annotations on page ${pageIndex + 1}.`, {
          tone: "danger",
        });
      }
    } finally {
      if (mountedRef.current) {
        eachView((attached) =>
          attached.markInitialAnnotationsReady(pageIndex, generation),
        );
      }
    }
  }

  // `pageOrderChange` and `renames` are required, so leaving the restatement
  // out is not a thing this shape can express.
  type StructuralEditPlan = {
    activePage: number;
    bytes: Uint8Array;
    // Null when the document is too large for page history.
    entry: PdfDocumentEditorHistoryEntry | null;
    pageOrderChange: PdfPageOrderChange;
    /** What it renamed - `NO_ANNOTATION_RENAMES` unless it copied pages. */
    renames: PdfAnnotationRenames;
    // Raised after the reload has committed, so it follows a failure notice.
    afterCommit?: () => void;
    /** Between the restatement and the reload; drops a stale selection. */
    beforeReplace?: () => void;
  };

  // A superseded operation must neither apply its result nor roll back another
  // document's ancillary state.
  type StructuralEditContext = {
    /** The bytes this edit started from, captured before the busy flag. */
    bytes: Uint8Array;
    superseded: () => boolean;
  };

  async function runStructuralEdit(options: {
    allowed: boolean;
    failureMessage: string;
    reloadFailureMessage: string;
    /** Null abandons the edit silently: cancelled, or already superseded. */
    run: (edit: StructuralEditContext) => Promise<StructuralEditPlan | null>;
  }) {
    if (readOnly || !pdfBytes || !options.allowed || !beginBusyOperation()) {
      return;
    }

    finishAnnotationEdit();
    const ancillaryBefore = captureAncillaryState();
    // The generation this edit owns: its own reload claims the next one, and
    // this takes that claim over when the reload reports it.
    let generation = loadGenerationRef.current;
    const superseded = () => generation !== loadGenerationRef.current;
    try {
      const plan = await options.run({ bytes: pdfBytes, superseded });
      if (!plan || superseded()) {
        return;
      }

      restateIdentitiesAcrossPageEdit(plan.pageOrderChange, plan.renames);
      plan.beforeReplace?.();
      const reload = await replacePdfAfterStructureEdit(plan.bytes, {
        activePage: plan.activePage,
      });
      if (reload.state !== "superseded") {
        generation = reload.generation;
      }
      if (reload.state === "failed") {
        throw new Error(options.reloadFailureMessage);
      }
      if (reload.state === "committed" && !superseded()) {
        pushDocumentUndoEntry(plan.entry);
      }
      plan.afterCommit?.();
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : options.failureMessage,
        {
          tone: "danger",
        },
      );
      if (!superseded()) {
        rollbackAncillaryStateOnly(ancillaryBefore);
      }
    } finally {
      finishBusyOperation();
    }
  }

  async function handleMergePdf() {
    await runStructuralEdit({
      allowed: Boolean(mergePdfVisible && pickMergePdfFile && pages.length > 0),
      failureMessage: "Could not merge this PDF.",
      reloadFailureMessage: "Could not load the merged PDF.",
      run: async ({ bytes, superseded }) => {
        const mergeFile = await pickMergePdfFile?.();
        if (!mergeFile || superseded()) {
          return null;
        }

        const {
          bytes: nextBytes,
          insertAt,
          insertedPageCount,
          renames: mergeRenames,
        } = await mergePdfAfterPage(bytes, mergeFile.bytes, pages.length - 1);
        return {
          activePage: primaryActivePageIndex(),
          bytes: nextBytes,
          entry: documentHistoryEntry({
            type: "removePages",
            startIndex: insertAt,
            count: insertedPageCount,
          }),
          pageOrderChange: {
            atIndex: insertAt,
            count: insertedPageCount,
            type: "insert",
          },
          renames: mergeRenames,
        };
      },
    });
  }

  async function handleDeletePage(pageIndex = primaryActivePageIndex()) {
    await runStructuralEdit({
      allowed: pages.length > 1,
      failureMessage: "Could not delete this page.",
      reloadFailureMessage: "Could not reload the PDF after deleting the page.",
      run: async ({ bytes, superseded }) => {
        const extractedPage = await extractPagesBytes(bytes, pageIndex, 1);
        if (superseded()) {
          return null;
        }

        const undoEntry = documentHistoryEntry({
          type: "insertPages",
          atIndex: pageIndex,
          // The undo of a delete cannot relink, so the names travel with the
          // entry; without them the annotations come back unnamed.
          copiedNames: extractedPage.copiedNames,
          pageCount: extractedPage.pageCount,
          pagesBytes: extractedPage.bytes,
        });
        const { bytes: nextBytes, descriptionsUnproven } = await removePage(
          bytes,
          pageIndex,
        );
        return {
          activePage: Math.max(0, Math.min(pageIndex, pages.length - 2)),
          afterCommit: () => {
            if (descriptionsUnproven) {
              showNotice(UNPROVEN_PAGE_DELETE_NOTICE, {
                tone: "warning",
              });
            }
          },
          beforeReplace: () =>
            eachView((attached) => attached.setSelectedAnnotationIds([])),
          bytes: nextBytes,
          entry: undoEntry,
          pageOrderChange: {
            count: 1,
            startIndex: pageIndex,
            type: "remove",
          },
          // A delete copies nothing, so every object keeps its number.
          renames: NO_ANNOTATION_RENAMES,
        };
      },
    });
  }

  async function handleAddPage(
    pageIndex = primaryActivePageIndex(),
    position: "before" | "after" = "after",
    kind: "blank" | "lined" = "blank",
  ) {
    await runStructuralEdit({
      allowed: true,
      failureMessage: "Could not add a page.",
      reloadFailureMessage: "Could not reload the PDF after adding the page.",
      run: async ({ bytes }) => {
        const insertIndex = position === "before" ? pageIndex : pageIndex + 1;
        const undoEntry = documentHistoryEntry({
          type: "removePages",
          startIndex: insertIndex,
          count: 1,
        });
        const nextBytes =
          kind === "lined"
            ? await addLinedPageAt(bytes, insertIndex, pageIndex)
            : await addBlankPageAt(bytes, insertIndex, pageIndex);
        return {
          activePage: insertIndex,
          bytes: nextBytes,
          entry: undoEntry,
          pageOrderChange: {
            atIndex: insertIndex,
            count: 1,
            type: "insert",
          },
          // A new blank page holds nothing that was ever named.
          renames: NO_ANNOTATION_RENAMES,
        };
      },
    });
  }

  async function handleRotatePage(pageIndex = primaryActivePageIndex()) {
    await runStructuralEdit({
      allowed: pages.length > 0,
      failureMessage: "Could not rotate this page.",
      reloadFailureMessage: "Could not reload the PDF after rotating the page.",
      run: async ({ bytes }) => {
        const undoEntry = documentHistoryEntry({
          type: "rotatePage",
          pageIndex,
          deltaDegrees: -90,
        });
        const nextBytes = await rotatePageClockwise(bytes, pageIndex);
        return {
          activePage: pageIndex,
          bytes: nextBytes,
          entry: undoEntry,
          // Rotation moves no page; stated anyway so the claim stays visible.
          pageOrderChange: { type: "keep" },
          renames: NO_ANNOTATION_RENAMES,
        };
      },
    });
  }

  async function handleMovePage(
    pageIndex = primaryActivePageIndex(),
    direction: 1 | -1 = 1,
  ) {
    const targetIndex = pageIndex + direction;
    await runStructuralEdit({
      allowed:
        pageIndex >= 0 &&
        pageIndex < pages.length &&
        targetIndex >= 0 &&
        targetIndex < pages.length,
      failureMessage: "Could not move this page.",
      reloadFailureMessage: "Could not reload the PDF after moving the page.",
      run: async ({ bytes }) => {
        const undoEntry = documentHistoryEntry({
          type: "movePage",
          pageIndex,
          direction,
        });
        const nextBytes = await movePageBy(bytes, pageIndex, direction);
        return {
          activePage: targetIndex,
          bytes: nextBytes,
          entry: undoEntry,
          pageOrderChange: {
            indexA: pageIndex,
            indexB: targetIndex,
            type: "swap",
          },
          // A move re-links the same page object rather than copying it.
          renames: NO_ANNOTATION_RENAMES,
        };
      },
    });
  }

  // The saved bytes become the baseline without being re-imported, so nothing
  // else would restate the identities this session holds.
  function markCurrentWorkClean(
    cleanPdfBytes: Uint8Array,
    // Required, with no default: the omission this argument exists to prevent.
    writtenSources: WrittenAnnotationSources | null,
  ) {
    if (writtenSources && writtenSources.size > 0) {
      applyWrittenAnnotationSources(writtenSources);
    }

    const nextPdfFingerprint = byteFingerprint(cleanPdfBytes);
    pdfFingerprintRef.current = nextPdfFingerprint;
    cleanPdfBytesRef.current = cleanPdfBytes;
    cleanSignatureRefreshEnabledRef.current = true;
    cleanAnnotationsRef.current = currentPersistedAnnotations().map(
      normalizeAnnotationLayout,
    );
    const nextCleanSignature = createWorkSignature(
      nextPdfFingerprint,
      cleanAnnotationsRef.current,
    );
    setPdfBytes(cleanPdfBytes);
    setPdfFingerprint(nextPdfFingerprint);
    setCurrentCleanWorkSignature(nextCleanSignature);
  }

  // Both history stacks included, or an undo past a save brings the pre-save
  // positions back.
  function applyWrittenAnnotationSources(sources: WrittenAnnotationSources) {
    const nextAnnotations = remapAnnotationSources(
      annotationsRef.current,
      sources,
      // Only the history stacks reach past the written file's page order.
      UNCHANGED_PAGE_ORDER,
    );
    if (nextAnnotations !== annotationsRef.current) {
      annotationsRef.current = nextAnnotations;
      setAnnotationsState(nextAnnotations);
    }

    removedAnnotationSourceIdsRef.current = new Set(
      remapRemovedAnnotationSources(
        removedAnnotationSourceIdsRef.current,
        sources,
        UNCHANGED_PAGE_ORDER,
      ),
    );
    updateUndoStack((stack) => remapHistoryAnnotationSources(stack, sources));
    updateRedoStack((stack) => remapHistoryAnnotationSources(stack, sources));
  }

  function refreshCleanWorkSignatureFromImports() {
    if (!cleanSignatureRefreshEnabledRef.current) {
      return;
    }

    const nextCleanSignature = createWorkSignature(
      pdfFingerprintRef.current,
      cleanAnnotationsRef.current,
    );
    setCurrentCleanWorkSignature(nextCleanSignature);
  }

  async function handleSave() {
    if (!pdfBytes || !beginBusyOperation()) {
      return false;
    }

    // Captured before the awaits below so a document swap mid-save is detected
    // instead of stamping this save's result onto whatever is then current.
    const generation = loadGenerationRef.current;

    try {
      const saveTarget = saveTargetRef.current;

      if (saveTarget) {
        const output = await currentPdfOutput();
        const savedBytes = output.bytes;
        try {
          const saveResult = await saveTarget(savedBytes);
          if (generation === loadGenerationRef.current) {
            fileKeyRef.current = saveResult?.fileKey ?? fileKeyRef.current;
            markCurrentWorkClean(savedBytes, output.sources);
          }
          return true;
        } catch (error) {
          // Before the Save As dialog opens, so the dialog makes sense.
          showNotice(inPlaceSaveFailureNotice(error), {
            tone: "danger",
          });
          const originalFileState = originalFileStateAfterSaveFailure(error);

          const saveAsResult = await savePdfAs(
            () => Promise.resolve(output),
            fileName,
          );
          if (saveAsResult === "saved") {
            showNotice(`Saved to a new file. ${originalFileState}`, {
              tone: "warning",
            });
            return true;
          }
          if (saveAsResult === "unavailable") {
            await downloadPdfBytes(savedBytes, annotatedName(fileName));
            showNotice(`Downloaded a copy instead. ${originalFileState}`, {
              tone: "warning",
            });
          } else {
            showNotice(
              `Save cancelled. ${originalFileState} Your changes are still here.`,
              { tone: "warning" },
            );
          }
          return false;
        }
      }

      const saveAsResult = await saveCurrentPdfAs(fileName);
      if (saveAsResult === "saved") {
        return true;
      }
      if (saveAsResult === "unavailable") {
        const savedBytes = await currentPdfOutputBytes();
        await downloadPdfBytes(savedBytes, annotatedName(fileName));
        showNotice("Could not open Save As. Downloaded a copy instead.", {
          tone: "warning",
        });
      }
      return false;
    } catch (error) {
      eachView((attached) => attached.revealPreparationError(error));
      showNotice(
        preparationErrorNotice(error, "Could not prepare this PDF for saving."),
        {
          tone: "danger",
        },
      );
      return false;
    } finally {
      finishBusyOperation();
    }
  }

  // A failure is reported by the caller, so this raises no notice of its own.
  async function saveThroughHostWriter(
    write: (bytes: Uint8Array) => Promise<PdfSaveWithResult | void>,
  ) {
    if (!pdfBytes || !beginBusyOperation()) {
      return false;
    }

    const generation = loadGenerationRef.current;
    try {
      const output = await currentPdfOutput();
      const result = await write(output.bytes);
      if (generation === loadGenerationRef.current) {
        fileKeyRef.current = result?.fileKey ?? fileKeyRef.current;
        if (result?.saveTarget !== undefined) {
          saveTargetRef.current = result.saveTarget;
        }
        markCurrentWorkClean(output.bytes, output.sources);
      }
      return true;
    } finally {
      finishBusyOperation();
    }
  }

  async function saveAsDocument(suggestedName = fileName) {
    if (!pdfBytes || !beginBusyOperation()) {
      return false;
    }

    try {
      const saveAsResult = await saveCurrentPdfAs(suggestedName);
      if (saveAsResult === "saved") {
        return true;
      }
      return false;
    } catch (error) {
      eachView((attached) => attached.revealPreparationError(error));
      showNotice(
        preparationErrorNotice(error, "Could not prepare this PDF for saving."),
        {
          tone: "danger",
        },
      );
      return false;
    } finally {
      finishBusyOperation();
    }
  }

  // Not shorthand for savePdfAs(currentPdfOutput, ...): those bytes are made
  // lazily, so the annotation check runs before the user picks a destination.
  async function saveCurrentPdfAs(suggestedName = fileName) {
    validateCurrentPdfOutput();
    return savePdfAs(currentPdfOutput, suggestedName);
  }

  async function savePdfAs(
    createOutput: () => Promise<PdfOutput>,
    suggestedName = fileName,
  ) {
    const saveAsTarget = saveAsTargetRef.current;
    if (!saveAsTarget) {
      return "unavailable" as const;
    }

    // See handleSave's identical guard; the dialog resolves asynchronously.
    const generation = loadGenerationRef.current;

    // Held in a box: the host decides when, and whether, to ask for the bytes.
    const produced: { output: PdfOutput | null } = { output: null };
    const result = await saveAsTarget(async () => {
      const output = await createOutput();
      produced.output = output;
      return output.bytes;
    }, safePdfFileName(suggestedName));
    if (!result) {
      return "cancelled" as const;
    }

    if (generation !== loadGenerationRef.current) {
      return "saved" as const;
    }

    saveTargetRef.current = result.saveTarget ?? null;
    fileKeyRef.current = result.fileKey ?? fileKeyRef.current;
    if (result.fileName) {
      setFileName(result.fileName);
    }
    // A host that hands back other bytes gets no report applied to them.
    const producedOutput = produced.output;
    markCurrentWorkClean(
      result.bytes,
      producedOutput && producedOutput.bytes === result.bytes
        ? producedOutput.sources
        : null,
    );
    return "saved" as const;
  }

  // A copy is not a save and must not fail like one: a refused download is
  // retried with the unidentifiable annotations left out, and the reader told.
  async function handleDownload() {
    if (!pdfBytes || !beginBusyOperation()) {
      return;
    }

    try {
      const savedBytes = await downloadableCopyBytes();
      const outputName = annotatedName(fileName);
      await downloadPdfBytes(savedBytes, outputName);
    } catch (error) {
      eachView((attached) => attached.revealPreparationError(error));
      showNotice(
        preparationErrorNotice(error, "Could not download a copy of this PDF."),
        {
          tone: "danger",
        },
      );
    } finally {
      finishBusyOperation();
    }
  }

  async function downloadableCopyBytes() {
    try {
      return await currentPdfOutputBytes();
    } catch (error) {
      if (!(error instanceof PdfAnnotationIntegrityError) || !pdfBytes) {
        throw error;
      }

      const { annotationsForOutput, annotationsToWrite } =
        currentOutputAnnotations();
      const replacePageIndexes = annotationReplacementPageIndexes(
        managedAnnotationPagesRef.current,
        annotationsForOutput,
      );
      const replaceAnnotationSourceIds = annotationSourceIdsForReplacement(
        annotationsToWrite,
        removedAnnotationSourceIdsRef.current,
        annotationsForOutput,
        annotationsRef.current,
      );
      const unwritable = await unwritableAnnotations(
        pdfBytes,
        annotationsToWrite,
        { replaceAnnotationSourceIds, replacePageIndexes },
      );
      // What the reader would recognise as theirs, once each: adding the two
      // sets counted an edited annotation whose identity is lost twice.
      const omittedCount = unwritable.omittedAnnotationCount;
      if (omittedCount === 0) {
        // Not one annotation's identity, so there is no smaller copy to offer.
        throw error;
      }

      const bytes = await writePdfAnnotations(
        pdfBytes,
        annotationsToWrite.filter(
          (annotation) => !unwritable.annotationIds.has(annotation.id),
        ),
        {
          onMalformedExistingAnnotations: reportMalformedAnnotations,
          replaceAnnotationSourceIds: Array.from(
            replaceAnnotationSourceIds,
          ).filter((sourceId) => !unwritable.removalSourceIds.has(sourceId)),
          replacePageIndexes,
        },
      );
      showNotice(
        `${omittedCount} annotation${omittedCount === 1 ? "" : "s"} could not be identified in this PDF. The copy holds ${omittedCount === 1 ? "it" : "them"} as the file already had ${omittedCount === 1 ? "it" : "them"}; everything else is in it. Your file has not been changed.`,
        { tone: "danger" },
      );
      return bytes;
    }
  }

  async function currentPdfOutput(): Promise<PdfOutput> {
    if (!pdfBytes) {
      throw new Error("No PDF is open.");
    }

    const outputAnnotations = validateCurrentPdfOutput();

    if (hasCurrentUnsavedChanges()) {
      return annotatedPdfOutput(outputAnnotations);
    }

    return { bytes: cleanPdfBytesRef.current ?? pdfBytes, sources: null };
  }

  async function currentPdfOutputBytes() {
    return (await currentPdfOutput()).bytes;
  }

  function currentPersistedAnnotations() {
    return annotationsRef.current.filter(hasAnnotationContent);
  }

  function hasCurrentUnsavedChanges() {
    const currentSignature = createWorkSignature(
      pdfFingerprintRef.current,
      currentPersistedAnnotations(),
    );

    return (
      Boolean(pdfBytes) &&
      cleanWorkSignatureRef.current.length > 0 &&
      currentSignature !== cleanWorkSignatureRef.current
    );
  }

  async function downloadPdfBytes(bytes: Uint8Array, suggestedName: string) {
    const target = downloadTargetRef.current;
    if (target) {
      await target(bytes, safePdfFileName(suggestedName));
      return;
    }

    downloadPdf(bytes, suggestedName);
  }

  function currentOutputAnnotations() {
    const annotationsForOutput = currentPersistedAnnotations();
    return {
      annotationsForOutput,
      annotationsToWrite: writableAnnotations(
        annotationsForOutput,
        cleanAnnotationsRef.current,
      ),
    };
  }

  function validateCurrentPdfOutput() {
    const outputAnnotations = currentOutputAnnotations();
    assertAnnotationsTextIsSupported(outputAnnotations.annotationsToWrite);
    return outputAnnotations;
  }

  async function annotatedPdfOutput(
    outputAnnotations = currentOutputAnnotations(),
  ): Promise<PdfOutput> {
    if (!pdfBytes) {
      throw new Error("No PDF is open.");
    }

    const { annotationsForOutput, annotationsToWrite } = outputAnnotations;
    const replacePageIndexes = annotationReplacementPageIndexes(
      managedAnnotationPagesRef.current,
      annotationsForOutput,
    );
    const replaceAnnotationSourceIds = annotationSourceIdsForReplacement(
      annotationsToWrite,
      removedAnnotationSourceIdsRef.current,
      annotationsForOutput,
      annotationsRef.current,
    );

    if (
      annotationsToWrite.length === 0 &&
      replaceAnnotationSourceIds.size === 0
    ) {
      return { bytes: pdfBytes, sources: null };
    }

    return writeAnnotatedPdf(pdfBytes, annotationsToWrite, {
      replaceAnnotationSourceIds,
      replacePageIndexes,
      onMalformedExistingAnnotations: reportMalformedAnnotations,
    });
  }

  async function printablePdfBytes() {
    if (!pdfBytes) {
      throw new Error("No PDF is open.");
    }

    return showAnnotations
      ? currentPdfOutputBytes()
      : writePdfAnnotations(pdfBytes, [], {
          removeAllAnnotations: true,
        });
  }
  function handleEnableEditing() {
    if (!canEditReadOnlyCopy(readOnlyReason)) {
      return;
    }

    saveTargetRef.current = null;
    // This tab now holds an in-memory copy, no longer tied to a file on disk,
    // so the already-open-tab dedup must stop treating it as that file.
    fileKeyRef.current = null;
    setEditingEnabled(true);
    setFileName((current) => copyName(current));
    onToolChange?.("select");
    clearViewSelections();
  }

  function retryLoad() {
    setSourceRetryKey((value) => value + 1);
  }

  return {
    annotations,
    annotationsByPage,
    annotationsComplete,
    busy,
    documentVersion,
    editingEnabled,
    fileName,
    hasUnsavedChanges,
    loadError,
    outline,
    pageCount: pages.length,
    pageSize,
    // Shared by every attached view, because pdf.js's page proxies are.
    pages,
    passwordRequest,
    pdfBytes,
    pdfDoc,
    readOnly,
    readOnlyReason,
    redoStack,
    undoStack,

    downloadAvailable,
    imageAnnotationsVisible,
    pickImageFile,
    mergePdfVisible,
    printAvailable,
    saveAsAvailable,
    saveAvailable,

    // Refs rather than values because a pointer gesture reads them between
    // renders.
    annotationsRef,
    busyRef,
    liveAnnotationEditRef,
    loadGenerationRef,
    managedAnnotationPagesRef,
    pagesRef,
    pdfBytesRef,
    pdfDocRef,
    removedAnnotationSourceIdsRef,

    // Registers a viewport with this document; returns its detach.
    attachView,
    beginAnnotationEdit,
    beginBusyOperation,
    commitAnnotations,
    createDocumentEditorSession,
    ensurePageLoaded,
    finishAnnotationEdit,
    finishBusyOperation,
    handleAddPage,
    handleClosePdf,
    handleDeletePage,
    handleDownload,
    handleEnableEditing,
    handleMergePdf,
    handleMovePage,
    handlePasswordUnlock,
    handlePrint,
    handleRotatePage,
    handleSave,
    handleThumbnailPageLoad,
    importAllAnnotations,
    redoHistory,
    releaseRenderResources,
    retryLoad,
    saveAsDocument,
    saveThroughHostWriter,
    showNotice,
    undoHistory,
  };
}
