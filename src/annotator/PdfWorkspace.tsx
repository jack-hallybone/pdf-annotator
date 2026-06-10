import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  forwardRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  ChevronRight
} from 'lucide-react';
import { getDocument, PasswordResponses } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { importExistingAnnotationsForPage } from './annotationImport';
import {
  annotationFingerprint,
  annotationReplacementPageIndexes,
  byteFingerprint,
  createWorkSignature,
  groupAnnotationsByPage,
  hasAnnotationContent,
  mergeImportedAnnotations,
  normalizeAnnotationLayout,
  remapPageSetAfterDelete,
  remapPageSetAfterInsert
} from './annotationState';
import { annotationBounds, moveAnnotation } from './annotationGeometry';
import { DocumentSidebar } from './components/DocumentSidebar';
import {
  FloatingDocumentControls,
  FloatingHistoryControls,
  FloatingToolDock,
  FloatingZoomControls
} from './components/FloatingControls';
import { PdfPageView } from './PdfPageView';
import {
  addBlankPageAt,
  addLinedPageAt,
  mergePdfAfterPage,
  removePage,
  rotatePageClockwise,
  writePdfAnnotations
} from './pdfWriter';
import { viewportPointToPdfPoint } from './pdfGeometry';
import { PDFJS_DOCUMENT_OPTIONS } from './pdfRender';
import { readPdfFile } from './pdfFile';
import type {
  PdfDownloadTarget,
  PdfExternalLinkOpener,
  PdfSaveAsTarget,
  PdfSaveTarget,
  PdfWorkspaceSource
} from './host';
import {
  createDefaultToolPresets,
  defaultToolKeyForTool,
  defaultToolSettings,
  isDrawToolKey,
  pickDrawSettings,
  tools
} from './toolConfig';
import type {
  LoadedPage,
  PageRenderPriority,
  PageViewport,
  PageSize,
  PdfAnnotation,
  PdfPoint,
  Tool,
  ToolPresetMap,
  ToolSettings
} from './types';
import {
  ACTUAL_SIZE_ZOOM,
  clamp,
  EAGER_PAGE_LIMIT,
  LAZY_PAGE_BUFFER,
  MAX_LOADED_MAIN_PAGES,
  MAX_ZOOM,
  MIN_ZOOM,
  SIDEBAR_DEFAULT_WIDTH,
  ZOOM_STEP
} from './viewerConfig';

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const PRINT_FRAME_FALLBACK_MS = 4000;
const PRINT_BLOB_REVOKE_MS = 10 * 60 * 1000;
const RENDER_RESOURCE_RELEASE_DELAY_MS = 500;
const MAX_HISTORY_ENTRIES = 20;
const MAX_DOCUMENT_HISTORY_ENTRIES = 5;
const PDF_PROTECTION_SCAN_BYTES = 4 * 1024 * 1024;
const DEFAULT_WORKSPACE_CLASS = 'pdf-annotator--fullscreen';

export type PdfWorkspaceDocumentHistorySnapshot = {
  activePageIndex: number;
  annotations: PdfAnnotation[];
  cleanAnnotations: PdfAnnotation[];
  cleanPdfBytes?: Uint8Array | null;
  cleanSignatureRefreshEnabled: boolean;
  cleanWorkSignature: string;
  importedAnnotationPageIndexes: number[];
  managedAnnotationPageIndexes: number[];
  pdfBytes: Uint8Array;
  pdfFingerprint: string;
  removedAnnotationSourceIds: string[];
  shouldImportAnnotations: boolean;
  viewPosition?: PdfWorkspaceViewPosition;
};

export type PdfWorkspaceHistoryEntry =
  | {
      annotations: PdfAnnotation[];
      kind: 'annotations';
    }
  | {
      kind: 'document';
      snapshot: PdfWorkspaceDocumentHistorySnapshot;
    };

export type PdfWorkspaceSession = {
  activePageIndex: number;
  activeToolKey: string;
  annotations: PdfAnnotation[];
  cleanAnnotations: PdfAnnotation[];
  cleanPdfBytes?: Uint8Array | null;
  cleanSignatureRefreshEnabled?: boolean;
  cleanWorkSignature: string;
  editingEnabled?: boolean;
  fileName: string;
  hasUnsavedChanges: boolean;
  importedAnnotationPageIndexes: number[];
  managedAnnotationPageIndexes: number[];
  pdfBytes: Uint8Array;
  pdfFingerprint: string;
  redoStack: PdfWorkspaceHistoryEntry[];
  removedAnnotationSourceIds: string[];
  readOnlyReason?: PdfWorkspaceReadOnlyReason | null;
  downloadTarget?: PdfDownloadTarget | null;
  saveAsTarget?: PdfSaveAsTarget | null;
  saveTarget?: PdfSaveTarget | null;
  scale: number;
  showAnnotations: boolean;
  shouldImportAnnotations: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sourceId: string;
  tool: Tool;
  toolPresets: ToolPresetMap;
  toolSettings: ToolSettings;
  trustedExternalLinkKeys: string[];
  undoStack: PdfWorkspaceHistoryEntry[];
  viewPosition?: PdfWorkspaceViewPosition;
  version: 1;
};

export type PdfWorkspaceViewPosition = {
  offsetRatio: number;
  pageIndex: number;
  scrollLeftRatio: number;
};

export type PdfWorkspaceHandle = {
  downloadCopy: () => Promise<void>;
  print: () => Promise<void>;
  releaseRenderResources: () => Promise<void>;
  save: () => Promise<boolean>;
  saveAs: (suggestedName?: string) => Promise<boolean>;
  snapshot: () => PdfWorkspaceSession | null;
};

type PendingExternalLink = {
  trustKey: string;
  url: string;
};

export type PdfWorkspaceReadOnlyReason =
  | 'PDF/A compliant'
  | 'password protected'
  | 'signed/certified';

type PasswordRequest = {
  failed: boolean;
  generation: number;
  updatePassword: (password: string) => void;
};

export type PdfWorkspaceProps = {
  className?: string;
  confirmDiscardChanges?: (
    session: PdfWorkspaceSession
  ) => boolean | Promise<boolean>;
  enableGlobalShortcuts?: boolean;
  enableWheelZoom?: boolean;
  initialSession?: PdfWorkspaceSession | null;
  manageDocumentTitle?: boolean;
  onClose: () => void;
  onDirtyChange?: (hasUnsavedChanges: boolean) => void;
  onDocumentTitleChange?: (title: string) => void;
  onOpenExternalLink?: PdfExternalLinkOpener;
  onSessionChange?: (session: PdfWorkspaceSession) => void;
  showCloseButton?: boolean;
  source: PdfWorkspaceSource;
  style?: CSSProperties;
};

