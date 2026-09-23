import {
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEventCallback } from "../useEventCallback";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  withAnnotationBookmark,
  withAnnotationComment,
} from "./annotationComments";
import type { PdfOutlineEntry } from "./pdfOutline";
import {
  hasAnnotationContent,
  normalizeAnnotationLayout,
} from "./annotationState";
import { annotationBounds, moveAnnotation } from "./annotationGeometry";
import {
  ANNOTATION_CLIPBOARD_TYPE,
  hasAnnotationClipboard,
  readAnnotationPaste,
  writeAnnotationClipboard,
} from "./annotationClipboard";
import { PdfPageView } from "./PdfPageView";
import {
  assertAnnotationsTextIsSupported,
  UnsupportedAnnotationTextError,
} from "./pdfWriter";
import { pdfRectToViewportRect, viewportPointToPdfPoint } from "./pdfGeometry";
import {
  prepareImageStampFromClipboardItems,
  prepareImageStampFromFile,
  prepareImageStampFromSystemClipboard,
} from "./imageImport";
import type { PreparedImageStamp } from "./imageImport";
import type { PdfDocumentEditorReadOnlyReason } from "./pdfProtection";
import type {
  PdfDocumentEditorCapabilities,
  PdfSaveWithResult,
  PdfDocumentEditorSource,
} from "./host";
import { defaultToolSettings } from "./toolSettings";
import { useSplitResizer, type SplitAxis } from "./useSplitResizer";
import type { PdfDocumentEditorNoticeReporter } from "./notices";
import type {
  LoadedPage,
  PageViewport,
  PageSize,
  PdfAnnotation,
  PdfRect,
  PdfPoint,
  Tool,
  ToolSettings,
  VisiblePageRange,
} from "./types";
import {
  DOCUMENT_EDITOR_ROOT_CLASS,
  SPLIT_VIEW_CLASS,
  clamp,
  LAZY_PAGE_BUFFER,
  SELECTION_BUTTON_SIZE,
  ZOOM_STEP,
} from "./viewerConfig";
import {
  pageElementForIndex,
  pageTopInContainer,
  scrollContainerPaddingTop,
} from "./scrollGeometry";
import { usePdfDocumentEditorZoom } from "./usePdfDocumentEditorZoom";
import {
  attachGestureRoot,
  markGestureRootTouched,
  viewOwnsWindowGesture,
} from "./viewGestureOwnership";
import { useDocumentModel } from "./useDocumentModel";
import type {
  PdfDocumentEditorCloseRequest,
  PdfDocumentEditorModel,
  PdfDocumentEditorViewBridge,
  SensitivePdfDocumentEditorSession,
} from "./useDocumentModel";
import type {
  PdfDocumentEditorViewPosition,
  PdfDocumentEditorViewSnapshot,
} from "./viewSnapshot";
import { PdfPagePlaceholder } from "./components/PdfPagePlaceholder";
import {
  annotationIntersectsPage,
  destinationTargetToPageIndex,
  isTextEntryTarget,
  isZoomInShortcut,
  isZoomShortcut,
  measureScrollbarGutter,
  pageIndexFromElement,
  pagePdfBounds,
  pageRenderPriority,
  scheduleAfterVisiblePaint,
  usesAnnotationLayer,
  visibleLoadPageIndexes,
} from "./pdfDocumentEditorHelpers";

// One view of a document useDocumentModel owns: every field this file declares
// is one a second viewport over the same document would need its own copy of.
const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const DEFAULT_FULLSCREEN_CLASS = "document-shell--fullscreen";

// Re-exported here because this file is what src/pdfdocumenteditor/index.ts names.
export type {
  PdfDocumentEditorCloseRequest,
  PdfDocumentEditorModel,
  PdfDocumentEditorHistorySnapshot,
  PdfDocumentEditorHistoryEntry,
  SensitivePdfDocumentEditorSession,
} from "./useDocumentModel";
export type {
  PdfDocumentEditorViewPosition,
  PdfDocumentEditorViewSnapshot,
} from "./viewSnapshot";

export type PdfDocumentEditorReadOnlyState = {
  readOnly: boolean;
  /** Null when the file itself is fine and the host simply asked for read-only. */
  reason: PdfDocumentEditorReadOnlyReason | null;
  ready: boolean;
};

// There is deliberately no way to put a button into the core; the `children`
// slot on PdfDocumentEditorProps is the one exception.
export type PdfDocumentEditorHandle = {
  // A sensitive in-memory session: hosts keep it short-lived and private.
  captureSessionForTabCache: () => SensitivePdfDocumentEditorSession | null;
  downloadCopy: () => Promise<void>;
  print: () => Promise<void>;
  releaseRenderResources: () => Promise<void>;
  requestClose: () => Promise<void>;
  save: () => Promise<boolean>;
  saveAs: (suggestedName?: string) => Promise<boolean>;
  // Saves through a host-supplied writer instead of this document's own target.
  saveWith: (
    write: (bytes: Uint8Array) => Promise<PdfSaveWithResult | void>,
  ) => Promise<boolean>;

  // Page surgery: these rewrite the document and its annotation and undo state
  // together.
  appendDocument: () => Promise<void>;
  deletePage: (pageIndex?: number) => Promise<void>;
  insertPage: (
    pageIndex?: number,
    position?: "before" | "after",
    kind?: "blank" | "lined",
  ) => Promise<void>;
  reorderPages: (pageIndex: number, direction: 1 | -1) => Promise<void>;
  rotatePage: (pageIndex?: number) => Promise<void>;

  // The bookmark is a flag on an existing annotation, not a kind of its own.
  addImageFromPicker: () => Promise<void>;
  addImageFromSystemClipboard: () => Promise<void>;
  clearAnnotationSelection: () => void;
  finishAnnotationEdit: () => void;
  // Reads every page's annotations without loading those pages into the
  // viewport, leaving the lazy window and its eviction untouched.
  importAllAnnotations: () => Promise<void>;
  revealAnnotation: (annotationId: string) => void;
  setAnnotationBookmarked: (annotationId: string, bookmarked: boolean) => void;
  setAnnotationComment: (annotationId: string, comment: string) => void;

  redo: () => Promise<void>;
  undo: () => Promise<void>;

  // `remeasureViewport` is how host chrome whose geometry changed asks for the
  // gutters to be measured again.
  ensurePageLoaded: (page: PDFPageProxy, pageIndex: number) => void;
  fitHeight: () => void;
  fitWidth: () => void;
  // `destination` is opaque on purpose: a host passes back what it was handed.
  goToDestination: (destination: unknown) => Promise<void>;
  goToPage: (pageIndex: number) => void;
  remeasureViewport: () => void;
  resetZoom: () => void;
  setZoom: (scale: number) => void;
  zoomBy: (delta: number) => void;

  enableEditing: () => void;
  retryLoad: () => void;
  submitPassword: (password: string) => void;
};

// Handed to the overlay slot on every render; a host never reaches inside.
export type PdfDocumentEditorViewState = {
  activePageIndex: number;
  annotationsByPage: Map<number, PdfAnnotation[]>;
  // False until the host calls `importAllAnnotations`, and a page the pass
  // could not read raises a notice rather than holding it false for ever.
  annotationsComplete: boolean;
  busy: boolean;
  canRedo: boolean;
  canUndo: boolean;
  downloadAvailable: boolean;
  editingEnabled: boolean;
  fileName: string;
  hasUnsavedChanges: boolean;
  imageAnnotationsAvailable: boolean;
  loadError: string | null;
  mergeAvailable: boolean;
  // Empty for the many PDFs that carry no outline.
  outline: PdfOutlineEntry[];
  pageSize: PageSize | null;
  pages: LoadedPage[];
  passwordRequired: boolean;
  passwordRetry: boolean;
  pdfDoc: PDFDocumentProxy | null;
  printAvailable: boolean;
  ready: boolean;
  readOnly: boolean;
  readOnlyReason: PdfDocumentEditorReadOnlyReason | null;
  saveAsAvailable: boolean;
  saveAvailable: boolean;
  scale: number;
  selectedAnnotationIds: string[];
};