export const PdfWorkspace = forwardRef<PdfWorkspaceHandle, PdfWorkspaceProps>(
  function PdfWorkspace(
    {
      className = DEFAULT_WORKSPACE_CLASS,
      confirmDiscardChanges,
      enableGlobalShortcuts = true,
      enableWheelZoom = true,
      initialSession = null,
      manageDocumentTitle = true,
      onClose,
      onDirtyChange,
      onDocumentTitleChange,
      onOpenExternalLink,
      onSessionChange,
      showCloseButton = true,
      source,
      style
    },
    ref
  ) {
  const mergeFileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const pagesLayerRef = useRef<HTMLDivElement | null>(null);
  const lastUndoCommitTimeRef = useRef(0);
  const liveEditActiveRef = useRef(false);
  const finishLiveEditOnPointerUpRef = useRef(false);
  const pendingUndoSnapshotRef = useRef<{
    annotations: PdfAnnotation[];
    signature: string;
  } | null>(null);
  const annotationsRef = useRef<PdfAnnotation[]>([]);
  const undoStackRef = useRef<PdfWorkspaceHistoryEntry[]>([]);
  const redoStackRef = useRef<PdfWorkspaceHistoryEntry[]>([]);
  const pagesRef = useRef<LoadedPage[]>([]);
  const loadingPagesRef = useRef<Set<number>>(new Set());
  const pageAccessClockRef = useRef(0);
  const pageAccessOrderRef = useRef<Map<number, number>>(new Map());
  const importedAnnotationPagesRef = useRef<Set<number>>(new Set());
  const managedAnnotationPagesRef = useRef<Set<number>>(new Set());
  const removedAnnotationSourceIdsRef = useRef<Set<string>>(new Set());
  const shouldImportAnnotationsRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const loadingTaskRef = useRef<ReturnType<typeof getDocument> | null>(null);
  const structureReloadInProgressRef = useRef(false);
  const pdfFingerprintRef = useRef('');
  const cleanPdfBytesRef = useRef<Uint8Array | null>(null);
  const cleanAnnotationsRef = useRef<PdfAnnotation[]>([]);
  const cleanSignatureRefreshEnabledRef = useRef(true);
  const pendingZoomAnchorRef = useRef<{
    offsetRatio: number;
    pageIndex: number;
  } | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const passwordProtectedLoadRef = useRef(false);
  const activePageIndexRef = useRef(0);
  const initialVisualPageIndexRef = useRef(0);
  const initialBaseLayerReadyRef = useRef(false);
  const initialAnnotationsReadyRef = useRef(false);
  const initialVisualReadyRef = useRef(false);
  const afterInitialVisualReadyRef = useRef<Array<() => void>>([]);
  const printBlobUrlRef = useRef<string | null>(null);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);
  const externalLinkOpenButtonRef = useRef<HTMLButtonElement | null>(null);
  const downloadTargetRef = useRef<PdfDownloadTarget | null>(null);
  const saveAsTargetRef = useRef<PdfSaveAsTarget | null>(null);
  const saveTargetRef = useRef<PdfSaveTarget | null>(null);
  const sourceLoadRef = useRef<string | null>(null);
  const workspaceSourceIdRef = useRef(source.sourceId);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const mountedRef = useRef(false);
  const unmountCleanupTimerRef = useRef<number | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFingerprint, setPdfFingerprint] = useState('');
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<LoadedPage[]>([]);
  const [pageSize, setPageSize] = useState<PageSize | null>(null);
  const [fileName, setFileName] = useState('document.pdf');
  const [initialVisualReady, setInitialVisualReady] = useState(false);
  const [scale, setScale] = useState(ACTUAL_SIZE_ZOOM);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [activeToolKey, setActiveToolKey] = useState('select');
  const [toolSettings, setToolSettings] =
    useState<ToolSettings>(defaultToolSettings);
  const [toolPresets, setToolPresets] = useState<ToolPresetMap>(
    createDefaultToolPresets
  );
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>(
    []
  );
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(
    null
  );
  const [undoStack, setUndoStack] = useState<PdfWorkspaceHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<PdfWorkspaceHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [passwordRequest, setPasswordRequest] =
    useState<PasswordRequest | null>(null);
  const [readOnlyReason, setReadOnlyReason] =
    useState<PdfWorkspaceReadOnlyReason | null>(null);
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [sourceRetryKey, setSourceRetryKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [settingsToolKey, setSettingsToolKey] = useState<string | null>(null);
  const [pageMenuIndex, setPageMenuIndex] = useState<number | null>(null);
  const [pendingExternalLink, setPendingExternalLink] =
    useState<PendingExternalLink | null>(null);
  const [trustedExternalLinkKeys, setTrustedExternalLinkKeys] = useState<
    string[]
  >([]);
  const [scrollbarGutter, setScrollbarGutter] = useState({
    block: 0,
    inline: 0
  });
  const persistedAnnotations = useMemo(
    () => annotations.filter(hasAnnotationContent),
    [annotations]
  );
  const deferredPersistedAnnotations = useDeferredValue(persistedAnnotations);
  const annotationsByPage = useMemo(
    () => groupAnnotationsByPage(annotations),
    [annotations]
  );
  const currentWorkSignature = useMemo(
    () => createWorkSignature(pdfFingerprint, deferredPersistedAnnotations),
    [deferredPersistedAnnotations, pdfFingerprint]
  );
  const [cleanWorkSignature, setCleanWorkSignature] = useState('');
  const hasUnsavedChanges =
    Boolean(pdfBytes) &&
    cleanWorkSignature.length > 0 &&
    currentWorkSignature !== cleanWorkSignature;
  const readOnly = readOnlyReason !== null && !editingEnabled;
  const workspaceTitle =
    pages.length > 0
      ? `${hasUnsavedChanges ? '*' : ''}${fileName}`
      : 'PDF Annotator';
  const workspaceStyle = useMemo(
    () =>
      ({
        ...style,
        '--pdfa-scrollbar-block': `${scrollbarGutter.block}px`,
        '--pdfa-scrollbar-inline': `${scrollbarGutter.inline}px`
      }) as CSSProperties,
    [scrollbarGutter.block, scrollbarGutter.inline, style]
  );
  activePageIndexRef.current = activePageIndex;
  annotationsRef.current = annotations;
  undoStackRef.current = undoStack;
  redoStackRef.current = redoStack;
  const handleThumbnailPageLoad = useCallback(
    (page: PDFPageProxy, pageIndex: number) => {
      void importAnnotationsForLoadedPage(
        page,
        pageIndex,
        loadGenerationRef.current
      );
    },
    []
  );
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

  function createWorkspaceSession(): PdfWorkspaceSession | null {
    if (!pdfBytes) {
      return null;
    }

    const viewPosition = captureViewPosition();

    return {
      activePageIndex: viewPosition.pageIndex,
      activeToolKey,
      annotations,
      cleanAnnotations: cleanAnnotationsRef.current,
      cleanPdfBytes: cleanPdfBytesRef.current,
      cleanSignatureRefreshEnabled: cleanSignatureRefreshEnabledRef.current,
      cleanWorkSignature,
      editingEnabled,
      fileName,
      hasUnsavedChanges,
      importedAnnotationPageIndexes: Array.from(
        importedAnnotationPagesRef.current
      ),
      managedAnnotationPageIndexes: Array.from(
        managedAnnotationPagesRef.current
      ),
      pdfBytes,
      pdfFingerprint,
      redoStack: redoStackRef.current,
      removedAnnotationSourceIds: Array.from(
        removedAnnotationSourceIdsRef.current
      ),
      readOnlyReason,
      downloadTarget: downloadTargetRef.current,
      saveAsTarget: saveAsTargetRef.current,
      saveTarget: saveTargetRef.current,
      scale,
      showAnnotations,
      shouldImportAnnotations: shouldImportAnnotationsRef.current,
      sidebarOpen,
      sidebarWidth,
      sourceId: workspaceSourceIdRef.current,
      tool,
      toolPresets,
      toolSettings,
      trustedExternalLinkKeys,
      undoStack: undoStackRef.current,
      viewPosition,
      version: 1
    };
  }

  function captureViewPosition(): PdfWorkspaceViewPosition {
    const container = scrollContainerRef.current;
    const pageIndex = activePageIndexRef.current;
    const fallback = {
      offsetRatio: 0,
      pageIndex,
      scrollLeftRatio: 0
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
      container.scrollWidth - container.clientWidth
    );

    return {
      offsetRatio: clamp(
        (container.scrollTop + paddingTop - pageTop) /
          Math.max(1, pageElement.offsetHeight),
        0,
        1
      ),
      pageIndex,
      scrollLeftRatio:
        maxScrollLeft > 0
          ? clamp(container.scrollLeft / maxScrollLeft, 0, 1)
          : 0
    };
  }

  async function releaseRenderResources() {
    const currentPdfDoc = pdfDocRef.current;
    pdfDocRef.current = null;
    loadGenerationRef.current += 1;
    clearRenderCache({ clearState: true });
    cleanupPrintResources();
    await cancelLoadingTask();
    await destroyPdfDocument(currentPdfDoc);
  }

  useImperativeHandle(
    ref,
    () => ({
      downloadCopy: handleDownload,
      print: handlePrint,
      releaseRenderResources,
      save: handleSave,
      saveAs: handleSaveAs,
      snapshot: createWorkspaceSession
    }),
    [
      activePageIndex,
      activeToolKey,
      annotations,
      cleanWorkSignature,
      editingEnabled,
      fileName,
      handleDownload,
      handlePrint,
      handleSave,
      handleSaveAs,
      hasUnsavedChanges,
      pdfBytes,
      pdfFingerprint,
      readOnlyReason,
      redoStack,
      scale,
      showAnnotations,
      sidebarOpen,
      sidebarWidth,
      tool,
      toolPresets,
      toolSettings,
      trustedExternalLinkKeys,
      undoStack
    ]
  );

  useEffect(() => {
    pdfDocRef.current = pdfDoc;
  }, [pdfDoc]);

  useEffect(() => {
    if (!onSessionChange) {
      return;
    }

    const session = createWorkspaceSession();
    if (session) {
      onSessionChange(session);
    }
  }, [
    activePageIndex,
    activeToolKey,
    annotations,
    cleanWorkSignature,
    editingEnabled,
    fileName,
    hasUnsavedChanges,
    onSessionChange,
    pdfBytes,
    pdfFingerprint,
    readOnlyReason,
    redoStack,
    scale,
    showAnnotations,
    sidebarOpen,
    sidebarWidth,
    tool,
    toolPresets,
    toolSettings,
    trustedExternalLinkKeys,
    undoStack
  ]);

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
        clearRenderCache({ clearState: false });
        cleanupPrintResources();
        void cancelLoadingTask();
        void destroyPdfDocument(currentPdfDoc);
      }, RENDER_RESOURCE_RELEASE_DELAY_MS);
    };
  }, []);

  useEffect(() => {
    if (!pdfBytes) {
      return;
    }

    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange, pdfBytes]);

  useEffect(() => {
    if (pages.length > 0) {
      onDocumentTitleChange?.(workspaceTitle);
    }

    if (manageDocumentTitle) {
      document.title = workspaceTitle;
    }
  }, [manageDocumentTitle, onDocumentTitleChange, pages.length, workspaceTitle]);

  useLayoutEffect(() => {
    const nextSourceId = initialSession?.sourceId ?? source.sourceId;
    const nextLoadKey = `${nextSourceId}:${sourceRetryKey}`;
    if (sourceLoadRef.current === nextLoadKey) {
      return;
    }

    sourceLoadRef.current = nextLoadKey;
    if (initialSession) {
      void restoreWorkspaceSession(initialSession);
      return;
    }

    workspaceSourceIdRef.current = source.sourceId;
    void loadWorkspaceSource(source, nextLoadKey);
  }, [initialSession, source, sourceRetryKey]);

  function markPageAccess(pageIndex: number) {
    pageAccessClockRef.current += 1;
    pageAccessOrderRef.current.set(pageIndex, pageAccessClockRef.current);
  }

  function evictOldLoadedPages(
    candidatePages: LoadedPage[],
    protectedPageIndex: number
  ) {
    if (candidatePages.length <= EAGER_PAGE_LIMIT) {
      return candidatePages;
    }

    const loaded = candidatePages
      .map((page, pageIndex) => ({ page, pageIndex }))
      .filter(
        (item): item is { page: PDFPageProxy; pageIndex: number } =>
          Boolean(item.page)
      );
    if (loaded.length <= MAX_LOADED_MAIN_PAGES) {
      return candidatePages;
    }

    const currentActivePageIndex = activePageIndexRef.current;
    const protectedIndexes = new Set<number>([
      protectedPageIndex,
      currentActivePageIndex
    ]);
    const start = Math.max(0, currentActivePageIndex - LAZY_PAGE_BUFFER);
    const end = Math.min(
      candidatePages.length - 1,
      currentActivePageIndex + LAZY_PAGE_BUFFER
    );
    for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
      protectedIndexes.add(pageIndex);
    }

    let next = candidatePages;
    let loadedCount = loaded.length;
    const evictionCandidates = loaded
      .filter(({ pageIndex }) => !protectedIndexes.has(pageIndex))
      .sort(
        (a, b) =>
          (pageAccessOrderRef.current.get(a.pageIndex) ?? 0) -
          (pageAccessOrderRef.current.get(b.pageIndex) ?? 0)
      );

    for (const { page, pageIndex } of evictionCandidates) {
      if (loadedCount <= MAX_LOADED_MAIN_PAGES) {
        break;
      }

      if (next === candidatePages) {
        next = [...candidatePages];
      }
      next[pageIndex] = null;
      loadedCount -= 1;
      pageAccessOrderRef.current.delete(pageIndex);
      schedulePageCleanup(page);
    }

    return next;
  }

  function schedulePageCleanup(page: PDFPageProxy) {
    schedulePdfPageCleanup(page);
  }

  function scheduleLoadedPagesCleanup(loadedPages: LoadedPage[]) {
    const pagesToClean = new Set(
      loadedPages.filter((page): page is PDFPageProxy => Boolean(page))
    );
    for (const page of pagesToClean) {
      schedulePdfPageCleanup(page);
    }
  }

  function schedulePdfPageCleanup(page: PDFPageProxy, retries = 2) {
    const cleanup = () => {
      try {
        page.cleanup();
      } catch (error) {
        if (retries > 0) {
          window.setTimeout(
            () => schedulePdfPageCleanup(page, retries - 1),
            100
          );
          return;
        }

        console.error(error);
      }
    };

    if (window.requestIdleCallback) {
      window.requestIdleCallback(cleanup, { timeout: 1000 });
    } else {
      window.setTimeout(cleanup, 0);
    }
  }

  function revokePrintBlobUrl() {
    if (printBlobUrlRef.current) {
      URL.revokeObjectURL(printBlobUrlRef.current);
      printBlobUrlRef.current = null;
    }
  }

  function removePrintFrame() {
    if (printFrameRef.current) {
      printFrameRef.current.remove();
      printFrameRef.current = null;
    }
  }

  function cleanupPrintResources() {
    removePrintFrame();
    revokePrintBlobUrl();
  }

  useEffect(() => {
    if (!pendingExternalLink) {
      return;
    }

    externalLinkOpenButtonRef.current?.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPendingExternalLink(null);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingExternalLink]);

  function updateZoom(delta: number) {
    captureZoomAnchor();
    setScale((value) => clampZoom(value + delta));
  }

  function resetZoom() {
    setZoom(ACTUAL_SIZE_ZOOM);
  }

  function setZoom(nextScale: number) {
    captureZoomAnchor();
    setScale(clampZoom(nextScale));
  }

  function captureZoomAnchor() {
    const container = scrollContainerRef.current;
    if (!container || pages.length === 0) {
      return;
    }

    const anchorPage = pageElementForIndex(container, activePageIndex);
    if (!anchorPage) {
      return;
    }

    const pageTop = pageTopInContainer(container, anchorPage);
    pendingZoomAnchorRef.current = {
      offsetRatio:
        (container.scrollTop + scrollContainerPaddingTop(container) - pageTop) /
        Math.max(1, anchorPage.offsetHeight),
      pageIndex: activePageIndex
    };
  }

  function fitZoomToPageWidth() {
    const container = scrollContainerRef.current;
    const page = activePageBaseSize();
    if (!container || !page) {
      return;
    }

    const availableWidth = container.clientWidth - 32;
    setZoom(Math.max(120, availableWidth) / page.width);
  }

  function fitZoomToPageHeight() {
    const container = scrollContainerRef.current;
    const page = activePageBaseSize();
    if (!container || !page) {
      return;
    }

    setZoom(Math.max(160, container.clientHeight - 40) / page.height);
  }

  function activePageBaseSize() {
    const activePage = pagesRef.current[activePageIndex];
    if (activePage) {
      const viewport = activePage.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    }

    return pageSize;
  }

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container) {
      return;
    }

    const anchorPage = pageElementForIndex(container, anchor.pageIndex);
    if (!anchorPage) {
      return;
    }

    pendingZoomAnchorRef.current = null;
    const pageTop = pageTopInContainer(container, anchorPage);
    container.scrollTo({
      top:
        pageTop +
        anchor.offsetRatio * anchorPage.offsetHeight -
        scrollContainerPaddingTop(container),
      behavior: 'auto'
    });
  }, [pages.length, scale]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !initialVisualReady) {
      setScrollbarGutter((current) =>
        current.block === 0 && current.inline === 0
          ? current
          : { block: 0, inline: 0 }
      );
      return;
    }

    let frame = 0;
    const updateScrollbarGutter = () => {
      frame = 0;
      const next = measureScrollbarGutter(container);
      setScrollbarGutter((current) =>
        current.block === next.block && current.inline === next.inline
          ? current
          : next
      );
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
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [
    initialVisualReady,
    pageSize,
    pages.length,
    scale,
    sidebarOpen,
    sidebarWidth
  ]);

  useEffect(() => {
    if (!enableGlobalShortcuts) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditingText =
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (focusedAnnotationId) {
          handleFocusAnnotationConsumed(focusedAnnotationId);
        }
        setTool('select');
        setActiveToolKey('select');
        setFocusedAnnotationId(null);
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && isZoomShortcut(event)) {
        event.preventDefault();
        updateZoom(isZoomInShortcut(event) ? ZOOM_STEP : -ZOOM_STEP);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === '0') {
        event.preventDefault();
        resetZoom();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        void handlePrint();
        return;
      }

      if (isEditingText) {
        return;
      }

      if (
        !readOnly &&
        event.key === 'Delete' &&
        selectedAnnotationIds.length > 0
      ) {
        event.preventDefault();
        deleteSelectedAnnotations();
        return;
      }

      if (
        !readOnly &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault();
        void undoHistory();
        return;
      }

      if (
        !readOnly &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'y'
      ) {
        event.preventDefault();
        void redoHistory();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    annotations,
    enableGlobalShortcuts,
    focusedAnnotationId,
    hasUnsavedChanges,
    pages.length,
    readOnly,
    redoStack,
    selectedAnnotationIds,
    undoStack
  ]);

  useEffect(() => {
    if (!enableWheelZoom) {
      return;
    }

    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();
      updateZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    }

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [enableWheelZoom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    let frame = 0;
    const updateActivePage = () => {
      const containerRect = container.getBoundingClientRect();
      let bestPage = -1;
      let bestArea = 0;

      container
        .querySelectorAll<HTMLElement>('[data-page-index]')
        .forEach((element) => {
          const rect = element.getBoundingClientRect();
          const visibleWidth = Math.max(
            0,
            Math.min(rect.right, containerRect.right) -
              Math.max(rect.left, containerRect.left)
          );
          const visibleHeight = Math.max(
            0,
            Math.min(rect.bottom, containerRect.bottom) -
              Math.max(rect.top, containerRect.top)
          );
          const area = visibleWidth * visibleHeight;

          if (area > bestArea) {
            bestArea = area;
            bestPage = Number(element.dataset.pageIndex);
          }
        });

      if (bestPage >= 0) {
        setActivePageIndex((current) => {
          if (current === bestPage) {
            return current;
          }

          activePageIndexRef.current = bestPage;
          return bestPage;
        });
      }
    };

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateActivePage);
    };

    scheduleUpdate();
    container.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [pages.length, scale]);

  useEffect(() => {
    if (!initialVisualReady || !pdfDoc || pages.length === 0) {
      return;
    }

    const start = Math.max(0, activePageIndex - LAZY_PAGE_BUFFER);
    const end = Math.min(pages.length - 1, activePageIndex + LAZY_PAGE_BUFFER);
    for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
      void ensurePageLoaded(pageIndex);
    }
  }, [activePageIndex, initialVisualReady, pages.length, pdfDoc]);

  useEffect(() => {
    function endPointerLiveEdit() {
      if (!finishLiveEditOnPointerUpRef.current) {
        liveEditActiveRef.current = false;
        return;
      }

      window.setTimeout(() => {
        finishAnnotationEdit();
      }, 0);
    }

    window.addEventListener('pointerup', endPointerLiveEdit, true);
    window.addEventListener('blur', finishAnnotationEdit);
    return () => {
      window.removeEventListener('pointerup', endPointerLiveEdit, true);
      window.removeEventListener('blur', finishAnnotationEdit);
    };
  }, []);

  function commitAnnotations(
    updater: (current: PdfAnnotation[]) => PdfAnnotation[],
    options: {
      assumeChanged?: boolean;
      coalesce?: boolean;
      recordUndo?: boolean;
    } = {}
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
      pendingUndoSnapshotRef.current === null
    ) {
      currentSignature ??= annotationHistorySignature(current);
      pendingUndoSnapshotRef.current = {
        annotations: current,
        signature: currentSignature
      };
    }

    annotationsRef.current = next;
    setAnnotations(next);
    if (
      options.recordUndo === false ||
      pendingUndoSnapshotRef.current !== null
    ) {
      return;
    }

    const now = Date.now();
    const shouldCoalesce =
      options.coalesce &&
      now - lastUndoCommitTimeRef.current < 600 &&
      undoStackRef.current.at(-1)?.kind === 'annotations';

    updateUndoStack((stack) =>
      shouldCoalesce && stack.length > 0
        ? stack
        : [...stack, annotationHistoryEntry(current)]
    );
    lastUndoCommitTimeRef.current = now;
    updateRedoStack([]);
  }

  function beginAnnotationEdit({
    finishOnPointerUp = false
  }: { finishOnPointerUp?: boolean } = {}) {
    if (liveEditActiveRef.current) {
      finishLiveEditOnPointerUpRef.current =
        finishLiveEditOnPointerUpRef.current || finishOnPointerUp;
      return;
    }

    if (!pendingUndoSnapshotRef.current) {
      const currentAnnotations = annotationsRef.current;
      pendingUndoSnapshotRef.current = {
        annotations: currentAnnotations,
        signature: annotationHistorySignature(currentAnnotations)
      };
    }

    liveEditActiveRef.current = true;
    finishLiveEditOnPointerUpRef.current = finishOnPointerUp;
    lastUndoCommitTimeRef.current = Date.now();
  }

  function finishAnnotationEdit() {
    const pendingSnapshot = pendingUndoSnapshotRef.current;
    pendingUndoSnapshotRef.current = null;
    liveEditActiveRef.current = false;
    finishLiveEditOnPointerUpRef.current = false;
    if (!pendingSnapshot) {
      return;
    }

    const currentSignature = annotationHistorySignature(annotationsRef.current);
    if (currentSignature === pendingSnapshot.signature) {
      return;
    }

    updateUndoStack((stack) => {
      const previous = stack.at(-1);
      if (
        previous?.kind === 'annotations' &&
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
    finishAnnotationEdit();
    const entry = undoStackRef.current.at(-1);
    if (!entry) {
      return;
    }

    if (entry.kind === 'document') {
      const redoEntry = documentHistoryEntry();
      if (!redoEntry || !(await restoreDocumentHistory(entry.snapshot))) {
        return;
      }

      popUndoEntry(entry);
      updateRedoStack((stack) => [...stack, redoEntry]);
      lastUndoCommitTimeRef.current = 0;
      return;
    }

    popUndoEntry(entry);
    updateRedoStack((stack) => [
      ...stack,
      annotationHistoryEntry(annotationsRef.current)
    ]);
    applyAnnotationHistory(entry.annotations);
    lastUndoCommitTimeRef.current = 0;
  }

  async function redoHistory() {
    finishAnnotationEdit();
    const entry = redoStackRef.current.at(-1);
    if (!entry) {
      return;
    }

    if (entry.kind === 'document') {
      const undoEntry = documentHistoryEntry();
      if (!undoEntry || !(await restoreDocumentHistory(entry.snapshot))) {
        return;
      }

      popRedoEntry(entry);
      updateUndoStack((stack) => [...stack, undoEntry]);
      lastUndoCommitTimeRef.current = 0;
      return;
    }

    popRedoEntry(entry);
    updateUndoStack((stack) => [
      ...stack,
      annotationHistoryEntry(annotationsRef.current)
    ]);
    applyAnnotationHistory(entry.annotations);
    lastUndoCommitTimeRef.current = 0;
  }

  function updateUndoStack(
    next:
      | PdfWorkspaceHistoryEntry[]
      | ((
          current: PdfWorkspaceHistoryEntry[]
        ) => PdfWorkspaceHistoryEntry[])
  ) {
    const nextStack = trimHistoryStack(
      typeof next === 'function' ? next(undoStackRef.current) : next
    );
    undoStackRef.current = nextStack;
    setUndoStack(nextStack);
  }

  function updateRedoStack(
    next:
      | PdfWorkspaceHistoryEntry[]
      | ((
          current: PdfWorkspaceHistoryEntry[]
        ) => PdfWorkspaceHistoryEntry[])
  ) {
    const nextStack = trimHistoryStack(
      typeof next === 'function' ? next(redoStackRef.current) : next
    );
    redoStackRef.current = nextStack;
    setRedoStack(nextStack);
  }

  function popUndoEntry(entry: PdfWorkspaceHistoryEntry) {
    updateUndoStack((stack) =>
      stack.at(-1) === entry ? stack.slice(0, -1) : stack
    );
  }

  function popRedoEntry(entry: PdfWorkspaceHistoryEntry) {
    updateRedoStack((stack) =>
      stack.at(-1) === entry ? stack.slice(0, -1) : stack
    );
  }

  function pushDocumentUndoEntry(
    entry: PdfWorkspaceHistoryEntry | null
  ) {
    if (!entry) {
      return;
    }

    updateUndoStack((stack) => [...stack, entry]);
    updateRedoStack([]);
  }

  function applyAnnotationHistory(nextAnnotations: PdfAnnotation[]) {
    annotationsRef.current = nextAnnotations;
    setAnnotations(nextAnnotations);
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
  }

  function replaceAnnotationsWithoutHistory(nextAnnotations: PdfAnnotation[]) {
    const normalized = nextAnnotations.map(normalizeAnnotationLayout);
    annotationsRef.current = normalized;
    setAnnotations(normalized);
  }

  function documentHistoryEntry(): PdfWorkspaceHistoryEntry | null {
    const snapshot = createDocumentHistorySnapshot();
    return snapshot ? { kind: 'document', snapshot } : null;
  }

  function createDocumentHistorySnapshot(): PdfWorkspaceDocumentHistorySnapshot | null {
    if (!pdfBytes) {
      return null;
    }

    return {
      activePageIndex: activePageIndexRef.current,
      annotations: annotationsRef.current.map(normalizeAnnotationLayout),
      cleanAnnotations: cleanAnnotationsRef.current.map(normalizeAnnotationLayout),
      cleanPdfBytes: cleanPdfBytesRef.current,
      cleanSignatureRefreshEnabled: cleanSignatureRefreshEnabledRef.current,
      cleanWorkSignature,
      importedAnnotationPageIndexes: Array.from(
        importedAnnotationPagesRef.current
      ),
      managedAnnotationPageIndexes: Array.from(
        managedAnnotationPagesRef.current
      ),
      pdfBytes,
      pdfFingerprint: pdfFingerprintRef.current,
      removedAnnotationSourceIds: Array.from(
        removedAnnotationSourceIdsRef.current
      ),
      shouldImportAnnotations: shouldImportAnnotationsRef.current,
      viewPosition: captureViewPosition()
    };
  }

  function resetPdfState({
    clearAnnotations = true,
    clearFileInfo = true
  }: {
    clearAnnotations?: boolean;
    clearFileInfo?: boolean;
  } = {}) {
    scheduleLoadedPagesCleanup(pagesRef.current);
    pagesRef.current = [];
    loadingPagesRef.current.clear();
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
    importedAnnotationPagesRef.current.clear();
    liveEditActiveRef.current = false;
    finishLiveEditOnPointerUpRef.current = false;
    pendingUndoSnapshotRef.current = null;
    structureReloadInProgressRef.current = false;
    removedAnnotationSourceIdsRef.current.clear();
    pdfFingerprintRef.current = '';
    cleanPdfBytesRef.current = null;
    cleanSignatureRefreshEnabledRef.current = true;
    downloadTargetRef.current = null;
    saveAsTargetRef.current = null;
    saveTargetRef.current = null;
    passwordProtectedLoadRef.current = false;
    setPdfBytes(null);
    setPdfFingerprint('');
    setPdfDoc(null);
    setPages([]);
    setPageSize(null);
    setScale(ACTUAL_SIZE_ZOOM);
    activePageIndexRef.current = 0;
    resetInitialVisualReadiness();
    setActivePageIndex(0);
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
    setShowAnnotations(true);
    setPageMenuIndex(null);
    setSettingsToolKey(null);
    setPendingExternalLink(null);
    setPasswordRequest(null);
    setReadOnlyReason(null);
    setEditingEnabled(false);
    setTrustedExternalLinkKeys([]);
    setSidebarOpen(false);
    cleanupPrintResources();

    if (clearFileInfo) {
      setFileName('document.pdf');
      if (manageDocumentTitle) {
        document.title = 'PDF Annotator';
      }
    }

    if (clearAnnotations) {
      annotationsRef.current = [];
      cleanAnnotationsRef.current = [];
      managedAnnotationPagesRef.current.clear();
      setAnnotations([]);
      updateUndoStack([]);
      updateRedoStack([]);
      setCleanWorkSignature('');
    }
  }

  function clearRenderCache({ clearState }: { clearState: boolean }) {
    scheduleLoadedPagesCleanup(pagesRef.current);
    pagesRef.current = [];
    loadingPagesRef.current.clear();
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
    afterInitialVisualReadyRef.current = [];
    initialBaseLayerReadyRef.current = false;
    initialAnnotationsReadyRef.current = false;
    initialVisualReadyRef.current = false;

    if (!clearState || !mountedRef.current) {
      return;
    }

    setPdfDoc(null);
    setPages([]);
    setPageSize(null);
    setInitialVisualReady(false);
  }

  async function destroyPdfDocument(doc: PDFDocumentProxy | null) {
    try {
      await doc?.cleanup();
    } catch {
      // Rendering may still be cancelling; destroy remains the authoritative release.
    }

    try {
      await (doc as { destroy?: () => Promise<void> } | null)?.destroy?.();
    } catch (error) {
      console.error(error);
    }
  }

  async function cancelLoadingTask() {
    const loadingTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    try {
      await loadingTask?.destroy();
    } catch (error) {
      console.error(error);
    }
  }

  function startPdfLoading(bytes: Uint8Array, generation: number) {
    passwordProtectedLoadRef.current = false;
    setPasswordRequest(null);
    const loadingTask = getDocument({
      ...PDFJS_DOCUMENT_OPTIONS,
      data: bytes.slice()
    });

    loadingTask.onPassword = (
      updatePassword: (password: string) => void,
      reason: number
    ) => {
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      passwordProtectedLoadRef.current = true;
      setBusy(false);
      setLoadError(null);
      setPasswordRequest({
        failed: reason === PasswordResponses.INCORRECT_PASSWORD,
        generation,
        updatePassword
      });
    };

    loadingTaskRef.current = loadingTask;
    return loadingTask;
  }

  function handlePasswordUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = passwordRequest;
    if (!request || request.generation !== loadGenerationRef.current) {
      return;
    }

    const password = passwordInputRef.current?.value ?? '';
    if (!password) {
      passwordInputRef.current?.focus();
      return;
    }

    if (passwordInputRef.current) {
      passwordInputRef.current.value = '';
    }
    setPasswordRequest(null);
    setBusy(true);
    request.updatePassword(password);
  }

  async function confirmDiscardUnsavedChanges() {
    if (!hasUnsavedChanges) {
      return true;
    }

    const session = createWorkspaceSession();
    if (confirmDiscardChanges && session) {
      try {
        return await confirmDiscardChanges(session);
      } catch (error) {
        console.error(error);
        return false;
      }
    }

    return false;
  }

  async function handleClosePdf() {
    if (!(await confirmDiscardUnsavedChanges())) {
      return;
    }

    const currentPdfDoc = pdfDoc;
    pdfDocRef.current = null;
    loadGenerationRef.current += 1;
    cleanupPrintResources();
    onClose();
    await cancelLoadingTask();
    await destroyPdfDocument(currentPdfDoc);
  }

  async function handlePrint() {
    if (!pdfBytes || pages.length === 0) {
      return;
    }

    setBusy(true);

    try {
      const printableBytes = await printablePdfBytes();
      void printPdfInFrame(printableBytes, printableName(fileName))
        .catch((error) => {
          console.error(error);
        });
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  function handleExternalLinkRequest(url: string) {
    const trustKey = externalLinkTrustKey(url);
    if (!trustKey) {
      return;
    }

    if (trustedExternalLinkKeys.includes(trustKey)) {
      void openExternalLink(url);
      return;
    }

    setPendingExternalLink({ trustKey, url });
  }

  function cancelExternalLinkRequest() {
    setPendingExternalLink(null);
  }

  function confirmExternalLinkRequest({ always = false } = {}) {
    const link = pendingExternalLink;
    if (!link) {
      return;
    }

    setPendingExternalLink(null);
    if (always) {
      setTrustedExternalLinkKeys((current) =>
        current.includes(link.trustKey) ? current : [...current, link.trustKey]
      );
    }
    void openExternalLink(link.url);
  }

  async function openExternalLink(url: string) {
    try {
      if (onOpenExternalLink) {
        await onOpenExternalLink(url, {
          fileName,
          sourceId: workspaceSourceIdRef.current
        });
        return;
      }

      openExternalLinkInNewTab(url);
    } catch (error) {
      console.error(error);
    }
  }

  async function restoreWorkspaceSession(session: PdfWorkspaceSession) {
    await loadPdfBytes(session.pdfBytes, session.fileName, {
      activePage: session.viewPosition?.pageIndex ?? session.activePageIndex,
      clearWorkingAnnotations: false,
      restoredSession: session,
      downloadTarget: session.downloadTarget ?? source.downloadTarget ?? null,
      saveTarget: session.saveTarget ?? source.saveTarget ?? null,
      saveAsTarget: session.saveAsTarget ?? source.saveAsTarget ?? null,
      sourceId: session.sourceId
    });
  }

  async function loadWorkspaceSource(
    nextSource: PdfWorkspaceSource,
    loadKey: string
  ) {
    let bytes: Uint8Array;
    setLoadError(null);

    try {
      if (nextSource.kind === 'loader') {
        resetPdfState({
          clearAnnotations: true,
          clearFileInfo: false
        });
        setFileName(nextSource.name);
        setBusy(true);
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
        saveAsTarget: nextSource.saveAsTarget ?? null,
        saveTarget: nextSource.saveTarget ?? null,
        sourceId: nextSource.sourceId
      });

      if (
        mountedRef.current &&
        nextSource.markDirty &&
        sourceLoadRef.current === loadKey
      ) {
        cleanSignatureRefreshEnabledRef.current = false;
        setCleanWorkSignature(
          createWorkSignature(`unsaved:${byteFingerprint(bytes)}`, [])
        );
      }
    } catch (error) {
      if (!mountedRef.current || sourceLoadRef.current !== loadKey) {
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Could not load PDF.';
      resetPdfState({
        clearAnnotations: true,
        clearFileInfo: false
      });
      setFileName(nextSource.name);
      setBusy(false);
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
      restoredSession?: PdfWorkspaceSession | null;
      downloadTarget?: PdfDownloadTarget | null;
      saveAsTarget?: PdfSaveAsTarget | null;
      saveTarget?: PdfSaveTarget | null;
      sourceId?: string;
    } = {}
  ) {
    const currentPdfDoc = pdfDoc;
    const generation = loadGenerationRef.current + 1;
    const nextPdfFingerprint = byteFingerprint(bytes);
    const restoredSession = options.restoredSession ?? null;
    loadGenerationRef.current = generation;
    resetPdfState({
      clearAnnotations: options.clearWorkingAnnotations ?? true,
      clearFileInfo: false
    });
    workspaceSourceIdRef.current =
      options.sourceId ?? workspaceSourceIdRef.current;
    if (restoredSession) {
      importedAnnotationPagesRef.current = new Set(
        restoredSession.importedAnnotationPageIndexes
      );
      managedAnnotationPagesRef.current = new Set(
        restoredSession.managedAnnotationPageIndexes
      );
      removedAnnotationSourceIdsRef.current = new Set(
        restoredSession.removedAnnotationSourceIds
      );
      shouldImportAnnotationsRef.current =
        restoredSession.shouldImportAnnotations;
    } else {
      shouldImportAnnotationsRef.current = true;
    }
    setLoadError(null);
    setBusy(true);

    try {
      await cancelLoadingTask();
      await destroyPdfDocument(currentPdfDoc);
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      const loadingTask = startPdfLoading(bytes, generation);
      const loadedPdf = await loadingTask.promise;
      if (loadingTaskRef.current === loadingTask) {
        loadingTaskRef.current = null;
      }
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        return;
      }

      const nextReadOnlyReason =
        restoredSession?.readOnlyReason ??
        (await detectReadOnlyReason(
          bytes,
          loadedPdf,
          passwordProtectedLoadRef.current
        ));
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        return;
      }

      const activePage = Math.min(
        options.activePage ?? 0,
        loadedPdf.numPages - 1
      );
      const firstPage = await loadedPdf.getPage(activePage + 1);
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        return;
      }

      const firstViewport = firstPage.getViewport({ scale: 1 });
      const initialPages = Array<LoadedPage>(loadedPdf.numPages).fill(null);
      initialPages[activePage] = firstPage;
      pagesRef.current = initialPages;
      markPageAccess(activePage);
      resetInitialVisualReadiness(activePage);

      pdfFingerprintRef.current = nextPdfFingerprint;
      cleanPdfBytesRef.current = restoredSession?.cleanPdfBytes ?? bytes;
      setPdfBytes(bytes);
      setPdfFingerprint(nextPdfFingerprint);
      setPdfDoc(loadedPdf);
      setPageSize({
        width: firstViewport.width,
        height: firstViewport.height
      });
      setPages(initialPages);
      setFileName(name);
      downloadTargetRef.current = options.downloadTarget ?? null;
      saveAsTargetRef.current = options.saveAsTarget ?? null;
      const nextSaveTarget =
        restoredSession?.readOnlyReason && restoredSession.editingEnabled
          ? null
          : options.saveTarget ?? null;
      saveTargetRef.current = nextSaveTarget;
      setReadOnlyReason(nextReadOnlyReason);
      setEditingEnabled(restoredSession?.editingEnabled ?? false);
      activePageIndexRef.current = activePage;
      setActivePageIndex(activePage);

      if (restoredSession) {
        cleanAnnotationsRef.current = restoredSession.cleanAnnotations.map(
          normalizeAnnotationLayout
        );
        setTool(restoredSession.tool);
        setActiveToolKey(restoredSession.activeToolKey);
        setToolSettings(restoredSession.toolSettings);
        setToolPresets(restoredSession.toolPresets);
        setScale(restoredSession.scale);
        setShowAnnotations(restoredSession.showAnnotations);
        setSidebarOpen(restoredSession.sidebarOpen);
        setSidebarWidth(restoredSession.sidebarWidth);
        setTrustedExternalLinkKeys(restoredSession.trustedExternalLinkKeys ?? []);
        cleanSignatureRefreshEnabledRef.current =
          restoredSession.cleanSignatureRefreshEnabled ?? true;
        setCleanWorkSignature(restoredSession.cleanWorkSignature);
        const restoredAnnotations = restoredSession.annotations.map(
          normalizeAnnotationLayout
        );
        annotationsRef.current = restoredAnnotations;
        setAnnotations(restoredAnnotations);
        setSelectedAnnotationIds([]);
        setFocusedAnnotationId(null);
        updateUndoStack(normalizeHistoryStack(restoredSession.undoStack));
        updateRedoStack(normalizeHistoryStack(restoredSession.redoStack));
      } else if (options.clearWorkingAnnotations ?? true) {
        const initialAnnotations =
          options.initialAnnotations?.map(normalizeAnnotationLayout) ?? [];
        setTool('select');
        setActiveToolKey('select');
        cleanSignatureRefreshEnabledRef.current = true;
        cleanAnnotationsRef.current = [];
        setCleanWorkSignature(createWorkSignature(nextPdfFingerprint, []));
        annotationsRef.current = initialAnnotations;
        setAnnotations(initialAnnotations);
        setSelectedAnnotationIds([]);
        setFocusedAnnotationId(null);
        updateUndoStack([]);
        updateRedoStack([]);
      }

      void importInitialPageAnnotations(firstPage, activePage, generation);
      const restoredViewPosition = restoredSession?.viewPosition;
      if (restoredViewPosition) {
        runAfterInitialVisualReady(() =>
          restoreCapturedViewPosition(restoredViewPosition)
        );
      }

      const remainingPageIndexes = Array.from(
        { length: loadedPdf.numPages },
        (_, index) => index
      ).filter((pageIndex) => pageIndex !== activePage);

      if (remainingPageIndexes.length === 0) {
        return;
      }

      if (loadedPdf.numPages <= EAGER_PAGE_LIMIT) {
        runAfterInitialVisualReady(() => {
          if (!mountedRef.current || generation !== loadGenerationRef.current) {
            return;
          }

          void loadPagesEagerly(remainingPageIndexes, loadedPdf, generation)
            .catch((error) => {
              if (
                mountedRef.current &&
                generation === loadGenerationRef.current
              ) {
                console.error(error);
              }
            });
        });
        return;
      }
    } catch (error) {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        console.error(error);
        const message =
          error instanceof Error ? error.message : 'Could not load PDF.';
        setLoadError(message);
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setBusy(false);
      }
    }
  }

  async function replacePdfAfterStructureEdit(
    bytes: Uint8Array,
    options: { activePage: number }
  ) {
    const currentPdfDoc = pdfDoc;
    const generation = loadGenerationRef.current + 1;
    const nextPdfFingerprint = byteFingerprint(bytes);
    loadGenerationRef.current = generation;
    cleanSignatureRefreshEnabledRef.current = false;
    shouldImportAnnotationsRef.current = true;
    importedAnnotationPagesRef.current.clear();
    loadingPagesRef.current.clear();
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
    cleanupPrintResources();

    let pendingPdf: PDFDocumentProxy | null = null;
    structureReloadInProgressRef.current = true;
    try {
      await cancelLoadingTask();
      const loadingTask = startPdfLoading(bytes, generation);
      pendingPdf = await loadingTask.promise;
      const loadedPdf = pendingPdf;
      if (loadingTaskRef.current === loadingTask) {
        loadingTaskRef.current = null;
      }
      if (generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        pendingPdf = null;
        return false;
      }

      const activePage = clamp(
        options.activePage,
        0,
        Math.max(0, loadedPdf.numPages - 1)
      );
      const initialPageIndexes = initialReloadPageIndexes(
        loadedPdf.numPages,
        activePage
      );
      const loadedPages = await Promise.all(
        initialPageIndexes.map(async (pageIndex) => ({
          page: await loadedPdf.getPage(pageIndex + 1),
          pageIndex
        }))
      );
      if (generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        pendingPdf = null;
        return false;
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

      const activeViewport = activeLoadedPage.getViewport({ scale: 1 });
      pdfFingerprintRef.current = nextPdfFingerprint;
      cleanPdfBytesRef.current = null;
      pagesRef.current = nextPages;
      setPdfBytes(bytes);
      setPdfFingerprint(nextPdfFingerprint);
      setPdfDoc(loadedPdf);
      setPageSize({
        width: activeViewport.width,
        height: activeViewport.height
      });
      setPages(nextPages);
      pendingPdf = null;
      activePageIndexRef.current = activePage;
      setActivePageIndex(activePage);
      setSelectedAnnotationIds([]);
      setFocusedAnnotationId(null);
      setPageMenuIndex(null);
      setSettingsToolKey(null);

      for (const { page, pageIndex } of loadedPages) {
        void importAnnotationsForLoadedPage(page, pageIndex, generation);
      }

      scheduleAfterVisiblePaint(() => {
        void destroyPdfDocument(currentPdfDoc);
      });

      const initialPageIndexSet = new Set(initialPageIndexes);
      const remainingPageIndexes = Array.from(
        { length: loadedPdf.numPages },
        (_, index) => index
      ).filter((pageIndex) => !initialPageIndexSet.has(pageIndex));
      if (
        loadedPdf.numPages <= EAGER_PAGE_LIMIT &&
        remainingPageIndexes.length > 0
      ) {
        runAfterInitialVisualReady(() => {
          if (generation !== loadGenerationRef.current) {
            return;
          }

          void loadPagesEagerly(remainingPageIndexes, loadedPdf, generation);
        });
      }

      return true;
    } catch (error) {
      if (pendingPdf) {
        await destroyPdfDocument(pendingPdf);
      }
      if (generation === loadGenerationRef.current) {
        console.error(error);
      }
      return false;
    } finally {
      if (generation === loadGenerationRef.current) {
        structureReloadInProgressRef.current = false;
      }
    }
  }

  async function restoreDocumentHistory(
    snapshot: PdfWorkspaceDocumentHistorySnapshot
  ) {
    const currentPdfDoc = pdfDoc;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    cleanSignatureRefreshEnabledRef.current =
      snapshot.cleanSignatureRefreshEnabled ?? true;
    importedAnnotationPagesRef.current = new Set(
      snapshot.importedAnnotationPageIndexes
    );
    managedAnnotationPagesRef.current = new Set(
      snapshot.managedAnnotationPageIndexes
    );
    removedAnnotationSourceIdsRef.current = new Set(
      snapshot.removedAnnotationSourceIds
    );
    shouldImportAnnotationsRef.current = snapshot.shouldImportAnnotations;
    loadingPagesRef.current.clear();
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
    cleanupPrintResources();

    let pendingPdf: PDFDocumentProxy | null = null;
    structureReloadInProgressRef.current = true;
    setBusy(true);

    try {
      await cancelLoadingTask();
      const loadingTask = startPdfLoading(snapshot.pdfBytes, generation);
      pendingPdf = await loadingTask.promise;
      const loadedPdf = pendingPdf;
      if (loadingTaskRef.current === loadingTask) {
        loadingTaskRef.current = null;
      }
      if (generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        pendingPdf = null;
        return false;
      }

      const activePage = clamp(
        snapshot.viewPosition?.pageIndex ?? snapshot.activePageIndex,
        0,
        Math.max(0, loadedPdf.numPages - 1)
      );
      const initialPageIndexes = initialReloadPageIndexes(
        loadedPdf.numPages,
        activePage
      );
      const loadedPages = await Promise.all(
        initialPageIndexes.map(async (pageIndex) => ({
          page: await loadedPdf.getPage(pageIndex + 1),
          pageIndex
        }))
      );
      if (generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        pendingPdf = null;
        return false;
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

      const activeViewport = activeLoadedPage.getViewport({ scale: 1 });
      const restoredAnnotations = snapshot.annotations.map(
        normalizeAnnotationLayout
      );
      const restoredCleanAnnotations = snapshot.cleanAnnotations.map(
        normalizeAnnotationLayout
      );

      pdfFingerprintRef.current = snapshot.pdfFingerprint;
      cleanPdfBytesRef.current = snapshot.cleanPdfBytes ?? null;
      cleanAnnotationsRef.current = restoredCleanAnnotations;
      annotationsRef.current = restoredAnnotations;
      pagesRef.current = nextPages;
      resetInitialVisualReadiness(activePage);
      setPdfBytes(snapshot.pdfBytes);
      setPdfFingerprint(snapshot.pdfFingerprint);
      setPdfDoc(loadedPdf);
      setPageSize({
        width: activeViewport.width,
        height: activeViewport.height
      });
      setPages(nextPages);
      setCleanWorkSignature(snapshot.cleanWorkSignature);
      setAnnotations(restoredAnnotations);
      pendingPdf = null;
      activePageIndexRef.current = activePage;
      setActivePageIndex(activePage);
      setSelectedAnnotationIds([]);
      setFocusedAnnotationId(null);
      setPageMenuIndex(null);
      setSettingsToolKey(null);

      for (const { page, pageIndex } of loadedPages) {
        if (pageIndex === activePage) {
          void importInitialPageAnnotations(page, pageIndex, generation);
        } else {
          void importAnnotationsForLoadedPage(page, pageIndex, generation);
        }
      }

      const restoredViewPosition = snapshot.viewPosition;
      if (restoredViewPosition) {
        runAfterInitialVisualReady(() =>
          restoreCapturedViewPosition(restoredViewPosition)
        );
      }

      scheduleAfterVisiblePaint(() => {
        void destroyPdfDocument(currentPdfDoc);
      });

      const initialPageIndexSet = new Set(initialPageIndexes);
      const remainingPageIndexes = Array.from(
        { length: loadedPdf.numPages },
        (_, index) => index
      ).filter((pageIndex) => !initialPageIndexSet.has(pageIndex));
      if (
        loadedPdf.numPages <= EAGER_PAGE_LIMIT &&
        remainingPageIndexes.length > 0
      ) {
        runAfterInitialVisualReady(() => {
          if (generation !== loadGenerationRef.current) {
            return;
          }

          void loadPagesEagerly(remainingPageIndexes, loadedPdf, generation);
        });
      }

      return true;
    } catch (error) {
      if (pendingPdf) {
        await destroyPdfDocument(pendingPdf);
      }
      if (generation === loadGenerationRef.current) {
        console.error(error);
      }
      return false;
    } finally {
      if (generation === loadGenerationRef.current) {
        structureReloadInProgressRef.current = false;
        setBusy(false);
      }
    }
  }

  async function ensurePageLoaded(
    pageIndex: number,
    doc: PDFDocumentProxy | null = pdfDoc,
    generation = loadGenerationRef.current,
    options: { evictOldPages?: boolean } = {}
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

      await importAnnotationsForLoadedPage(page, pageIndex, generation);
      return page;
    } catch (error) {
      if (generation === loadGenerationRef.current) {
        console.error(error);
      }
      return null;
    } finally {
      loadingPagesRef.current.delete(pageIndex);
    }
  }

  async function loadPagesEagerly(
    pageIndexes: number[],
    doc: PDFDocumentProxy,
    generation: number
  ) {
    for (const pageIndex of pageIndexes) {
      loadingPagesRef.current.add(pageIndex);
    }

    let loadedPages: Array<{ page: PDFPageProxy; pageIndex: number }>;
    try {
      loadedPages = await Promise.all(
        pageIndexes.map(async (pageIndex) => ({
          page: await doc.getPage(pageIndex + 1),
          pageIndex
        }))
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

    for (const { pageIndex } of loadedPages) {
      importedAnnotationPagesRef.current.add(pageIndex);
      managedAnnotationPagesRef.current.add(pageIndex);
    }

    const importedAnnotations = (
      await Promise.all(
        loadedPages.map(({ page, pageIndex }) =>
          importExistingAnnotationsForPage(page, pageIndex)
        )
      )
    ).flat();
    if (generation !== loadGenerationRef.current) {
      return;
    }

    cleanAnnotationsRef.current = mergeImportedAnnotations(
      cleanAnnotationsRef.current,
      importedAnnotations
    );
    refreshCleanWorkSignatureFromImports();
    setAnnotations((current) => {
      const next = mergeImportedAnnotations(current, importedAnnotations);
      annotationsRef.current = next;
      return next;
    });
  }

  async function importAnnotationsForLoadedPage(
    page: PDFPageProxy,
    pageIndex: number,
    generation: number
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
    const importedAnnotations = await importExistingAnnotationsForPage(
      page,
      pageIndex
    );
    if (generation !== loadGenerationRef.current) {
      return;
    }

    cleanAnnotationsRef.current = mergeImportedAnnotations(
      cleanAnnotationsRef.current,
      importedAnnotations
    );
    refreshCleanWorkSignatureFromImports();
    setAnnotations((current) => {
      const next = mergeImportedAnnotations(current, importedAnnotations);
      annotationsRef.current = next;
      return next;
    });
  }

  async function importInitialPageAnnotations(
    page: PDFPageProxy,
    pageIndex: number,
    generation: number
  ) {
    try {
      await importAnnotationsForLoadedPage(page, pageIndex, generation);
    } catch (error) {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        console.error(error);
      }
    } finally {
      if (mountedRef.current) {
        markInitialAnnotationsReady(pageIndex, generation);
      }
    }
  }

  async function handleMergeFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    if (readOnly || !file || !pdfBytes || pages.length === 0) {
      event.target.value = '';
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
    setBusy(true);
    try {
      const mergeBytes = await readPdfFile(file);
      const { bytes: nextBytes } = await mergePdfAfterPage(
        pdfBytes,
        mergeBytes,
        pages.length - 1
      );
      const replaced = await replacePdfAfterStructureEdit(nextBytes, {
        activePage: activePageIndex
      });
      if (!replaced) {
        throw new Error('Could not load the merged PDF.');
      }
      pushDocumentUndoEntry(undoEntry);
    } catch (error) {
      console.error(error);
      if (undoEntry?.kind === 'document') {
        await restoreDocumentHistory(undoEntry.snapshot);
      }
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function handleDeletePage(pageIndex = activePageIndex) {
    if (readOnly || !pdfBytes || pages.length <= 1) {
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
    setBusy(true);
    try {
      const nextBytes = await removePage(pdfBytes, pageIndex);
      managedAnnotationPagesRef.current = remapPageSetAfterDelete(
        managedAnnotationPagesRef.current,
        pageIndex
      );
      cleanAnnotationsRef.current = remapAnnotationsAfterDelete(
        cleanAnnotationsRef.current,
        pageIndex
      );
      replaceAnnotationsWithoutHistory(
        remapAnnotationsAfterDelete(annotationsRef.current, pageIndex)
      );
      setSelectedAnnotationIds([]);
      const replaced = await replacePdfAfterStructureEdit(nextBytes, {
        activePage: Math.max(0, Math.min(pageIndex, pages.length - 2))
      });
      if (!replaced) {
        throw new Error('Could not reload the PDF after deleting the page.');
      }
      pushDocumentUndoEntry(undoEntry);
      setPageMenuIndex(null);
    } catch (error) {
      console.error(error);
      if (undoEntry?.kind === 'document') {
        await restoreDocumentHistory(undoEntry.snapshot);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleAddPage(
    pageIndex = activePageIndex,
    position: 'before' | 'after' = 'after',
    kind: 'blank' | 'lined' = 'blank'
  ) {
    if (readOnly || !pdfBytes) {
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
    setBusy(true);
    try {
      const insertIndex = position === 'before' ? pageIndex : pageIndex + 1;
      const nextBytes =
        kind === 'lined'
          ? await addLinedPageAt(pdfBytes, insertIndex, pageIndex)
          : await addBlankPageAt(pdfBytes, insertIndex, pageIndex);
      managedAnnotationPagesRef.current = remapPageSetAfterInsert(
        managedAnnotationPagesRef.current,
        insertIndex
      );
      cleanAnnotationsRef.current = remapAnnotationsAfterInsert(
        cleanAnnotationsRef.current,
        insertIndex
      );
      replaceAnnotationsWithoutHistory(
        remapAnnotationsAfterInsert(annotationsRef.current, insertIndex)
      );
      const replaced = await replacePdfAfterStructureEdit(nextBytes, {
        activePage: insertIndex
      });
      if (!replaced) {
        throw new Error('Could not reload the PDF after adding the page.');
      }
      pushDocumentUndoEntry(undoEntry);
      setPageMenuIndex(null);
    } catch (error) {
      console.error(error);
      if (undoEntry?.kind === 'document') {
        await restoreDocumentHistory(undoEntry.snapshot);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRotatePage(pageIndex = activePageIndex) {
    if (readOnly || !pdfBytes || pages.length === 0) {
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
    setBusy(true);
    try {
      const nextBytes = await rotatePageClockwise(pdfBytes, pageIndex);
      const replaced = await replacePdfAfterStructureEdit(nextBytes, {
        activePage: pageIndex
      });
      if (!replaced) {
        throw new Error('Could not reload the PDF after rotating the page.');
      }
      pushDocumentUndoEntry(undoEntry);
      setPageMenuIndex(null);
    } catch (error) {
      console.error(error);
      if (undoEntry?.kind === 'document') {
        await restoreDocumentHistory(undoEntry.snapshot);
      }
    } finally {
      setBusy(false);
    }
  }

  function markCurrentWorkClean(cleanPdfBytes?: Uint8Array) {
    if (cleanPdfBytes) {
      cleanPdfBytesRef.current = cleanPdfBytes;
    }
    cleanSignatureRefreshEnabledRef.current = true;
    cleanAnnotationsRef.current = persistedAnnotations.map(normalizeAnnotationLayout);
    setCleanWorkSignature(
      createWorkSignature(pdfFingerprintRef.current, cleanAnnotationsRef.current)
    );
  }

  function refreshCleanWorkSignatureFromImports() {
    if (!cleanSignatureRefreshEnabledRef.current) {
      return;
    }

    setCleanWorkSignature(
      createWorkSignature(pdfFingerprintRef.current, cleanAnnotationsRef.current)
    );
  }

  async function handleSave() {
    if (!pdfBytes) {
      return false;
    }

    setBusy(true);

    try {
      const savedBytes = await currentPdfOutputBytes();
      const saveTarget = saveTargetRef.current;

      if (saveTarget) {
        try {
          await saveTarget.save(savedBytes);
          markCurrentWorkClean(savedBytes);
          return true;
        } catch (error) {
          console.error(error);
          const saveAsResult = await savePdfAs(savedBytes);
          if (saveAsResult === 'saved') {
            return true;
          }
          if (saveAsResult === 'unavailable') {
            await downloadPdfBytes(savedBytes, annotatedName(fileName));
          }
          return false;
        }
      }

      const saveAsResult = await savePdfAs(savedBytes);
      if (saveAsResult === 'saved') {
        return true;
      }
      if (saveAsResult === 'unavailable') {
        await downloadPdfBytes(savedBytes, annotatedName(fileName));
      }
      return false;
    } catch (error) {
      console.error(error);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveAs(suggestedName = fileName) {
    if (!pdfBytes) {
      return false;
    }

    setBusy(true);

    try {
      const savedBytes = await currentPdfOutputBytes();
      const saveAsResult = await savePdfAs(savedBytes, suggestedName);
      if (saveAsResult === 'saved') {
        return true;
      }
      if (saveAsResult === 'unavailable') {
        await downloadPdfBytes(savedBytes, annotatedName(fileName));
      }
      return false;
    } catch (error) {
      console.error(error);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function savePdfAs(bytes: Uint8Array, suggestedName = fileName) {
    const saveAsTarget = saveAsTargetRef.current;
    if (!saveAsTarget) {
      return 'unavailable' as const;
    }

    let result;
    try {
      result = await saveAsTarget.saveAs(bytes, safeDownloadName(suggestedName));
    } catch (error) {
      console.error(error);
      return 'unavailable' as const;
    }
    if (!result) {
      return 'cancelled' as const;
    }

    saveTargetRef.current = result.saveTarget ?? null;
    if (result.fileName) {
      setFileName(result.fileName);
    }
    markCurrentWorkClean(bytes);
    return 'saved' as const;
  }

  async function handleDownload() {
    if (!pdfBytes) {
      return;
    }

    setBusy(true);

    try {
      const savedBytes = await currentPdfOutputBytes();
      const outputName = annotatedName(fileName);
      await downloadPdfBytes(savedBytes, outputName);
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function currentPdfOutputBytes() {
    if (!pdfBytes) {
      throw new Error('No PDF is open.');
    }

    if (hasUnsavedChanges) {
      return annotatedPdfBytes();
    }

    return cleanPdfBytesRef.current ?? pdfBytes;
  }

  async function downloadPdfBytes(bytes: Uint8Array, suggestedName: string) {
    const target = downloadTargetRef.current;
    if (target) {
      await target.download(bytes, safeDownloadName(suggestedName));
      return;
    }

    downloadPdf(bytes, suggestedName);
  }

  async function annotatedPdfBytes() {
    if (!pdfBytes) {
      throw new Error('No PDF is open.');
    }

    const replacePageIndexes = annotationReplacementPageIndexes(
      managedAnnotationPagesRef.current,
      persistedAnnotations
    );
    const annotationsToWrite = writableAnnotations(
      persistedAnnotations,
      cleanAnnotationsRef.current
    );
    const replaceAnnotationSourceIds = annotationSourceIdsForReplacement(
      annotationsToWrite,
      removedAnnotationSourceIdsRef.current,
      persistedAnnotations,
      annotations
    );

    if (
      annotationsToWrite.length === 0 &&
      replaceAnnotationSourceIds.size === 0
    ) {
      return pdfBytes;
    }

    return writePdfAnnotations(pdfBytes, annotationsToWrite, {
      replaceAnnotationSourceIds,
      replacePageIndexes
    });
  }

  async function printablePdfBytes() {
    if (!pdfBytes) {
      throw new Error('No PDF is open.');
    }

    return showAnnotations
      ? currentPdfOutputBytes()
      : writePdfAnnotations(pdfBytes, []);
  }

  function createPrintBlobUrl(bytes: Uint8Array) {
    const blob = new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    cleanupPrintResources();
    printBlobUrlRef.current = url;
    window.setTimeout(() => {
      if (printBlobUrlRef.current === url) {
        revokePrintBlobUrl();
      }
    }, PRINT_BLOB_REVOKE_MS);

    return url;
  }

  function printPdfInFrame(bytes: Uint8Array, outputName: string) {
    const url = createPrintBlobUrl(bytes);
    const frame = document.createElement('iframe');
    frame.title = 'Printable PDF';
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, {
      border: '0',
      bottom: '0',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
      position: 'fixed',
      right: '0',
      width: '1px'
    });
    printFrameRef.current = frame;

    return new Promise<void>((resolve) => {
      let printRequested = false;
      let settled = false;
      const fallbackTimer = window.setTimeout(
        fallbackToTabOrDownload,
        PRINT_FRAME_FALLBACK_MS
      );

      function finish() {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(fallbackTimer);
        resolve();
      }

      function fallbackToTabOrDownload() {
        if (settled) {
          return;
        }

        removePrintFrame();
        if (!openPrintablePdfInTab(url)) {
          void downloadPdfBytes(bytes, outputName);
        }
        finish();
      }

      const requestFramePrint = () => {
        if (printRequested || settled) {
          return;
        }

        printRequested = true;
        try {
          const frameWindow = frame.contentWindow;
          if (!frameWindow) {
            throw new Error('Print frame is not available.');
          }

          frameWindow.addEventListener('afterprint', cleanupPrintResources, {
            once: true
          });
          frameWindow.focus();
          frameWindow.print();
          finish();
        } catch {
          fallbackToTabOrDownload();
        }
      };

      frame.addEventListener(
        'load',
        () => window.setTimeout(requestFramePrint, 250),
        { once: true }
      );
      frame.addEventListener(
        'error',
        () => {
          fallbackToTabOrDownload();
        },
        { once: true }
      );

      frame.src = url;
      document.body.append(frame);
    });
  }

  function openPrintablePdfInTab(url: string) {
    const printWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (!printWindow) {
      return false;
    }

    try {
      printWindow.opener = null;
    } catch {
      // The fallback tab can still be printed manually.
    }

    let printRequested = false;
    const requestPrint = () => {
      if (printRequested) {
        return;
      }

      printRequested = true;
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        // The PDF tab remains usable even if automatic print is blocked.
      }
    };

    try {
      printWindow.addEventListener(
        'load',
        () => window.setTimeout(requestPrint, 250),
        { once: true }
      );
    } catch {
      // The timeout fallback below still leaves the PDF tab available.
    }

    window.setTimeout(requestPrint, 1500);
    return true;
  }

  function handleAddAnnotation(annotation: PdfAnnotation) {
    if (readOnly) {
      return;
    }

    managedAnnotationPagesRef.current.add(annotation.pageIndex);
    setShowAnnotations(true);
    const shouldKeepOpenForInitialText =
      annotation.kind === 'freeText' || annotation.kind === 'stickyNote';
    if (shouldKeepOpenForInitialText) {
      beginAnnotationEdit();
    }
    commitAnnotations(
      (current) => [...current, normalizeAnnotationLayout(annotation)],
      shouldKeepOpenForInitialText
        ? { assumeChanged: true, recordUndo: false }
        : { assumeChanged: true }
    );
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(
      shouldKeepOpenForInitialText ? annotation.id : null
    );
  }

  function updateAnnotation(
    id: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options: { recordUndo?: boolean } = {}
  ) {
    if (readOnly) {
      return;
    }

    const pageIndex = annotationsRef.current.find(
      (annotation) => annotation.id === id
    )?.pageIndex;
    if (typeof pageIndex === 'number') {
      managedAnnotationPagesRef.current.add(pageIndex);
    }

    commitAnnotations(
      (current) =>
        current.map((annotation) =>
          annotation.id === id
            ? normalizeAnnotationLayout(updater(annotation))
            : annotation
        ),
      options.recordUndo === false
        ? { recordUndo: false }
        : { coalesce: true }
    );
  }

  function deleteSelectedAnnotations() {
    if (readOnly || selectedAnnotationIds.length === 0) {
      return;
    }

    const selectedIds = new Set(selectedAnnotationIds);
    for (const annotation of annotationsRef.current) {
      if (selectedIds.has(annotation.id)) {
        managedAnnotationPagesRef.current.add(annotation.pageIndex);
        rememberRemovedAnnotationSource(annotation);
      }
    }

    commitAnnotations((current) =>
      current.filter((annotation) => !selectedIds.has(annotation.id))
    );
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
    if (pendingUndoSnapshotRef.current && !liveEditActiveRef.current) {
      finishAnnotationEdit();
    }
  }

  function deleteAnnotations(ids: string[]) {
    if (readOnly || ids.length === 0) {
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
      current.filter((annotation) => !idSet.has(annotation.id))
    );
    setSelectedAnnotationIds((current) =>
      current.filter((id) => !idSet.has(id))
    );
    setFocusedAnnotationId((current) =>
      current && idSet.has(current) ? null : current
    );
    if (pendingUndoSnapshotRef.current && !liveEditActiveRef.current) {
      finishAnnotationEdit();
    }
  }

  function eraseAnnotations({
    deleteIds,
    pathUpdates
  }: {
    deleteIds: string[];
    pathUpdates: Array<{ annotationId: string; paths: PdfPoint[][] }>;
  }) {
    if (readOnly || (deleteIds.length === 0 && pathUpdates.length === 0)) {
      return;
    }

    const deleteIdSet = new Set(deleteIds);
    const pathUpdateMap = new Map(
      pathUpdates.map((update) => [update.annotationId, update.paths])
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
            (annotation.kind === 'draw' ||
              annotation.kind === 'freehandHighlight')
          ) {
            return [{ ...annotation, paths }];
          }

          return [annotation];
        }),
      { assumeChanged: true, recordUndo: false }
    );
    setSelectedAnnotationIds((current) =>
      current.filter((id) => !deleteIdSet.has(id))
    );
    setFocusedAnnotationId((current) =>
      current && deleteIdSet.has(current) ? null : current
    );
  }

  function pruneOffPageAnnotations(annotationIds: string[]) {
    if (readOnly || annotationIds.length === 0) {
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
      { recordUndo: false }
    );

    if (removedIds.size === 0) {
      return;
    }

    setSelectedAnnotationIds((current) =>
      current.filter((id) => !removedIds.has(id))
    );
    setFocusedAnnotationId((current) =>
      current && removedIds.has(current) ? null : current
    );
  }

  function handleSelectAnnotations(annotationIds: string[]) {
    if (focusedAnnotationId) {
      handleFocusAnnotationConsumed(focusedAnnotationId);
    } else {
      finishAnnotationEdit();
    }

    setSelectedAnnotationIds(annotationIds);
    setFocusedAnnotationId(null);
  }

  function handleFocusAnnotationConsumed(annotationId: string) {
    const annotation = annotationsRef.current.find(
      (item) => item.id === annotationId
    );
    setFocusedAnnotationId((current) =>
      current === annotationId ? null : current
    );

    if (annotation && !hasAnnotationContent(annotation)) {
      deleteAnnotations([annotationId]);
    }
    finishAnnotationEdit();
  }

  function rememberRemovedAnnotationSource(annotation: PdfAnnotation) {
    if (annotation.sourceId) {
      removedAnnotationSourceIdsRef.current.add(annotation.sourceId);
    }
  }

  function updateToolSettings(update: Partial<ToolSettings>) {
    if (readOnly) {
      return;
    }

    const targetToolKey = settingsToolKey ?? activeToolKey;
    if (targetToolKey && isDrawToolKey(targetToolKey)) {
      const drawUpdate = pickDrawSettings(update);
      if (Object.keys(drawUpdate).length > 0) {
        setToolPresets((current) => ({
          ...current,
          [targetToolKey]: {
            ...current[targetToolKey],
            ...drawUpdate
          }
        }));
      }
    }

    setToolSettings((current) => ({ ...current, ...update }));
  }

  function selectToolbarTool(toolKey: string) {
    if (readOnly) {
      return;
    }

    const item = tools.find((candidate) => candidate.key === toolKey);
    if (!item) {
      return;
    }

    window.getSelection()?.removeAllRanges();
    const preset = toolPresets[toolKey] ?? item.preset;
    if (preset) {
      setToolSettings((current) => ({ ...current, ...preset }));
    }
    if (usesAnnotationLayer(item.tool)) {
      setShowAnnotations(true);
    }
    setTool(item.tool);
    setActiveToolKey(toolKey);
    setSettingsToolKey(null);
  }

  function handleToolChange(nextTool: Tool) {
    if (readOnly && usesAnnotationLayer(nextTool)) {
      return;
    }

    window.getSelection()?.removeAllRanges();
    if (usesAnnotationLayer(nextTool)) {
      setShowAnnotations(true);
    }
    setTool(nextTool);
    setActiveToolKey(defaultToolKeyForTool(nextTool));
  }

  async function navigateToPage(
    pageIndex: number,
    options: {
      block?: ScrollLogicalPosition;
      destination?: unknown[];
    } = {}
  ) {
    if (pages.length === 0) {
      return;
    }

    const targetPageIndex = clamp(pageIndex, 0, pages.length - 1);
    activePageIndexRef.current = targetPageIndex;
    setActivePageIndex(targetPageIndex);
    const page = await ensurePageLoaded(targetPageIndex);
    window.requestAnimationFrame(() =>
      scrollToPage(targetPageIndex, {
        block: options.block ?? 'start',
        destination: options.destination,
        page
      })
    );
  }

  function handleSelectPage(pageIndex: number) {
    void navigateToPage(pageIndex, { block: 'start' });
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
    return scrollContainerRef.current?.querySelector<HTMLElement>(
      `[data-page-index="${pageIndex}"] .pdf-page`
    ) ?? null;
  }

  function handleMoveAnnotationsToPage({
    annotationIds,
    clientX,
    clientY,
    sourcePageIndex,
    sourcePoint
  }: {
    annotationIds: string[];
    clientX: number;
    clientY: number;
    sourcePageIndex: number;
    sourcePoint: PdfPoint;
  }) {
    if (readOnly || annotationIds.length === 0) {
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
        targetViewport.width
      ),
      clamp(
        ((clientY - targetBounds.top) * targetViewport.height) /
          Math.max(1, targetBounds.height),
        0,
        targetViewport.height
      ),
      targetViewport
    );
    const delta = {
      x: targetPoint.x - sourcePoint.x,
      y: targetPoint.y - sourcePoint.y
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
          return normalizeAnnotationLayout(
            moveAnnotation({ ...annotation, pageIndex: targetPageIndex }, delta)
          );
        }),
      { recordUndo: false }
    );

    if (moved && movedBetweenPages) {
      handleActivatePage(targetPageIndex);
    }

    return moved
      ? { pageIndex: targetPageIndex, point: targetPoint }
      : null;
  }

  async function handlePdfDestination(destination: string | unknown[]) {
    if (!pdfDoc) {
      return;
    }

    const explicitDestination = Array.isArray(destination)
      ? destination
      : await pdfDoc.getDestination(destination);
    const destinationPage = explicitDestination?.[0];
    if (!explicitDestination || destinationPage === undefined) {
      return;
    }

    const pageIndex = await destinationTargetToPageIndex(pdfDoc, destinationPage);
    if (pageIndex === null) {
      return;
    }

    await navigateToPage(pageIndex, {
      block: 'center',
      destination: explicitDestination
    });
  }

  function handlePdfPageNavigation(pageIndex: number) {
    void navigateToPage(pageIndex, { block: 'center' });
  }

  function handleToggleAnnotations() {
    setShowAnnotations((current) => {
      const next = !current;
      if (!next) {
        setTool('select');
        setActiveToolKey('select');
        setSelectedAnnotationIds([]);
        setFocusedAnnotationId(null);
        setSettingsToolKey(null);
      }
      return next;
    });
  }

  function handleEnableEditing() {
    saveTargetRef.current = null;
    setEditingEnabled(true);
    setTool('select');
    setActiveToolKey('select');
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
    setSettingsToolKey(null);
  }

  function scrollToPage(
    pageIndex: number,
    {
      block,
      destination,
      page
    }: {
      block: ScrollLogicalPosition;
      destination?: unknown[];
      page: PDFPageProxy | null;
    }
  ) {
    const container = scrollContainerRef.current;
    const pageElement = container?.querySelector<HTMLElement>(
      `[data-page-index="${pageIndex}"]`
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
        top: container.scrollTop + pageRect.top - containerRect.top + y - 48
      });
      return;
    }

    pageElement.scrollIntoView({ block });
  }

  function restoreCapturedViewPosition(viewPosition: PdfWorkspaceViewPosition) {
    const container = scrollContainerRef.current;
    if (!container || pagesRef.current.length === 0) {
      return;
    }

    const pageIndex = clamp(
      viewPosition.pageIndex,
      0,
      pagesRef.current.length - 1
    );
    const pageElement = pageElementForIndex(container, pageIndex);
    if (!pageElement) {
      return;
    }

    const pageTop = pageTopInContainer(container, pageElement);
    const maxScrollLeft = Math.max(
      0,
      container.scrollWidth - container.clientWidth
    );
    container.scrollTo({
      behavior: 'auto',
      left: viewPosition.scrollLeftRatio * maxScrollLeft,
      top:
        pageTop +
        clamp(viewPosition.offsetRatio, 0, 1) * pageElement.offsetHeight -
        scrollContainerPaddingTop(container)
    });
    activePageIndexRef.current = pageIndex;
    setActivePageIndex(pageIndex);
  }

  return (
    <main
      className={['pdf-annotator', className].filter(Boolean).join(' ')}
      style={workspaceStyle}
    >
      <input
        accept="application/pdf"
        className="pdfa-hidden-input"
        onChange={handleMergeFileChange}
        ref={mergeFileInputRef}
        type="file"
      />

      {initialVisualReady && pages.length > 0 ? (
        <DocumentSidebar
          activePageIndex={activePageIndex}
          annotationsByPage={annotationsByPage}
          busy={busy}
          onAddPage={handleAddPage}
          onClose={() => setSidebarOpen(false)}
          onDeletePage={handleDeletePage}
          onMergePdf={() => mergeFileInputRef.current?.click()}
          onRotatePage={handleRotatePage}
          onSelectPage={handleSelectPage}
          onThumbnailPageLoad={handleThumbnailPageLoad}
          onWidthChange={setSidebarWidth}
          open={sidebarOpen}
          pageSize={pageSize}
          pageMenuIndex={pageMenuIndex}
          pdfDoc={pdfDoc}
          pages={pages}
          readOnly={readOnly}
          setPageMenuIndex={setPageMenuIndex}
          showAnnotations={showAnnotations}
          width={sidebarWidth}
        />
      ) : null}

      {initialVisualReady && pages.length > 0 && !sidebarOpen ? (
        <div className="sidebar-toggle ui-frame screen-only">
          <button
            className="icon-button ui-button"
            onClick={() => setSidebarOpen(true)}
            title="Show sidebar"
            type="button"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      ) : null}

      {initialVisualReady && readOnly && readOnlyReason ? (
        <ReadOnlyBanner
          onEnableEditing={handleEnableEditing}
          reason={readOnlyReason}
        />
      ) : null}

      <section
        className="pdf-scroll-root"
        ref={scrollContainerRef}
      >
        <div className="pdf-pages" ref={pagesLayerRef}>
          {pages.length > 0 ? (
            pages.map((page, index) => (
              <div
                className="pdf-page-slot"
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
                    onFocusAnnotationConsumed={handleFocusAnnotationConsumed}
                    onEraseAnnotations={eraseAnnotations}
                    onEnsureAnnotationsVisible={() => setShowAnnotations(true)}
                    onExternalLinkRequest={handleExternalLinkRequest}
                    onBeginAnnotationEdit={beginAnnotationEdit}
                    onMoveAnnotationsToPage={handleMoveAnnotationsToPage}
                    onSelectAnnotations={handleSelectAnnotations}
                    onToolChange={handleToolChange}
                    onUpdateAnnotation={updateAnnotation}
                    page={page}
                    pageCount={pages.length}
                    pageIndex={index}
                    readOnly={readOnly}
                    renderPriority={pageRenderPriority(index, activePageIndex)}
                    scale={scale}
                    onNavigateDestination={(destination) =>
                      void handlePdfDestination(destination)
                    }
                    onNavigatePage={handlePdfPageNavigation}
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
          ) : null}
        </div>
      </section>

      {initialVisualReady && pages.length > 0 ? (
        <>
          {!readOnly ? (
            <FloatingToolDock
              activeTool={tool}
              activeToolKey={activeToolKey}
              onChangeSettings={updateToolSettings}
              onCloseSettings={() => setSettingsToolKey(null)}
              onSelectTool={selectToolbarTool}
              onToggleSettings={(nextToolKey) =>
                setSettingsToolKey((current) =>
                  current === nextToolKey ? null : nextToolKey
                )
              }
              settings={toolSettings}
              settingsToolKey={settingsToolKey}
              toolPresets={toolPresets}
            />
          ) : null}

          <FloatingDocumentControls
            busy={busy}
            onClosePdf={handleClosePdf}
            onDownload={handleDownload}
            onPrint={handlePrint}
            onSave={handleSave}
            onSaveAs={handleSaveAs}
            saveLabel="Save"
            onToggleAnnotations={handleToggleAnnotations}
            showCloseButton={showCloseButton}
            showAnnotations={showAnnotations}
          />

          <FloatingZoomControls
            activePageIndex={activePageIndex}
            onDefaultZoom={resetZoom}
            onFitHeight={fitZoomToPageHeight}
            onFitWidth={fitZoomToPageWidth}
            onJumpToPage={(pageNumber) =>
              void navigateToPage(pageNumber - 1, { block: 'start' })
            }
            onSetZoom={(nextScale) => setZoom(nextScale)}
            pageCount={pages.length}
            scale={scale}
            onZoomIn={() => updateZoom(ZOOM_STEP)}
            onZoomOut={() => updateZoom(-ZOOM_STEP)}
          />

          {!readOnly ? (
            <FloatingHistoryControls
              canRedo={redoStack.length > 0}
              canUndo={undoStack.length > 0}
              onRedo={() => void redoHistory()}
              onUndo={() => void undoHistory()}
              sidebarOpen={sidebarOpen}
              sidebarWidth={sidebarWidth}
            />
          ) : null}
        </>
      ) : null}

      {!initialVisualReady ? (
        <div className="loading-overlay screen-only">
          {passwordRequest ? (
            <PasswordUnlockForm
              failed={passwordRequest.failed}
              inputRef={passwordInputRef}
              onSubmit={handlePasswordUnlock}
            />
          ) : (
            <div className="loading-message">
              <span>{loadError ?? 'Loading...'}</span>
              {loadError ? (
                <button
                  className="ui-button loading-retry-button"
                  onClick={() => setSourceRetryKey((value) => value + 1)}
                  type="button"
                >
                  Retry
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {pendingExternalLink ? (
        <ExternalLinkDialog
          link={pendingExternalLink}
          onAlways={() => confirmExternalLinkRequest({ always: true })}
          onCancel={cancelExternalLinkRequest}
          onOpen={() => confirmExternalLinkRequest()}
          openButtonRef={externalLinkOpenButtonRef}
        />
      ) : null}

    </main>
  );
  }
);

function ReadOnlyBanner({
  onEnableEditing,
  reason
}: {
  onEnableEditing: () => void;
  reason: PdfWorkspaceReadOnlyReason;
}) {
  return (
    <div className="protected-pdf-banner ui-frame screen-only">
      <span className="protected-pdf-banner-text">
        This {reason} file is open as read-only to protect the original.
      </span>
      <button
        className="ui-button protected-pdf-edit-button"
        onClick={onEnableEditing}
        type="button"
      >
        Enable Editing
      </button>
    </div>
  );
}

function PasswordUnlockForm({
  failed,
  inputRef,
  onSubmit
}: {
  failed: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const passwordInputId = useId();

  return (
    <form className="password-unlock-form" onSubmit={onSubmit}>
      <label className="password-unlock-label" htmlFor={passwordInputId}>
        This file is password protected.
      </label>
      <div className="password-unlock-row">
        <input
          aria-invalid={failed ? 'true' : undefined}
          autoComplete="off"
          autoFocus
          className="password-unlock-input"
          id={passwordInputId}
          placeholder="Password"
          ref={inputRef}
          type="password"
        />
        <button className="ui-button password-unlock-button" type="submit">
          Unlock
        </button>
      </div>
    </form>
  );
}

function ExternalLinkDialog({
  link,
  onAlways,
  onCancel,
  onOpen,
  openButtonRef
}: {
  link: PendingExternalLink;
  onAlways: () => void;
  onCancel: () => void;
  onOpen: () => void;
  openButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div
      className="external-link-backdrop screen-only"
      onPointerDown={onCancel}
    >
      <section
        aria-modal="true"
        className="external-link-dialog ui-panel"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h2>External link</h2>
        <p>This file wants to open the following link:</p>
        <p className="external-link-url">{externalLinkDisplayUrl(link.url)}</p>
        <div className="external-link-actions">
          <button
            className="ui-button external-link-primary"
            onClick={onOpen}
            ref={openButtonRef}
            type="button"
          >
            Open
          </button>
          <button
            className="ui-button external-link-secondary"
            onClick={onAlways}
            title={`Always open links from ${externalLinkTrustLabel(link.trustKey)} for this document`}
            type="button"
          >
            Always open links in this document
          </button>
          <button
            className="ui-button external-link-secondary"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

async function detectReadOnlyReason(
  bytes: Uint8Array,
  pdfDoc: PDFDocumentProxy,
  passwordProtected: boolean
): Promise<PdfWorkspaceReadOnlyReason | null> {
  if (passwordProtected) {
    return 'password protected';
  }

  if (await pdfLooksPdfA(bytes, pdfDoc)) {
    return 'PDF/A compliant';
  }

  if (pdfLooksSignedOrCertified(bytes)) {
    return 'signed/certified';
  }

  return null;
}

async function pdfLooksPdfA(bytes: Uint8Array, pdfDoc: PDFDocumentProxy) {
  if (
    bytesContainPdfMarker(bytes, 'pdfaid:part', { caseInsensitive: true }) ||
    bytesContainPdfMarker(bytes, 'pdfaid:conformance', {
      caseInsensitive: true
    }) ||
    bytesContainPdfMarker(bytes, 'GTS_PDFA', { caseInsensitive: true }) ||
    bytesContainPdfMarker(bytes, 'PDF/A', { caseInsensitive: true })
  ) {
    return true;
  }

  try {
    const metadata = await (pdfDoc as any).getMetadata?.();
    const rawMetadata =
      metadata?.metadata?.getRaw?.() ??
      metadata?.metadata?.get?.('pdfaid:part') ??
      metadata?.metadata?.get?.('pdfaid:conformance') ??
      '';
    return typeof rawMetadata === 'string'
      ? /pdfaid:part|pdfaid:conformance|pdf\/a/i.test(rawMetadata)
      : false;
  } catch {
    return false;
  }
}

function pdfLooksSignedOrCertified(bytes: Uint8Array) {
  return (
    bytesContainPdfMarker(bytes, '/ByteRange') ||
    bytesContainPdfMarker(bytes, '/DocMDP') ||
    bytesContainPdfMarker(bytes, '/SigFlags') ||
    bytesContainPdfMarker(bytes, '/Type /Sig') ||
    bytesContainPdfMarker(bytes, '/SubFilter /adbe.pkcs7', {
      caseInsensitive: true
    }) ||
    bytesContainPdfMarker(bytes, '/SubFilter /ETSI.', {
      caseInsensitive: true
    })
  );
}

function bytesContainPdfMarker(
  bytes: Uint8Array,
  pattern: string,
  options: { caseInsensitive?: boolean } = {}
) {
  for (const [start, end] of pdfMarkerScanRanges(bytes.length)) {
    if (bytesContainAscii(bytes, pattern, options, start, end)) {
      return true;
    }
  }

  return false;
}

function pdfMarkerScanRanges(length: number): Array<[number, number]> {
  if (length <= PDF_PROTECTION_SCAN_BYTES * 2) {
    return [[0, length]];
  }

  return [
    [0, PDF_PROTECTION_SCAN_BYTES],
    [length - PDF_PROTECTION_SCAN_BYTES, length]
  ];
}

function bytesContainAscii(
  bytes: Uint8Array,
  pattern: string,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {},
  start = 0,
  end = bytes.length
) {
  const needle = Array.from(pattern, (char) => char.charCodeAt(0));
  const safeStart = clamp(Math.floor(start), 0, bytes.length);
  const safeEnd = clamp(Math.floor(end), safeStart, bytes.length);
  if (needle.length === 0 || safeEnd - safeStart < needle.length) {
    return false;
  }

  for (let index = safeStart; index <= safeEnd - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      const byte = bytes[index + offset];
      const expected = needle[offset];
      if (
        byte !== expected &&
        (!caseInsensitive ||
          asciiLower(byte) !== asciiLower(expected))
      ) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }

  return false;
}

function asciiLower(value: number) {
  return value >= 65 && value <= 90 ? value + 32 : value;
}

function downloadPdf(bytes: Uint8Array, name: string) {
  const blob = new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(name);
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function PdfPagePlaceholder({
  pageIndex,
  pageSize,
  scale
}: {
  pageIndex: number;
  pageSize: PageSize | null;
  scale: number;
}) {
  const width = (pageSize?.width ?? 612) * scale;
  const height = (pageSize?.height ?? 792) * scale;

  return (
    <article
      aria-label={`Loading page ${pageIndex + 1}`}
      className="pdf-page-placeholder"
      style={{ height, width }}
    >
      Page {pageIndex + 1}
    </article>
  );
}

async function destinationTargetToPageIndex(
  pdfDoc: PDFDocumentProxy,
  target: unknown
) {
  if (typeof target === 'number' && Number.isInteger(target)) {
    return target;
  }

  try {
    return await pdfDoc.getPageIndex(
      target as Parameters<PDFDocumentProxy['getPageIndex']>[0]
    );
  } catch {
    return null;
  }
}

function annotatedName(name: string) {
  return name.replace(/\.pdf$/i, '') + '-annotated.pdf';
}

function printableName(name: string) {
  return name.replace(/\.pdf$/i, '') + '-print.pdf';
}

function safeDownloadName(name: string) {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || 'annotated.pdf';
}

function externalLinkTrustKey(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'mailto:' ? 'mailto:' : parsed.origin;
  } catch {
    return null;
  }
}

function externalLinkTrustLabel(trustKey: string) {
  return trustKey === 'mailto:' ? 'email links' : trustKey;
}

function externalLinkDisplayUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return url;
  }
}

function openExternalLinkInNewTab(url: string) {
  const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
  if (!openedWindow) {
    return;
  }

  try {
    openedWindow.opener = null;
  } catch {
    // noopener is requested in the feature string; this is a defensive fallback.
  }
}

function annotationSourceIdsForReplacement(
  annotations: PdfAnnotation[],
  removedSourceIds: Set<string>,
  currentAnnotations: PdfAnnotation[],
  allAnnotations: PdfAnnotation[] = currentAnnotations
) {
  const currentSourceIds = new Set(
    currentAnnotations
      .map((annotation) => annotation.sourceId)
      .filter((sourceId): sourceId is string => Boolean(sourceId))
  );
  const sourceIds = new Set(
    Array.from(removedSourceIds).filter(
      (sourceId) => !currentSourceIds.has(sourceId)
    )
  );
  for (const annotation of annotations) {
    if (annotation.sourceId) {
      sourceIds.add(annotation.sourceId);
    }
  }
  for (const annotation of allAnnotations) {
    if (annotation.sourceId && !hasAnnotationContent(annotation)) {
      sourceIds.add(annotation.sourceId);
    }
  }
  return sourceIds;
}

function annotationHistorySignature(annotations: PdfAnnotation[]) {
  return createWorkSignature('', annotations);
}

function annotationHistoryEntry(
  annotations: PdfAnnotation[]
): PdfWorkspaceHistoryEntry {
  return {
    annotations,
    kind: 'annotations'
  };
}

function normalizeHistoryStack(
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

function trimHistoryStack(entries: PdfWorkspaceHistoryEntry[]) {
  const trimmed =
    entries.length > MAX_HISTORY_ENTRIES
      ? entries.slice(entries.length - MAX_HISTORY_ENTRIES)
      : [...entries];
  let documentEntries = trimmed.filter(
    (entry) => entry.kind === 'document'
  ).length;
  if (documentEntries <= MAX_DOCUMENT_HISTORY_ENTRIES) {
    return trimmed;
  }

  while (
    documentEntries > MAX_DOCUMENT_HISTORY_ENTRIES &&
    trimmed.length > 0
  ) {
    const [removed] = trimmed.splice(0, 1);
    if (removed?.kind === 'document') {
      documentEntries -= 1;
    }
  }

  return trimmed;
}

function remapAnnotationsAfterDelete(
  annotations: PdfAnnotation[],
  deletedPageIndex: number
) {
  return annotations
    .filter((annotation) => annotation.pageIndex !== deletedPageIndex)
    .map((annotation) =>
      annotation.pageIndex > deletedPageIndex
        ? { ...annotation, pageIndex: annotation.pageIndex - 1 }
        : annotation
    );
}

function remapAnnotationsAfterInsert(
  annotations: PdfAnnotation[],
  insertIndex: number
) {
  return annotations.map((annotation) =>
    annotation.pageIndex >= insertIndex
      ? { ...annotation, pageIndex: annotation.pageIndex + 1 }
      : annotation
  );
}

function writableAnnotations(
  annotations: PdfAnnotation[],
  cleanAnnotations: PdfAnnotation[]
) {
  const cleanFingerprints = new Map(
    cleanAnnotations.map((annotation) => [
      annotation.id,
      annotationFingerprint(annotation)
    ])
  );

  return annotations.filter((annotation) => {
    if (!annotation.sourceId) {
      return true;
    }

    return cleanFingerprints.get(annotation.id) !== annotationFingerprint(annotation);
  });
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function isZoomShortcut(event: KeyboardEvent) {
  return isZoomInShortcut(event) || isZoomOutShortcut(event);
}

function isZoomInShortcut(event: KeyboardEvent) {
  return event.key === '+' || event.key === '=';
}

function isZoomOutShortcut(event: KeyboardEvent) {
  return event.key === '-' || event.key === '_';
}

function usesAnnotationLayer(tool: Tool) {
  return tool !== 'select';
}

function pageRenderPriority(
  pageIndex: number,
  activePageIndex: number
): PageRenderPriority {
  const distance = Math.abs(pageIndex - activePageIndex);
  if (distance === 0) {
    return 'visible';
  }

  return distance === 1 ? 'near' : 'idle';
}

function initialReloadPageIndexes(pageCount: number, activePageIndex: number) {
  const start = Math.max(0, activePageIndex - LAZY_PAGE_BUFFER);
  const end = Math.min(pageCount - 1, activePageIndex + LAZY_PAGE_BUFFER);
  return Array.from(
    { length: end - start + 1 },
    (_, index) => start + index
  );
}

function scheduleAfterVisiblePaint(callback: () => void) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (window.requestIdleCallback) {
        window.requestIdleCallback(callback, { timeout: 600 });
      } else {
        window.setTimeout(callback, 100);
      }
    });
  });
}

function pageElementForIndex(container: HTMLElement, pageIndex: number) {
  return container.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`);
}

function pageIndexFromElement(element: Element | null) {
  const pageSlot = element?.closest<HTMLElement>('[data-page-index]');
  if (!pageSlot) {
    return null;
  }

  const pageIndex = Number(pageSlot.dataset.pageIndex);
  return Number.isInteger(pageIndex) ? pageIndex : null;
}

function pagePdfBounds(viewport: PageViewport) {
  const topLeft = viewportPointToPdfPoint(0, 0, viewport);
  const bottomRight = viewportPointToPdfPoint(
    viewport.width,
    viewport.height,
    viewport
  );

  return {
    x1: Math.min(topLeft.x, bottomRight.x),
    y1: Math.min(topLeft.y, bottomRight.y),
    x2: Math.max(topLeft.x, bottomRight.x),
    y2: Math.max(topLeft.y, bottomRight.y)
  };
}

function annotationIntersectsPage(
  annotation: PdfAnnotation,
  pageBounds: ReturnType<typeof pagePdfBounds>
) {
  const bounds = annotationBounds(annotation);
  return (
    Number.isFinite(bounds.x1) &&
    Number.isFinite(bounds.y1) &&
    Number.isFinite(bounds.x2) &&
    Number.isFinite(bounds.y2) &&
    bounds.x2 > pageBounds.x1 &&
    bounds.x1 < pageBounds.x2 &&
    bounds.y2 > pageBounds.y1 &&
    bounds.y1 < pageBounds.y2
  );
}

function pageTopInContainer(container: HTMLElement, pageElement: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const pageRect = pageElement.getBoundingClientRect();
  return container.scrollTop + pageRect.top - containerRect.top;
}

function scrollContainerPaddingTop(container: HTMLElement) {
  const paddingTop = Number.parseFloat(getComputedStyle(container).paddingTop);
  return Number.isFinite(paddingTop) ? paddingTop : 0;
}

function measureScrollbarGutter(container: HTMLElement) {
  const hasHorizontalScrollbar = container.scrollWidth > container.clientWidth;
  const hasVerticalScrollbar = container.scrollHeight > container.clientHeight;

  return {
    block: hasHorizontalScrollbar
      ? Math.max(0, container.offsetHeight - container.clientHeight)
      : 0,
    inline: hasVerticalScrollbar
      ? Math.max(0, container.offsetWidth - container.clientWidth)
      : 0
  };
}

function clampZoom(value: number) {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}