// A host mounting two views over one document passes these twice and the
// document options once.
export type PdfDocumentEditorViewportProps = {
  // The one place a host may put its own UI inside the core, for chrome that
  // needs viewport coordinates.
  children?: (view: PdfDocumentEditorViewState) => ReactNode;
  className?: string;
  // Several viewports may name one document: they share its annotations,
  // history and bytes, and keep their own scroll position, zoom and selection.
  document: PdfDocumentEditorModel;
  // Absent, `document.title` is left alone until a document is loaded.
  emptyTitle?: string;
  // Exactly one viewport answers each window-level gesture, or two views both
  // zoom on one wheel tick.
  enableGlobalShortcuts?: boolean;
  enableWheelZoom?: boolean;
  manageDocumentTitle?: boolean;
  onDocumentTitleChange?: (title: string) => void;
  // The host confirms and opens it; see safePdfExternalUrl.
  onExternalLinkRequest?: (url: string) => void;
  // Reported as well as exposed on the view state: the host draws this
  // outside the overlay slot.
  onReadOnlyChange?: (state: PdfDocumentEditorReadOnlyState) => void;
  onShowAnnotationsChange?: (showAnnotations: boolean) => void;
  /** The core asking for a different tool - after placing text, on Escape. */
  onToolChange?: (tool: Tool) => void;
  showAnnotations?: boolean;
  style?: CSSProperties;
  tool?: Tool;
  toolSettings?: ToolSettings;
};

// What a document needs to exist, independently of who is looking at it.
export type PdfDocumentEditorSharedProps = PdfDocumentEditorCapabilities & {
  allowEditing?: boolean;
  allowImageAnnotations?: boolean;
  confirmDiscardChanges?: (
    request: PdfDocumentEditorCloseRequest,
  ) => boolean | Promise<boolean>;
  emptyTitle?: string;
  initialSession?: SensitivePdfDocumentEditorSession | null;
  manageDocumentTitle?: boolean;
  onClose: () => void;
  onDirtyChange?: (hasUnsavedChanges: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  // Followed by onSessionRestore when a cached session is being put back.
  onDocumentReset?: () => void;
  // New bytes are mounted: after a load, a page operation, or an undo of one.
  onDocumentReplaced?: () => void;
  /** Pre-existing annotations in the file that could not be displayed. */
  onMalformedAnnotations?: (count: number) => void;
  // Required, not optional: the core draws no banner of its own, so a host
  // that forgets this swallows every failure the save path raises.
  onNotice: PdfDocumentEditorNoticeReporter;
  // Fires after onDocumentReset, so a host can re-apply its own parked chrome
  // state without being reset afterwards.
  onSessionRestore?: () => void;
  onShowAnnotationsChange?: (showAnnotations: boolean) => void;
  /** The core asking for a different tool - after placing text, on Escape. */
  onToolChange?: (tool: Tool) => void;
  showAnnotations?: boolean;
  source: PdfDocumentEditorSource;
};

// Two views over one document is usePdfDocumentEditor plus two
// PdfDocumentEditorViewports; `secondView` below is that pairing done here.
export type PdfDocumentEditorProps = PdfDocumentEditorSharedProps &
  Omit<PdfDocumentEditorViewportProps, "document"> & {
    // Two views, never two copies: one document holds the bytes, annotations
    // and history.
    secondView?: boolean;
    splitDirection?: SplitAxis;
    // Uncontrolled by default (the divider keeps its own ratio), but a host
    // that lays out chrome alongside this split - a tab bar sharing the row
    // above it, say - can pass both to keep that chrome in step with drags.
    splitRatio?: number;
    onSplitRatioChange?: Dispatch<SetStateAction<number>>;
  };

export const PdfDocumentEditorViewport = forwardRef<
  PdfDocumentEditorHandle,
  PdfDocumentEditorViewportProps
>(function PdfDocumentEditorViewport(
  {
    children,
    className = DEFAULT_FULLSCREEN_CLASS,
    document: documentModel,
    emptyTitle,
    enableGlobalShortcuts = true,
    enableWheelZoom = true,
    manageDocumentTitle = true,
    onDocumentTitleChange,
    onExternalLinkRequest,
    onReadOnlyChange,
    onShowAnnotationsChange,
    onToolChange,
    showAnnotations = true,
    style,
    tool = "select",
    toolSettings = defaultToolSettings,
  },
  ref,
) {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const documentEditorRootRef = useRef<HTMLDivElement | null>(null);
  const pagesLayerRef = useRef<HTMLDivElement | null>(null);
  const activePageIndexRef = useRef(0);
  // Measured off this view's own scroll box every scroll frame and handed to
  // page residency; see `attachView`.
  const visiblePageRangeRef = useRef<VisiblePageRange>({ end: 0, start: 0 });
  // The same measurement as a render input, since a ref re-renders nothing.
  const [visiblePageRange, setVisiblePageRange] = useState<VisiblePageRange>({
    end: 0,
    start: 0,
  });
  const initialVisualPageIndexRef = useRef(0);
  const initialBaseLayerReadyRef = useRef(false);
  const initialAnnotationsReadyRef = useRef(false);
  const initialVisualReadyRef = useRef(false);
  const afterInitialVisualReadyRef = useRef<Array<() => void>>([]);
  const [initialVisualReady, setInitialVisualReady] = useState(false);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>(
    [],
  );
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(
    null,
  );
  // The core cannot see the host's geometry, so the host says when it moved.
  const [chromeGeometryVersion, setChromeGeometryVersion] = useState(0);
  // A ref, not a plain argument: usePdfDocumentEditorZoom below is built from the
  // model's output, so passing its setScale in directly would be a cycle.
  const viewBridge: PdfDocumentEditorViewBridge = {
    activePageIndex,
    activePageIndexRef,
    captureViewSnapshot,
    clearInitialVisualReadiness,
    markInitialAnnotationsReady,
    resetInitialVisualReadiness,
    restoreViewPosition: restoreCapturedViewPosition,
    revealPreparationError: handlePreparationError,
    runAfterInitialVisualReady,
    setActivePageIndex,
    setFocusedAnnotationId,
    setScale: setViewScale,
    setSelectedAnnotationIds,
    visiblePageRangeRef,
  };
  const viewBridgeRef = useRef(viewBridge);
  viewBridgeRef.current = viewBridge;
  const {
    annotationsByPage,
    annotationsComplete,
    annotationsRef,
    attachView,
    beginAnnotationEdit,
    beginBusyOperation,
    busy,
    busyRef,
    commitAnnotations,
    createDocumentEditorSession,
    documentVersion,
    downloadAvailable,
    editingEnabled,
    ensurePageLoaded,
    fileName,
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
    hasUnsavedChanges,
    imageAnnotationsVisible,
    importAllAnnotations,
    liveAnnotationEditRef,
    loadError,
    loadGenerationRef,
    pdfDocRef,
    managedAnnotationPagesRef,
    mergePdfVisible,
    outline,
    pageCount,
    pageSize,
    pickImageFile,
    pages,
    pagesRef,
    passwordRequest,
    pdfDoc,
    printAvailable,
    readOnly,
    readOnlyReason,
    redoHistory,
    redoStack,
    releaseRenderResources,
    removedAnnotationSourceIdsRef,
    retryLoad,
    saveAsAvailable,
    saveAsDocument,
    saveAvailable,
    saveThroughHostWriter,
    showNotice,
    undoHistory,
    undoStack,
  } = documentModel;
  // A layout effect on purpose: React runs a child's before its parent's, so
  // the viewport is attached before the document's load effect and cannot miss
  // the first reset.
  useLayoutEffect(() => attachView(viewBridgeRef), [attachView]);
  // Window-level, because these must work before the reader has clicked into
  // the page.
  useLayoutEffect(() => {
    const root = documentEditorRootRef.current;
    return root ? attachGestureRoot(root) : undefined;
  }, []);
  const {
    scale,
    setScale,
    updateZoom,
    resetZoom,
    setZoom,
    fitZoomToPageWidth,
    fitZoomToPageHeight,
  } = usePdfDocumentEditorZoom({
    scrollContainerRef,
    pagesRef,
    pages,
    pageSize,
    activePageIndex,
  });
  const handleExternalLinkRequest = useCallback(
    (url: string) => {
      onExternalLinkRequest?.(url);
    },
    [onExternalLinkRequest],
  );
  const [scrollbarGutterBlock, setScrollbarGutterBlock] = useState(0);
  const [scrollbarGutterInline, setScrollbarGutterInline] = useState(0);
  const documentTitle =
    pageCount > 0
      ? `${hasUnsavedChanges ? "*" : ""}${fileName}`
      : (emptyTitle ?? "");
  const rootStyle = useMemo(
    () =>
      ({
        ...style,
        "--app-scrollbar-block": `${scrollbarGutterBlock}px`,
        "--app-scrollbar-inline": `${scrollbarGutterInline}px`,
        "--app-selection-button-size": `${SELECTION_BUTTON_SIZE}px`,
      }) as CSSProperties,
    [scrollbarGutterBlock, scrollbarGutterInline, style],
  );
  activePageIndexRef.current = activePageIndex;
  const handleClipboardPasteEvent = useEventCallback(handleClipboardPaste);
  const handleGlobalKeyDownEvent = useEventCallback(handleGlobalKeyDown);
  const handleWheelEvent = useEventCallback(handleWheel);
  const ensurePageLoadedEvent = useEventCallback(ensurePageLoaded);
  // Reads `visiblePageRangeRef` rather than deriving a second band from the
  // active page; see CLAUDE.md Learnings.
  function loadVisiblePageBand() {
    if (
      !initialVisualReadyRef.current ||
      !pdfDocRef.current ||
      pageCount === 0
    ) {
      return;
    }

    for (const pageIndex of visibleLoadPageIndexes(
      visiblePageRangeRef.current,
      pageCount,
    )) {
      void ensurePageLoadedEvent(pageIndex);
    }
  }
  const loadVisiblePageBandEvent = useEventCallback(loadVisiblePageBand);
  const handlePageReady = useCallback((pageIndex: number) => {
    if (pageIndex === initialVisualPageIndexRef.current) {
      initialBaseLayerReadyRef.current = true;
      revealInitialVisualIfReady();
    }
  }, []);

  function resetInitialVisualReadiness(pageIndex = 0) {
    initialVisualPageIndexRef.current = pageIndex;
    initialBaseLayerReadyRef.current = false;
    initialAnnotationsReadyRef.current = false;
    initialVisualReadyRef.current = false;
    afterInitialVisualReadyRef.current = [];
    setInitialVisualReady(false);
  }

  function markInitialAnnotationsReady(pageIndex: number, generation: number) {
    if (
      generation !== loadGenerationRef.current ||
      pageIndex !== initialVisualPageIndexRef.current
    ) {
      return;
    }

    initialAnnotationsReadyRef.current = true;
    revealInitialVisualIfReady();
  }

  function revealInitialVisualIfReady() {
    if (
      initialVisualReadyRef.current ||
      !initialBaseLayerReadyRef.current ||
      !initialAnnotationsReadyRef.current
    ) {
      return;
    }

    initialVisualReadyRef.current = true;
    setInitialVisualReady(true);
    const queuedCallbacks = afterInitialVisualReadyRef.current.splice(0);
    for (const callback of queuedCallbacks) {
      scheduleAfterVisiblePaint(callback);
    }
  }

  function runAfterInitialVisualReady(callback: () => void) {
    if (initialVisualReadyRef.current) {
      scheduleAfterVisiblePaint(callback);
      return;
    }

    afterInitialVisualReadyRef.current.push(callback);
  }

  // A function declaration, so the view bridge above can name it before
  // usePdfDocumentEditorZoom has run.
  function setViewScale(nextScale: number) {
    setScale(nextScale);
  }

  // Unlike resetInitialVisualReadiness, this leaves initialVisualPageIndexRef
  // alone.
  function clearInitialVisualReadiness(commitState: boolean) {
    afterInitialVisualReadyRef.current = [];
    initialBaseLayerReadyRef.current = false;
    initialAnnotationsReadyRef.current = false;
    initialVisualReadyRef.current = false;
    if (commitState) {
      setInitialVisualReady(false);
    }
  }

  // Both the position's page index and `activePageIndex` are recorded, so a
  // restore that cannot find the page element still knows which page to open.
  function captureViewSnapshot(): PdfDocumentEditorViewSnapshot {
    return {
      activePageIndex: activePageIndexRef.current,
      scale,
      viewPosition: captureViewPosition(),
    };
  }

  function captureViewPosition(): PdfDocumentEditorViewPosition {
    const container = scrollContainerRef.current;
    const pageIndex = activePageIndexRef.current;
    const fallback = {
      offsetRatio: 0,
      pageIndex,
      scrollLeftRatio: 0,
    };
    if (!container) {
      return fallback;
    }

    const pageElement = pageElementForIndex(container, pageIndex);
    if (!pageElement) {
      return fallback;
    }

    const pageTop = pageTopInContainer(container, pageElement);
    const paddingTop = scrollContainerPaddingTop(container);
    const maxScrollLeft = Math.max(
      0,
      container.scrollWidth - container.clientWidth,
    );

    return {
      offsetRatio: clamp(
        (container.scrollTop + paddingTop - pageTop) /
          Math.max(1, pageElement.offsetHeight),
        0,
        1,
      ),
      pageIndex,
      scrollLeftRatio:
        maxScrollLeft > 0
          ? clamp(container.scrollLeft / maxScrollLeft, 0, 1)
          : 0,
    };
  }

  useImperativeHandle(ref, () => ({
    addImageFromPicker: handlePickImageFile,
    addImageFromSystemClipboard: handlePasteImageFromSystemClipboard,
    appendDocument: handleMergePdf,
    captureSessionForTabCache: createDocumentEditorSession,
    clearAnnotationSelection,
    deletePage: handleDeletePage,
    downloadCopy: handleDownload,
    enableEditing: handleEnableEditing,
    ensurePageLoaded: handleThumbnailPageLoad,
    finishAnnotationEdit: finishCurrentAnnotationEditWithValidation,
    fitHeight: fitZoomToPageHeight,
    fitWidth: fitZoomToPageWidth,
    goToDestination: handlePdfDestination,
    importAllAnnotations,
    goToPage: (pageIndex: number) => {
      void navigateToPage(pageIndex, { block: "start" });
    },
    insertPage: handleAddPage,
    print: handlePrint,
    redo: redoHistory,
    releaseRenderResources,
    remeasureViewport: () => setChromeGeometryVersion((value) => value + 1),
    reorderPages: handleMovePage,
    requestClose: handleClosePdf,
    resetZoom,
    retryLoad,
    revealAnnotation,
    rotatePage: handleRotatePage,
    save: handleSave,
    saveAs: saveAsDocument,
    saveWith: saveThroughHostWriter,
    setAnnotationBookmarked,
    setAnnotationComment,
    setZoom,
    submitPassword: handlePasswordUnlock,
    undo: undoHistory,
    zoomBy: updateZoom,
  }));

  useEffect(() => {
    onReadOnlyChange?.({
      readOnly,
      ready: initialVisualReady,
      reason: readOnlyReason,
    });
  }, [initialVisualReady, onReadOnlyChange, readOnly, readOnlyReason]);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (
        readOnly ||
        busyRef.current ||
        !initialVisualReadyRef.current ||
        !viewOwnsWindowGesture(documentEditorRootRef.current, event.target) ||
        isTextEntryTarget(event.target)
      ) {
        return;
      }

      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        return;
      }

      const hasSupportedImage = Array.from(clipboardData.items).some(
        (item) =>
          item.kind === "file" &&
          ["image/png", "image/jpeg", "image/webp"].includes(item.type),
      );
      const text = clipboardData.getData("text/plain");
      if (
        !hasAnnotationClipboard(
          clipboardData.getData(ANNOTATION_CLIPBOARD_TYPE),
        ) &&
        !hasSupportedImage &&
        text.trim().length === 0
      ) {
        return;
      }

      event.preventDefault();
      void handleClipboardPasteEvent(clipboardData);
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
    // busyRef comes off the document model, so it is listed; it is the same
    // stable object every render.
  }, [busyRef, handleClipboardPasteEvent, imageAnnotationsVisible, readOnly]);

  useEffect(() => {
    function handleCopy(event: ClipboardEvent) {
      if (
        !viewOwnsWindowGesture(documentEditorRootRef.current, event.target) ||
        isTextEntryTarget(event.target)
      ) {
        return;
      }

      // Writes only its own type, so this and PdfPageView never contend for
      // `text/plain` and neither depends on which listener runs first.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        return;
      }

      const selectedIds = new Set(selectedAnnotationIds);
      const copied = annotationsRef.current.filter((annotation) =>
        selectedIds.has(annotation.id),
      );
      if (copied.length === 0) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData(
        ANNOTATION_CLIPBOARD_TYPE,
        writeAnnotationClipboard(copied),
      );
    }

    window.addEventListener("copy", handleCopy);
    return () => window.removeEventListener("copy", handleCopy);
  }, [annotationsRef, selectedAnnotationIds]);

  useEffect(() => {
    if (pageCount > 0) {
      onDocumentTitleChange?.(documentTitle);
    }

    // Blanking the tab title would be worse than leaving what it says.
    if (manageDocumentTitle && documentTitle) {
      document.title = documentTitle;
    }
  }, [manageDocumentTitle, onDocumentTitleChange, pageCount, documentTitle]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !initialVisualReady) {
      setScrollbarGutterInline(0);
      return;
    }

    // Measured once rather than reactively, so a recalculation cannot remap an
    // in-progress scrollbar thumb drag.
    const updateInline = () => {
      setScrollbarGutterInline((current) => {
        const next = measureScrollbarGutter(container).inline;
        return current === next ? current : next;
      });
    };
    updateInline();
    window.addEventListener("resize", updateInline);
    return () => window.removeEventListener("resize", updateInline);
  }, [initialVisualReady]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !initialVisualReady) {
      setScrollbarGutterBlock(0);
      return;
    }

    let frame = 0;
    const updateScrollbarGutter = () => {
      frame = 0;
      setScrollbarGutterBlock((current) => {
        const next = measureScrollbarGutter(container).block;
        return current === next ? current : next;
      });
    };
    const scheduleUpdate = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(updateScrollbarGutter);
    };

    scheduleUpdate();
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(container);
    if (pagesLayerRef.current) {
      observer.observe(pagesLayerRef.current);
    }
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [chromeGeometryVersion, initialVisualReady, pageSize, pageCount, scale]);

  useEffect(() => {
    if (!enableGlobalShortcuts) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      // One viewport answers a window-level shortcut, or two views undo the
      // same edit twice on one Ctrl+Z.
      if (!viewOwnsWindowGesture(documentEditorRootRef.current, event.target)) {
        return;
      }

      handleGlobalKeyDownEvent(event);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enableGlobalShortcuts, handleGlobalKeyDownEvent]);

  useEffect(() => {
    if (!enableWheelZoom) {
      return;
    }

    function handleWheel(event: WheelEvent) {
      if (!viewOwnsWindowGesture(documentEditorRootRef.current, event.target)) {
        return;
      }

      handleWheelEvent(event);
    }

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [enableWheelZoom, handleWheelEvent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    let frame = 0;
    const findBestVisiblePage = (elements: Iterable<HTMLElement>) => {
      const containerRect = container.getBoundingClientRect();
      let bestPage = -1;
      let bestArea = 0;

      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        const visibleWidth = Math.max(
          0,
          Math.min(rect.right, containerRect.right) -
            Math.max(rect.left, containerRect.left),
        );
        const visibleHeight = Math.max(
          0,
          Math.min(rect.bottom, containerRect.bottom) -
            Math.max(rect.top, containerRect.top),
        );
        const area = visibleWidth * visibleHeight;

        if (area > bestArea) {
          bestArea = area;
          bestPage = Number(element.dataset.pageIndex);
        }
      }

      return bestPage;
    };

    // The real extent, first and last inclusive, not the active page and a
    // buffer; see CLAUDE.md Learnings.
    const measureVisiblePageRange = (
      anchorPageIndex: number,
    ): VisiblePageRange => {
      const lastPageIndex = pageCount - 1;
      if (lastPageIndex < 0) {
        return { end: 0, start: 0 };
      }

      const anchor = Math.min(Math.max(anchorPageIndex, 0), lastPageIndex);
      const containerRect = container.getBoundingClientRect();
      const showing = (pageIndex: number) => {
        const slot = container.querySelector<HTMLElement>(
          `.pdfdocumenteditor-page-slot[data-page-index="${pageIndex}"]`,
        );
        if (!slot) {
          return false;
        }

        const rect = slot.getBoundingClientRect();
        return (
          rect.bottom > containerRect.top &&
          rect.top < containerRect.bottom &&
          rect.right > containerRect.left &&
          rect.left < containerRect.right
        );
      };

      let start = anchor;
      while (start > 0 && showing(start - 1)) {
        start -= 1;
      }

      let end = anchor;
      while (end < lastPageIndex && showing(end + 1)) {
        end += 1;
      }

      return { end, start };
    };

    const updateActivePage = () => {
      // A small window keeps this handler's layout work constant regardless of
      // document length.
      const searchRadius = LAZY_PAGE_BUFFER + 2;
      const start = Math.max(0, activePageIndexRef.current - searchRadius);
      const end = Math.min(
        pageCount - 1,
        activePageIndexRef.current + searchRadius,
      );
      const windowSelector = Array.from(
        { length: Math.max(0, end - start + 1) },
        (_, offset) => `[data-page-index="${start + offset}"]`,
      ).join(",");

      let bestPage = windowSelector
        ? findBestVisiblePage(
            container.querySelectorAll<HTMLElement>(windowSelector),
          )
        : -1;

      // A match at the window's edge means the best page could lie beyond it,
      // so re-check against every page.
      const windowMissedEdge =
        (bestPage === start && start > 0) ||
        (bestPage === end && end < pageCount - 1);
      if (bestPage < 0 || windowMissedEdge) {
        const fullScanBest = findBestVisiblePage(
          container.querySelectorAll<HTMLElement>("[data-page-index]"),
        );
        if (fullScanBest >= 0) {
          bestPage = fullScanBest;
        }
      }

      if (bestPage >= 0) {
        setActivePageIndex((current) => {
          if (current === bestPage) {
            return current;
          }

          activePageIndexRef.current = bestPage;
          return bestPage;
        });
      }

      // Page residency, the load band and the render ranking all read this one
      // measurement; see CLAUDE.md Learnings.
      const measured = measureVisiblePageRange(
        bestPage >= 0 ? bestPage : activePageIndexRef.current,
      );
      const moved =
        measured.start !== visiblePageRangeRef.current.start ||
        measured.end !== visiblePageRangeRef.current.end;
      visiblePageRangeRef.current = measured;
      if (moved) {
        setVisiblePageRange(measured);
        loadVisiblePageBandEvent();
      }
    };

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateActivePage);
    };

    scheduleUpdate();
    container.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    // The page column changing shape moves what is on screen and fires no
    // scroll event.
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(container);
    if (pagesLayerRef.current) {
      observer.observe(pagesLayerRef.current);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      observer.disconnect();
    };
  }, [loadVisiblePageBandEvent, pageCount, scale]);

  // Keyed on `documentVersion`: without the swap counter, a reload that leaves
  // the page count and the active page alone never re-primes the band.
  useEffect(() => {
    loadVisiblePageBandEvent();
  }, [
    activePageIndex,
    documentVersion,
    initialVisualReady,
    loadVisiblePageBandEvent,
    pageCount,
    scale,
  ]);

  function handleGlobalKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const isEditingText =
      target?.tagName === "TEXTAREA" ||
      target?.tagName === "INPUT" ||
      target?.isContentEditable;

    if (event.key === "Escape") {
      event.preventDefault();
      const keepSelection = finishCurrentAnnotationEditWithValidation();
      onToolChange?.("select");
      if (!keepSelection) {
        setSelectedAnnotationIds([]);
      }
      setFocusedAnnotationId(null);
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && isZoomShortcut(event)) {
      event.preventDefault();
      updateZoom(isZoomInShortcut(event) ? ZOOM_STEP : -ZOOM_STEP);
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === "0") {
      event.preventDefault();
      resetZoom();
      return;
    }

    if (
      saveAvailable &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      void handleSave();
      return;
    }

    if (
      printAvailable &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "p"
    ) {
      event.preventDefault();
      void handlePrint();
      return;
    }

    if (isEditingText) {
      return;
    }

    if (
      !readOnly &&
      event.key === "Delete" &&
      selectedAnnotationIds.length > 0
    ) {
      event.preventDefault();
      deleteSelectedAnnotations();
      return;
    }

    if (
      !readOnly &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === "z"
    ) {
      event.preventDefault();
      void undoHistory();
      return;
    }

    // Ctrl+Y and Ctrl/Cmd+Shift+Z are both conventional for redo, so both work
    // regardless of platform, rather than picking one per OS.
    if (
      !readOnly &&
      (event.ctrlKey || event.metaKey) &&
      ((event.shiftKey && event.key.toLowerCase() === "z") ||
        event.key.toLowerCase() === "y")
    ) {
      event.preventDefault();
      void redoHistory();
    }
  }

  // The reader is working in this viewport, so unaimed gestures are its.
  function handleGestureRootTouched() {
    const root = documentEditorRootRef.current;
    if (root) {
      markGestureRootTouched(root);
    }
  }

  function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    updateZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function handleAddAnnotation(annotation: PdfAnnotation) {
    if (readOnly || busyRef.current) {
      return;
    }

    managedAnnotationPagesRef.current.add(annotation.pageIndex);
    onShowAnnotationsChange?.(true);
    const shouldKeepOpenForInitialText =
      annotation.kind === "freeText" || annotation.kind === "stickyNote";
    if (shouldKeepOpenForInitialText) {
      beginAnnotationEdit();
    }
    commitAnnotations(
      (current) => [...current, normalizeAnnotationLayout(annotation)],
      shouldKeepOpenForInitialText
        ? { assumeChanged: true, recordUndo: false }
        : { assumeChanged: true },
    );
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(shouldKeepOpenForInitialText ? annotation.id : null);
  }

  async function handleAddImageFromFile(file: File) {
    await addPreparedImageAnnotation(() => prepareImageStampFromFile(file));
  }

  async function handlePickImageFile() {
    if (!imageAnnotationsVisible || !pickImageFile) {
      return;
    }

    finishCurrentAnnotationEditWithValidation();
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
    // The image tool never becomes active, so the current tool is deactivated
    // up front or the dock keeps it highlighted until the picker settles.
    onToolChange?.("select");
    try {
      const file = await pickImageFile();
      if (file) {
        await handleAddImageFromFile(file);
      }
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "Could not add this image.",
        {
          tone: "danger",
        },
      );
    } finally {
      onToolChange?.("select");
    }
  }

  async function handlePasteImageFromSystemClipboard() {
    if (!imageAnnotationsVisible) {
      return;
    }

    finishCurrentAnnotationEditWithValidation();
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
    onToolChange?.("select");
    try {
      const image = await prepareImageStampFromSystemClipboard();
      if (image) {
        await addPreparedImageAnnotation(async () => image);
      } else {
        showNotice("No image found on the clipboard.", {
          tone: "danger",
        });
      }
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "Could not paste this image.",
        { tone: "danger" },
      );
    } finally {
      onToolChange?.("select");
    }
  }

  async function handleClipboardPaste(clipboardData: DataTransfer) {
    if (readOnly || busyRef.current) {
      return;
    }

    if (pasteAnnotationClipboard(clipboardData)) {
      return;
    }

    if (imageAnnotationsVisible) {
      const image = await prepareImageStampFromClipboardItems(
        clipboardData.items,
      ).catch((error) => {
        showNotice(
          error instanceof Error
            ? error.message
            : "Could not paste this image.",
          { tone: "danger" },
        );
        return null;
      });
      if (image) {
        addPreparedImageAnnotationFromData(image);
        return;
      }
    }

    const text = clipboardData.getData("text/plain");
    if (text.trim()) {
      addTextAnnotationForActivePage(text);
    }
  }

  async function addPreparedImageAnnotation(
    prepareImage: () => Promise<PreparedImageStamp>,
  ) {
    if (readOnly || !imageAnnotationsVisible || !beginBusyOperation()) {
      return;
    }

    try {
      const preparedImage = await prepareImage();
      addPreparedImageAnnotationFromData(preparedImage);
    } finally {
      finishBusyOperation();
    }
  }

  function addPreparedImageAnnotationFromData(
    preparedImage: PreparedImageStamp,
  ) {
    if (readOnly || !imageAnnotationsVisible) {
      return;
    }

    const annotation = imageStampAnnotationForActivePage(preparedImage);
    if (!annotation) {
      return;
    }

    managedAnnotationPagesRef.current.add(annotation.pageIndex);
    onShowAnnotationsChange?.(true);
    commitAnnotations((current) => [...current, annotation], {
      assumeChanged: true,
    });
    setSelectedAnnotationIds([annotation.id]);
    setFocusedAnnotationId(null);
    onToolChange?.("select");
  }

  // Pasted annotations arrive with a new identity from annotationClipboard.ts,
  // so a paste is an addition like any other.
  function pasteAnnotationClipboard(clipboardData: DataTransfer) {
    const token = clipboardData.getData(ANNOTATION_CLIPBOARD_TYPE);
    if (!hasAnnotationClipboard(token)) {
      return false;
    }

    const pageIndex = activePageIndexRef.current;
    const page = pagesRef.current[pageIndex];
    if (!page) {
      return false;
    }

    const pageBounds = pagePdfBounds(page.getViewport({ scale: 1 }));
    const pasted = readAnnotationPaste(token, { pageBounds, pageIndex }).filter(
      // Without a host that can hold one, the stamp would be committed and
      // never drawn.
      (annotation) =>
        imageAnnotationsVisible || annotation.kind !== "imageStamp",
    );
    if (pasted.length === 0) {
      return false;
    }

    managedAnnotationPagesRef.current.add(pageIndex);
    onShowAnnotationsChange?.(true);
    commitAnnotations(
      (current) => [...current, ...pasted.map(normalizeAnnotationLayout)],
      { assumeChanged: true },
    );
    setSelectedAnnotationIds(pasted.map((annotation) => annotation.id));
    setFocusedAnnotationId(null);
    onToolChange?.("select");
    return true;
  }

  function addTextAnnotationForActivePage(text: string) {
    if (readOnly || busyRef.current) {
      return;
    }

    const annotation = freeTextAnnotationForActivePage(text);
    if (!annotation) {
      return;
    }

    managedAnnotationPagesRef.current.add(annotation.pageIndex);
    onShowAnnotationsChange?.(true);
    commitAnnotations(
      (current) => [...current, normalizeAnnotationLayout(annotation)],
      {
        assumeChanged: true,
      },
    );
    setSelectedAnnotationIds([annotation.id]);
    setFocusedAnnotationId(null);
    onToolChange?.("select");
  }

  function imageStampAnnotationForActivePage(image: PreparedImageStamp) {
    const pageIndex = activePageIndexRef.current;
    const page = pagesRef.current[pageIndex];
    if (!page) {
      return null;
    }

    const viewport = page.getViewport({ scale: 1 });
    const pageBounds = pagePdfBounds(viewport);
    const pageWidth = pageBounds.x2 - pageBounds.x1;
    const pageHeight = pageBounds.y2 - pageBounds.y1;
    const naturalWidth = image.widthPx * 0.5;
    const naturalHeight = image.heightPx * 0.5;
    const fitScale = Math.min(
      1,
      (pageWidth * 0.6) / Math.max(1, naturalWidth),
      (pageHeight * 0.6) / Math.max(1, naturalHeight),
    );
    const width = Math.max(12, naturalWidth * fitScale);
    const height = Math.max(12, naturalHeight * fitScale);
    const center = activePageVisibleCenter(pageIndex, viewport) ?? {
      x: pageBounds.x1 + pageWidth / 2,
      y: pageBounds.y1 + pageHeight / 2,
    };
    const rect: PdfRect = {
      x1: clamp(center.x - width / 2, pageBounds.x1, pageBounds.x2 - width),
      x2:
        clamp(center.x - width / 2, pageBounds.x1, pageBounds.x2 - width) +
        width,
      y1: clamp(center.y - height / 2, pageBounds.y1, pageBounds.y2 - height),
      y2:
        clamp(center.y - height / 2, pageBounds.y1, pageBounds.y2 - height) +
        height,
    };

    return {
      id: crypto.randomUUID(),
      comment: "",
      imageData: image.data,
      heightPx: image.heightPx,
      kind: "imageStamp",
      mimeType: image.mimeType,
      pageIndex,
      rect,
      widthPx: image.widthPx,
    } satisfies PdfAnnotation;
  }

  function freeTextAnnotationForActivePage(text: string) {
    const pageIndex = activePageIndexRef.current;
    const page = pagesRef.current[pageIndex];
    if (!page) {
      return null;
    }

    const viewport = page.getViewport({ scale: 1 });
    const pageBounds = pagePdfBounds(viewport);
    const pageWidth = pageBounds.x2 - pageBounds.x1;
    const pageHeight = pageBounds.y2 - pageBounds.y1;
    const width = Math.min(260, pageWidth * 0.72);
    const height = Math.min(160, Math.max(48, pageHeight * 0.16));
    const center = activePageVisibleCenter(pageIndex, viewport) ?? {
      x: pageBounds.x1 + pageWidth / 2,
      y: pageBounds.y1 + pageHeight / 2,
    };
    const x1 = clamp(
      center.x - width / 2,
      pageBounds.x1,
      pageBounds.x2 - width,
    );
    const y2 = clamp(
      center.y + height / 2,
      pageBounds.y1 + height,
      pageBounds.y2,
    );

    return {
      id: crypto.randomUUID(),
      kind: "freeText",
      pageIndex,
      rect: {
        x1,
        x2: x1 + width,
        y1: y2 - height,
        y2,
      },
      text,
      fontSize: toolSettings.textFontSize,
      color: toolSettings.textColor,
      opacity: toolSettings.textOpacity,
    } satisfies PdfAnnotation;
  }

  function activePageVisibleCenter(
    pageIndex: number,
    viewport: PageViewport,
  ): PdfPoint | null {
    const container = scrollContainerRef.current;
    const pageElement = pageVisualElementForIndex(pageIndex);
    if (!container || !pageElement) {
      return null;
    }

    const containerBounds = container.getBoundingClientRect();
    const pageBounds = pageElement.getBoundingClientRect();
    const visibleLeft = Math.max(pageBounds.left, containerBounds.left);
    const visibleRight = Math.min(pageBounds.right, containerBounds.right);
    const visibleTop = Math.max(pageBounds.top, containerBounds.top);
    const visibleBottom = Math.min(pageBounds.bottom, containerBounds.bottom);
    if (visibleLeft >= visibleRight || visibleTop >= visibleBottom) {
      return null;
    }

    return viewportPointToPdfPoint(
      (((visibleLeft + visibleRight) / 2 - pageBounds.left) * viewport.width) /
        Math.max(1, pageBounds.width),
      (((visibleTop + visibleBottom) / 2 - pageBounds.top) * viewport.height) /
        Math.max(1, pageBounds.height),
      viewport,
    );
  }

  // An ordinary annotation edit: undoable, and part of the work signature.
  function setAnnotationComment(annotationId: string, comment: string) {
    updateAnnotation(annotationId, (annotation) =>
      withAnnotationComment(annotation, comment),
    );
  }

  function setAnnotationBookmarked(annotationId: string, bookmarked: boolean) {
    updateAnnotation(annotationId, (annotation) =>
      withAnnotationBookmark(annotation, bookmarked),
    );
  }

  // Deliberately does not select: selecting opens the in-viewport popover,
  // which a host list may be sitting on top of.
  function revealAnnotation(annotationId: string) {
    const annotation = annotationsRef.current.find(
      (candidate) => candidate.id === annotationId,
    );
    if (annotation) {
      void navigateToAnnotation(annotation);
    }
  }

  function updateAnnotation(
    id: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options: { recordUndo?: boolean } = {},
  ) {
    updateAnnotations([id], updater, options);
  }

  function updateAnnotations(
    ids: string[],
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options: { recordUndo?: boolean } = {},
  ) {
    if (readOnly || busyRef.current || ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    for (const annotation of annotationsRef.current) {
      if (idSet.has(annotation.id)) {
        managedAnnotationPagesRef.current.add(annotation.pageIndex);
      }
    }

    commitAnnotations(
      (current) =>
        current.map((annotation) =>
          idSet.has(annotation.id)
            ? normalizeAnnotationLayout(updater(annotation))
            : annotation,
        ),
      options.recordUndo === false
        ? { assumeChanged: true, recordUndo: false }
        : { assumeChanged: true, coalesce: true },
    );
  }

  function deleteSelectedAnnotations() {
    if (readOnly || busyRef.current || selectedAnnotationIds.length === 0) {
      return;
    }

    deleteAnnotations(selectedAnnotationIds);
    // deleteAnnotations only clears focus when the focused annotation was
    // deleted, and focus can sit outside the selection.
    setFocusedAnnotationId(null);
  }

  function deleteAnnotations(ids: string[]) {
    if (readOnly || busyRef.current || ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    for (const annotation of annotationsRef.current) {
      if (idSet.has(annotation.id)) {
        managedAnnotationPagesRef.current.add(annotation.pageIndex);
        rememberRemovedAnnotationSource(annotation);
      }
    }

    commitAnnotations((current) =>
      current.filter((annotation) => !idSet.has(annotation.id)),
    );
    setSelectedAnnotationIds((current) =>
      current.filter((id) => !idSet.has(id)),
    );
    setFocusedAnnotationId((current) =>
      current && idSet.has(current) ? null : current,
    );
    if (liveAnnotationEditRef.current.kind === "pending") {
      finishAnnotationEdit();
    }
  }

  function eraseAnnotations({
    deleteIds,
    pathUpdates,
  }: {
    deleteIds: string[];
    pathUpdates: Array<{ annotationId: string; paths: PdfPoint[][] }>;
  }) {
    if (
      readOnly ||
      busyRef.current ||
      (deleteIds.length === 0 && pathUpdates.length === 0)
    ) {
      return;
    }

    const deleteIdSet = new Set(deleteIds);
    const pathUpdateMap = new Map(
      pathUpdates.map((update) => [update.annotationId, update.paths]),
    );

    for (const annotation of annotationsRef.current) {
      if (deleteIdSet.has(annotation.id)) {
        managedAnnotationPagesRef.current.add(annotation.pageIndex);
        rememberRemovedAnnotationSource(annotation);
      } else if (pathUpdateMap.has(annotation.id)) {
        managedAnnotationPagesRef.current.add(annotation.pageIndex);
      }
    }

    commitAnnotations(
      (current) =>
        current.flatMap((annotation) => {
          if (deleteIdSet.has(annotation.id)) {
            return [];
          }

          const paths = pathUpdateMap.get(annotation.id);
          if (
            paths &&
            (annotation.kind === "draw" ||
              annotation.kind === "freehandHighlight")
          ) {
            return [{ ...annotation, paths }];
          }

          return [annotation];
        }),
      { assumeChanged: true, recordUndo: false },
    );
    setSelectedAnnotationIds((current) =>
      current.filter((id) => !deleteIdSet.has(id)),
    );
    setFocusedAnnotationId((current) =>
      current && deleteIdSet.has(current) ? null : current,
    );
  }

  function pruneOffPageAnnotations(annotationIds: string[]) {
    if (readOnly || busyRef.current || annotationIds.length === 0) {
      return;
    }

    const candidateIds = new Set(annotationIds);
    const removedIds = new Set<string>();

    commitAnnotations(
      (current) =>
        current.filter((annotation) => {
          if (!candidateIds.has(annotation.id)) {
            return true;
          }

          const page = pagesRef.current[annotation.pageIndex];
          if (!page) {
            return true;
          }

          const pageBounds = pagePdfBounds(page.getViewport({ scale }));
          if (annotationIntersectsPage(annotation, pageBounds)) {
            return true;
          }

          removedIds.add(annotation.id);
          managedAnnotationPagesRef.current.add(annotation.pageIndex);
          rememberRemovedAnnotationSource(annotation);
          return false;
        }),
      { recordUndo: false },
    );

    if (removedIds.size === 0) {
      return;
    }

    setSelectedAnnotationIds((current) =>
      current.filter((id) => !removedIds.has(id)),
    );
    setFocusedAnnotationId((current) =>
      current && removedIds.has(current) ? null : current,
    );
  }

  function handleSelectAnnotations(annotationIds: string[]) {
    finishCurrentAnnotationEditWithValidation();

    setSelectedAnnotationIds(annotationIds);
    setFocusedAnnotationId(null);
  }

  // True when it deliberately left an annotation selected, so a caller that
  // would otherwise clear the selection knows not to.
  function finishCurrentAnnotationEditWithValidation() {
    if (focusedAnnotationId) {
      return handleFocusAnnotationConsumed(focusedAnnotationId);
    }

    warnUnsupportedTextInAnnotations(selectedAnnotationIds);
    finishAnnotationEdit();
    return false;
  }

  function warnUnsupportedTextInAnnotations(annotationIds: string[]) {
    if (annotationIds.length === 0) {
      return;
    }

    const selectedIds = new Set(annotationIds);
    const annotationsToCheck = annotationsRef.current.filter((annotation) =>
      selectedIds.has(annotation.id),
    );

    if (annotationsToCheck.length === 0) {
      return;
    }

    try {
      assertAnnotationsTextIsSupported(annotationsToCheck);
    } catch (error) {
      if (error instanceof UnsupportedAnnotationTextError) {
        showNotice(error.message, { tone: "danger" });
        return;
      }
      throw error;
    }
  }

  // True when it deliberately left `annotationId` selected.
  function handleFocusAnnotationConsumed(annotationId: string) {
    const annotation = annotationsRef.current.find(
      (item) => item.id === annotationId,
    );

    if (annotation && !hasAnnotationContent(annotation)) {
      setFocusedAnnotationId((current) =>
        current === annotationId ? null : current,
      );
      deleteAnnotations([annotationId]);
      finishAnnotationEdit();
      return false;
    }

    if (annotation) {
      try {
        assertAnnotationsTextIsSupported([annotation]);
      } catch (error) {
        if (error instanceof UnsupportedAnnotationTextError) {
          onShowAnnotationsChange?.(true);
          setSelectedAnnotationIds([annotation.id]);
          setFocusedAnnotationId((current) =>
            current === annotationId ? null : current,
          );
          finishAnnotationEdit();
          showNotice(error.message, { tone: "danger" });
          return true;
        }
        throw error;
      }
    }

    setFocusedAnnotationId((current) =>
      current === annotationId ? null : current,
    );
    finishAnnotationEdit();
    return false;
  }

  function rememberRemovedAnnotationSource(annotation: PdfAnnotation) {
    removedAnnotationSourceIdsRef.current.add(
      annotation.sourceId ?? annotation.id,
    );
  }

  function handleToolChange(nextTool: Tool) {
    if (busyRef.current) {
      return;
    }

    if (readOnly && usesAnnotationLayer(nextTool)) {
      return;
    }

    window.getSelection()?.removeAllRanges();
    if (usesAnnotationLayer(nextTool)) {
      onShowAnnotationsChange?.(true);
    }
    onToolChange?.(nextTool);
  }

  function handlePreparationError(error: unknown) {
    if (!(error instanceof UnsupportedAnnotationTextError)) {
      return;
    }

    const annotation = annotationsRef.current.find(
      (candidate) => candidate.id === error.annotationId,
    );

    if (!annotation) {
      void navigateToPage(error.pageIndex, { block: "center" });
      return;
    }

    onShowAnnotationsChange?.(true);
    onToolChange?.("select");
    setSelectedAnnotationIds([annotation.id]);
    setFocusedAnnotationId(null);
    if (annotation.kind === "freeText" || annotation.kind === "stickyNote") {
      beginAnnotationEdit();
      window.requestAnimationFrame(() => {
        setSelectedAnnotationIds([annotation.id]);
        setFocusedAnnotationId(annotation.id);
      });
    }
    void navigateToAnnotation(annotation);
  }

  async function navigateToPage(
    pageIndex: number,
    options: {
      block?: ScrollLogicalPosition;
      destination?: unknown[];
    } = {},
  ) {
    if (pageCount === 0) {
      return;
    }

    const targetPageIndex = clamp(pageIndex, 0, pageCount - 1);
    activePageIndexRef.current = targetPageIndex;
    setActivePageIndex(targetPageIndex);
    const page = await ensurePageLoaded(targetPageIndex);
    window.requestAnimationFrame(() =>
      scrollToPage(targetPageIndex, {
        block: options.block ?? "start",
        destination: options.destination,
        page,
      }),
    );
  }

  async function navigateToAnnotation(annotation: PdfAnnotation) {
    const targetPageIndex = clamp(annotation.pageIndex, 0, pageCount - 1);
    activePageIndexRef.current = targetPageIndex;
    setActivePageIndex(targetPageIndex);
    const page = await ensurePageLoaded(targetPageIndex);
    window.requestAnimationFrame(() =>
      scrollToAnnotation(annotation, {
        fallbackPage: page,
      }),
    );
  }

  // A command, so host chrome can drop the selection without reaching into
  // core state.
  function clearAnnotationSelection() {
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
  }

  function handleActivatePage(pageIndex: number) {
    activePageIndexRef.current = pageIndex;
    setActivePageIndex(pageIndex);
  }

  function pageIndexFromClientPoint(clientX: number, clientY: number) {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const pageIndex = pageIndexFromElement(element);
      if (pageIndex !== null) {
        return pageIndex;
      }
    }

    return null;
  }

  function pageVisualElementForIndex(pageIndex: number) {
    return (
      scrollContainerRef.current?.querySelector<HTMLElement>(
        `[data-page-index="${pageIndex}"] .pdfdocumenteditor-page`,
      ) ?? null
    );
  }

  function handleMoveAnnotationsToPage({
    annotationIds,
    clientX,
    clientY,
    sourcePageIndex,
    sourcePoint,
  }: {
    annotationIds: string[];
    clientX: number;
    clientY: number;
    sourcePageIndex: number;
    sourcePoint: PdfPoint;
  }) {
    if (readOnly || busyRef.current || annotationIds.length === 0) {
      return null;
    }

    const targetPageIndex = pageIndexFromClientPoint(clientX, clientY);
    if (
      targetPageIndex === null ||
      targetPageIndex < 0 ||
      targetPageIndex >= pagesRef.current.length
    ) {
      return null;
    }

    const targetPage = pagesRef.current[targetPageIndex];
    const targetPageElement = pageVisualElementForIndex(targetPageIndex);
    if (!targetPage || !targetPageElement) {
      return null;
    }

    const targetBounds = targetPageElement.getBoundingClientRect();
    const targetViewport = targetPage.getViewport({ scale });
    const targetPoint = viewportPointToPdfPoint(
      clamp(
        ((clientX - targetBounds.left) * targetViewport.width) /
          Math.max(1, targetBounds.width),
        0,
        targetViewport.width,
      ),
      clamp(
        ((clientY - targetBounds.top) * targetViewport.height) /
          Math.max(1, targetBounds.height),
        0,
        targetViewport.height,
      ),
      targetViewport,
    );
    const delta = {
      x: targetPoint.x - sourcePoint.x,
      y: targetPoint.y - sourcePoint.y,
    };
    const movedIds = new Set(annotationIds);
    let moved = false;
    const movedBetweenPages = targetPageIndex !== sourcePageIndex;

    commitAnnotations(
      (current) =>
        current.map((annotation) => {
          if (
            !movedIds.has(annotation.id) ||
            annotation.pageIndex !== sourcePageIndex
          ) {
            return annotation;
          }

          moved = true;
          managedAnnotationPagesRef.current.add(sourcePageIndex);
          managedAnnotationPagesRef.current.add(targetPageIndex);
          const movedAnnotation = moveAnnotation(
            { ...annotation, pageIndex: targetPageIndex },
            delta,
          );

          if (movedBetweenPages && movedAnnotation.sourceId) {
            rememberRemovedAnnotationSource(annotation);
            // After a cross-page move, save a fresh annotation on the target
            // page, or deleting the source page drops the moved annotation.
            return normalizeAnnotationLayout({
              ...movedAnnotation,
              sourceId: undefined,
            });
          }

          return normalizeAnnotationLayout(movedAnnotation);
        }),
      { assumeChanged: true, recordUndo: false },
    );

    if (moved && movedBetweenPages) {
      handleActivatePage(targetPageIndex);
    }

    return moved ? { pageIndex: targetPageIndex, point: targetPoint } : null;
  }

  async function handlePdfDestination(destination: unknown) {
    // Untrusted: only pdf.js interprets it, and anything it cannot resolve is
    // a no-op rather than a throw.
    if (
      !pdfDoc ||
      (typeof destination !== "string" && !Array.isArray(destination))
    ) {
      return;
    }

    const explicitDestination = Array.isArray(destination)
      ? destination
      : await pdfDoc.getDestination(destination).catch(() => null);
    const destinationPage = explicitDestination?.[0];
    if (!explicitDestination || destinationPage === undefined) {
      return;
    }

    const pageIndex = await destinationTargetToPageIndex(
      pdfDoc,
      destinationPage,
    );
    if (pageIndex === null) {
      return;
    }

    await navigateToPage(pageIndex, {
      block: "center",
      destination: explicitDestination,
    });
  }

  function handlePdfPageNavigation(pageIndex: number) {
    void navigateToPage(pageIndex, { block: "center" });
  }

  function scrollToPage(
    pageIndex: number,
    {
      block,
      destination,
      page,
    }: {
      block: ScrollLogicalPosition;
      destination?: unknown[];
      page: PDFPageProxy | null;
    },
  ) {
    const container = scrollContainerRef.current;
    const pageElement = container?.querySelector<HTMLElement>(
      `[data-page-index="${pageIndex}"]`,
    );
    if (!container || !pageElement) {
      return;
    }

    const destinationTop = destination ? Number(destination[3]) : NaN;
    if (page && Number.isFinite(destinationTop)) {
      const viewport = page.getViewport({ scale });
      const [, y] = viewport.convertToViewportPoint(0, destinationTop);
      const containerRect = container.getBoundingClientRect();
      const pageRect = pageElement.getBoundingClientRect();
      container.scrollTo({
        top: container.scrollTop + pageRect.top - containerRect.top + y - 48,
      });
      return;
    }

    if (block === "start") {
      container.scrollTo({
        behavior: "auto",
        top:
          pageTopInContainer(container, pageElement) -
          scrollContainerPaddingTop(container),
      });
      return;
    }

    pageElement.scrollIntoView({ block });
  }

  function scrollToAnnotation(
    annotation: PdfAnnotation,
    { fallbackPage }: { fallbackPage: PDFPageProxy | null },
  ) {
    const container = scrollContainerRef.current;
    const pageElement = container?.querySelector<HTMLElement>(
      `[data-page-index="${annotation.pageIndex}"]`,
    );
    if (!container || !pageElement || !fallbackPage) {
      scrollToPage(annotation.pageIndex, {
        block: "center",
        page: fallbackPage,
      });
      return;
    }

    const viewport = fallbackPage.getViewport({ scale });
    const annotationRect = pdfRectToViewportRect(
      annotationBounds(annotation),
      viewport,
    );
    if (!Number.isFinite(annotationRect.y)) {
      scrollToPage(annotation.pageIndex, {
        block: "center",
        page: fallbackPage,
      });
      return;
    }

    const pageTop = pageTopInContainer(container, pageElement);
    const noticeStack = container
      .closest(".pdfdocumenteditor")
      ?.querySelector<HTMLElement>(".tabbedapp-notice-stack");
    const noticeClearance =
      (noticeStack?.getBoundingClientRect().height ?? 0) + 24;
    const preferredTop =
      pageTop +
      annotationRect.y -
      scrollContainerPaddingTop(container) -
      noticeClearance;
    const centeredTop =
      pageTop +
      annotationRect.y +
      annotationRect.height / 2 -
      container.clientHeight / 2;

    container.scrollTo({
      behavior: "auto",
      top: Math.max(0, Math.min(preferredTop, centeredTop)),
    });
  }

  function restoreCapturedViewPosition(
    viewPosition: PdfDocumentEditorViewPosition,
  ) {
    const container = scrollContainerRef.current;
    if (!container || pagesRef.current.length === 0) {
      return;
    }

    const pageIndex = clamp(
      viewPosition.pageIndex,
      0,
      pagesRef.current.length - 1,
    );
    const pageElement = pageElementForIndex(container, pageIndex);
    if (!pageElement) {
      return;
    }

    const pageTop = pageTopInContainer(container, pageElement);
    const maxScrollLeft = Math.max(
      0,
      container.scrollWidth - container.clientWidth,
    );
    container.scrollTo({
      behavior: "auto",
      left: viewPosition.scrollLeftRatio * maxScrollLeft,
      top:
        pageTop +
        clamp(viewPosition.offsetRatio, 0, 1) * pageElement.offsetHeight -
        scrollContainerPaddingTop(container),
    });
    activePageIndexRef.current = pageIndex;
    setActivePageIndex(pageIndex);
  }

  const view: PdfDocumentEditorViewState = {
    activePageIndex,
    annotationsByPage,
    annotationsComplete,
    busy,
    canRedo: redoStack.length > 0,
    canUndo: undoStack.length > 0,
    downloadAvailable,
    editingEnabled,
    fileName,
    hasUnsavedChanges,
    imageAnnotationsAvailable: imageAnnotationsVisible,
    loadError,
    mergeAvailable: mergePdfVisible,
    outline,
    pageSize,
    pages,
    passwordRequired: passwordRequest !== null,
    passwordRetry: passwordRequest?.failed ?? false,
    pdfDoc,
    printAvailable,
    ready: initialVisualReady,
    readOnly,
    readOnlyReason,
    saveAsAvailable,
    saveAvailable,
    scale,
    selectedAnnotationIds,
  };

  return (
    // A plain element, not a landmark: a host names this region itself.
    <div
      aria-busy={busy ? "true" : undefined}
      className={[DOCUMENT_EDITOR_ROOT_CLASS, "document-shell", className]
        .filter(Boolean)
        .join(" ")}
      data-busy={busy ? "true" : undefined}
      onFocusCapture={handleGestureRootTouched}
      onPointerDownCapture={handleGestureRootTouched}
      ref={documentEditorRootRef}
      style={rootStyle}
    >
      {/* The overlay slot and the viewport share this box, and the slot is
          the positioning context for everything a host puts in it. */}
      <div className="pdfdocumenteditor-body grow">
        {children?.(view)}

        <section
          className="pdfdocumenteditor-scroll-root"
          ref={scrollContainerRef}
        >
          <div className="pdfdocumenteditor-pages" ref={pagesLayerRef}>
            {pageCount > 0
              ? pages.map((page, index) => (
                  <div
                    className="pdfdocumenteditor-page-slot"
                    data-page-index={index}
                    key={index}
                  >
                    {page ? (
                      <PdfPageView
                        active={index === activePageIndex}
                        annotations={
                          annotationsByPage.get(index) ?? EMPTY_ANNOTATIONS
                        }
                        onActivate={handleActivatePage}
                        onAddAnnotation={handleAddAnnotation}
                        onDeleteAnnotations={deleteAnnotations}
                        focusedAnnotationId={focusedAnnotationId}
                        onFocusAnnotationConsumed={
                          handleFocusAnnotationConsumed
                        }
                        onEraseAnnotations={eraseAnnotations}
                        onEnsureAnnotationsVisible={() =>
                          onShowAnnotationsChange?.(true)
                        }
                        onExternalLinkRequest={handleExternalLinkRequest}
                        onBeginAnnotationEdit={beginAnnotationEdit}
                        onMoveAnnotationsToPage={handleMoveAnnotationsToPage}
                        onSelectAnnotations={handleSelectAnnotations}
                        onToolChange={handleToolChange}
                        onUpdateAnnotation={updateAnnotation}
                        onUpdateAnnotations={updateAnnotations}
                        page={page}
                        pageCount={pageCount}
                        pageIndex={index}
                        readOnly={readOnly || busy}
                        renderPriority={pageRenderPriority(
                          index,
                          visiblePageRange,
                        )}
                        scale={scale}
                        onNavigateDestination={(destination) =>
                          void handlePdfDestination(destination)
                        }
                        onNavigatePage={handlePdfPageNavigation}
                        onNotice={showNotice}
                        onPageReady={handlePageReady}
                        onPruneOffPageAnnotations={pruneOffPageAnnotations}
                        selectedAnnotationIds={selectedAnnotationIds}
                        showAnnotations={showAnnotations}
                        tool={tool}
                        toolSettings={toolSettings}
                      />
                    ) : (
                      <PdfPagePlaceholder
                        pageIndex={index}
                        pageSize={pageSize}
                        scale={scale}
                      />
                    )}
                  </div>
                ))
              : null}
          </div>
        </section>
      </div>
    </div>
  );
});

// `usePdfDocumentEditor` plus one `PdfDocumentEditorViewport`.
export const PdfDocumentEditor = forwardRef<
  PdfDocumentEditorHandle,
  PdfDocumentEditorProps
>(function PdfDocumentEditor(
  {
    allowEditing = true,
    allowImageAnnotations = true,
    confirmDiscardChanges,
    initialSession = null,
    onBusyChange,
    onClose,
    onDirtyChange,
    onDocumentReset,
    onDocumentReplaced,
    onMalformedAnnotations,
    onNotice,
    onSessionRestore,
    pickImageFile,
    pickMergePdfFile,
    printTarget = null,
    secondView = false,
    source,
    splitDirection = "row",
    splitRatio: controlledSplitRatio,
    onSplitRatioChange,
    ...viewport
  },
  ref,
) {
  const [uncontrolledSplitRatio, setUncontrolledSplitRatio] = useState(0.5);
  const splitRatio = controlledSplitRatio ?? uncontrolledSplitRatio;
  const setSplitRatio = onSplitRatioChange ?? setUncontrolledSplitRatio;
  const splitResizer = useSplitResizer({
    axis: splitDirection,
    ratio: splitRatio,
    setRatio: setSplitRatio,
  });
  const documentModel = useDocumentModel({
    allowEditing,
    allowImageAnnotations,
    confirmDiscardChanges,
    emptyTitle: viewport.emptyTitle,
    initialSession,
    manageDocumentTitle: viewport.manageDocumentTitle,
    onBusyChange,
    onClose,
    onDirtyChange,
    onDocumentReplaced,
    onDocumentReset,
    onMalformedAnnotations,
    onNotice,
    onSessionRestore,
    onShowAnnotationsChange: viewport.onShowAnnotationsChange,
    onToolChange: viewport.onToolChange,
    pickImageFile,
    pickMergePdfFile,
    printTarget,
    showAnnotations: viewport.showAnnotations,
    source,
  });

  // The row is here whether or not a second view is: removing it would change
  // the element type at this position, remounting the first viewport and
  // losing the reader's place.
  const { className = DEFAULT_FULLSCREEN_CLASS, ...viewportProps } = viewport;
  const splitClassName = [
    SPLIT_VIEW_CLASS,
    secondView && splitDirection === "column"
      ? `${SPLIT_VIEW_CLASS}--column`
      : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={splitClassName}>
      <PdfDocumentEditorViewport
        {...viewportProps}
        className=""
        document={documentModel}
        ref={ref}
        style={secondView ? { flexBasis: 0, flexGrow: splitRatio } : undefined}
      />
      {secondView ? (
        <>
          <div
            aria-label="Resize split"
            aria-orientation={
              splitDirection === "row" ? "vertical" : "horizontal"
            }
            aria-valuemax={splitResizer.ariaValueMax}
            aria-valuemin={splitResizer.ariaValueMin}
            aria-valuenow={splitResizer.ariaValueNow}
            className={`split-resizer ${SPLIT_VIEW_CLASS}-resizer`}
            onKeyDown={splitResizer.handleKeyDown}
            onPointerDown={splitResizer.handlePointerDown}
            onPointerMove={splitResizer.handlePointerMove}
            onPointerUp={splitResizer.handlePointerUp}
            role="separator"
            tabIndex={0}
          />
          <PdfDocumentEditorViewport
            {...viewportProps}
            // The host's chrome, the tab title and the handle all belong to
            // the first view.
            children={undefined}
            className=""
            document={documentModel}
            manageDocumentTitle={false}
            style={{ flexBasis: 0, flexGrow: 1 - splitRatio }}
          />
        </>
      ) : null}
    </div>
  );
});
