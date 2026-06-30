import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  forwardRef,
  useCallback,
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
  ReadOnlyBanner,
  ReadOnlyNotice,
  WorkspaceNoticeStack,
  type WorkspaceNotice
} from './components/WorkspaceNotices';
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
  assertAnnotationsTextIsSupported,
  mergePdfAfterPage,
  removePage,
  rotatePageClockwise,
  UnsupportedAnnotationTextError,
  writePdfAnnotations
} from './pdfWriter';
import { pdfRectToViewportRect, viewportPointToPdfPoint } from './pdfGeometry';
import {
  prepareImageStampFromClipboardItems,
  prepareImageStampFromFile
} from './imageImport';
import type { PreparedImageStamp } from './imageImport';
import { PDFJS_DOCUMENT_OPTIONS } from './pdfRender';
import {
  detectReadOnlyReason,
  type PdfWorkspaceReadOnlyReason
} from './pdfProtection';
import {
  canCreateOutputCopy,
  canEditReadOnlyCopy
} from './readOnlyPolicy';
import type {
  PdfDownloadTarget,
  PdfExternalLinkOpener,
  PdfImageFilePicker,
  PdfMergeFilePicker,
  PdfPrintTarget,
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
  PdfRect,
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
import { safePdfFileName } from '../fileNames';
import { uint8ArrayToArrayBuffer } from '../bytes';
import { appThemeStyle } from '../theme';
import type { AppTheme } from '../theme';

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const RENDER_RESOURCE_RELEASE_DELAY_MS = 500;
const MAX_HISTORY_ENTRIES = 20;
const MAX_DOCUMENT_HISTORY_ENTRIES = 5;
const MAX_DOCUMENT_HISTORY_ENTRY_BYTES = 96 * 1024 * 1024;
const MAX_DOCUMENT_HISTORY_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_WORKSPACE_CLASS = 'pdf-annotator--fullscreen';

// In-memory undo/redo only. This contains full PDF bytes and must not be
// persisted, logged or sent outside the host app.
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

export type PdfWorkspaceCloseRequest = {
  fileName: string;
  hasUnsavedChanges: boolean;
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

// Sensitive in-memory tab offload only. This contains full PDF bytes,
// annotation state, undo/redo history and host save targets, so it must not be
// logged, sent over a network, stored in browser storage or persisted to disk.
export type SensitivePdfWorkspaceSession = {
  activePageIndex: number;
  activeToolKey: string;
  annotations: PdfAnnotation[];
  cleanAnnotations: PdfAnnotation[];
  /** Full clean PDF bytes retained only for in-memory restore/save state. */
  cleanPdfBytes?: Uint8Array | null;
  cleanSignatureRefreshEnabled?: boolean;
  cleanWorkSignature: string;
  editingEnabled?: boolean;
  fileName: string;
  fileKey?: string;
  hasUnsavedChanges: boolean;
  importedAnnotationPageIndexes: number[];
  managedAnnotationPageIndexes: number[];
  /** Full open PDF bytes retained only for in-memory tab offloading. */
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
  // Captures a sensitive in-memory session for tab offloading. Hosts should keep
  // this short-lived and private, then discard it when the tab is closed.
  captureSessionForTabCache: () => SensitivePdfWorkspaceSession | null;
  downloadCopy: () => Promise<void>;
  print: () => Promise<void>;
  releaseRenderResources: () => Promise<void>;
  save: () => Promise<boolean>;
  saveAs: (suggestedName?: string) => Promise<boolean>;
};

type PendingExternalLink = {
  trustKey: string;
  url: string;
};

type PasswordRequest = {
  failed: boolean;
  generation: number;
  updatePassword: (password: string) => void;
};

export type PdfWorkspaceProps = {
  allowEditing?: boolean;
  allowImageAnnotations?: boolean;
  className?: string;
  confirmDiscardChanges?: (
    request: PdfWorkspaceCloseRequest
  ) => boolean | Promise<boolean>;
  enableGlobalShortcuts?: boolean;
  enableWheelZoom?: boolean;
  initialSession?: SensitivePdfWorkspaceSession | null;
  manageDocumentTitle?: boolean;
  onClose: () => void;
  onDirtyChange?: (hasUnsavedChanges: boolean) => void;
  onDocumentTitleChange?: (title: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onOpenExternalLink?: PdfExternalLinkOpener;
  pickMergePdfFile?: PdfMergeFilePicker;
  pickImageFile?: PdfImageFilePicker;
  printTarget?: PdfPrintTarget | null;
  readOnlyMessage?: string;
  showCloseButton?: boolean;
  source: PdfWorkspaceSource;
  style?: CSSProperties;
  theme?: AppTheme;
};

export const PdfWorkspace = forwardRef<PdfWorkspaceHandle, PdfWorkspaceProps>(
  function PdfWorkspace(
    {
      allowEditing = true,
      allowImageAnnotations = true,
      className = DEFAULT_WORKSPACE_CLASS,
      confirmDiscardChanges,
      enableGlobalShortcuts = true,
      enableWheelZoom = true,
      initialSession = null,
      manageDocumentTitle = true,
      onClose,
      onDirtyChange,
      onDocumentTitleChange,
      onBusyChange,
      onOpenExternalLink,
      pickMergePdfFile,
      pickImageFile,
      printTarget = null,
      readOnlyMessage,
      showCloseButton = true,
      source,
      style,
      theme
    },
    ref
  ) {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const pagesLayerRef = useRef<HTMLDivElement | null>(null);
  const lastUndoCommitTimeRef = useRef(0);
  const liveEditActiveRef = useRef(false);
  const finishLiveEditOnPointerUpRef = useRef(false);
  const pendingUndoSnapshotRef = useRef<{
    annotations: PdfAnnotation[];
    signature: string;
  } | null>(null);
  const annotationsByPageCacheRef = useRef<Map<number, PdfAnnotation[]>>(
    new Map()
  );
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
  const largeDocumentHistoryNoticeShownRef = useRef(false);
  const shouldImportAnnotationsRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const loadingTaskRef = useRef<ReturnType<typeof getDocument> | null>(null);
  const structureReloadInProgressRef = useRef(false);
  const pdfFingerprintRef = useRef('');
  const cleanWorkSignatureRef = useRef('');
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
  const externalLinkOpenButtonRef = useRef<HTMLButtonElement | null>(null);
  const noticeIdRef = useRef(0);
  const noticeTimersRef = useRef<Map<number, number>>(new Map());
  const downloadTargetRef = useRef<PdfDownloadTarget | null>(null);
  const saveAsTargetRef = useRef<PdfSaveAsTarget | null>(null);
  const saveTargetRef = useRef<PdfSaveTarget | null>(null);
  const fileKeyRef = useRef<string | null>(source.fileKey ?? null);
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
  const busyRef = useRef(false);
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
  const [workspaceNotices, setWorkspaceNotices] = useState<WorkspaceNotice[]>(
    []
  );
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
  const annotationsByPage = useMemo(
    () =>
      groupAnnotationsByPageStable(
        annotations,
        annotationsByPageCacheRef.current
      ),
    [annotations]
  );
  const currentWorkSignature = useMemo(
    () => createWorkSignature(pdfFingerprint, persistedAnnotations),
    [persistedAnnotations, pdfFingerprint]
  );
  const [cleanWorkSignature, setCleanWorkSignature] = useState('');
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
  const availableToolDefinitions = useMemo(
    () =>
      imageAnnotationsVisible
        ? tools
        : tools.filter((item) => item.tool !== 'imageStamp'),
    [imageAnnotationsVisible]
  );
  const workspaceTitle =
    pages.length > 0
      ? `${hasUnsavedChanges ? '*' : ''}${fileName}`
      : 'PDF Annotator';
  const workspaceStyle = useMemo(
    () =>
      ({
        ...appThemeStyle(theme),
        ...style,
        '--pdfa-scrollbar-block': `${scrollbarGutter.block}px`,
        '--pdfa-scrollbar-inline': `${scrollbarGutter.inline}px`
      }) as CSSProperties,
    [scrollbarGutter.block, scrollbarGutter.inline, style, theme]
  );
  activePageIndexRef.current = activePageIndex;
  annotationsRef.current = annotations;
  cleanWorkSignatureRef.current = cleanWorkSignature;
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

  function createWorkspaceSession(): SensitivePdfWorkspaceSession | null {
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
      fileKey: fileKeyRef.current ?? undefined,
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
    await cancelLoadingTask();
    await destroyPdfDocument(currentPdfDoc);
  }

  useImperativeHandle(
    ref,
    () => ({
      captureSessionForTabCache: createWorkspaceSession,
      downloadCopy: handleDownload,
      print: handlePrint,
      releaseRenderResources,
      save: handleSave,
      saveAs: saveAsDocument
    }),
    [
      activePageIndex,
      activeToolKey,
      annotations,
      cleanWorkSignature,
      editingEnabled,
      fileName,
      fileKeyRef.current,
      handleDownload,
      handlePrint,
      handleSave,
      saveAsDocument,
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
      undoStack
    ]
  );

  function dismissWorkspaceNotice(id: number) {
    const timer = noticeTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      noticeTimersRef.current.delete(id);
    }
    setWorkspaceNotices((current) =>
      current.filter((notice) => notice.id !== id)
    );
  }

  function showWorkspaceNotice(message: string, durationMs = 10000) {
    const id = noticeIdRef.current + 1;
    noticeIdRef.current = id;
    setWorkspaceNotices((current) => {
      const next: WorkspaceNotice[] = [];
      for (const notice of current) {
        if (notice.message === message) {
          const existingTimer = noticeTimersRef.current.get(notice.id);
          if (existingTimer !== undefined) {
            window.clearTimeout(existingTimer);
            noticeTimersRef.current.delete(notice.id);
          }
        } else {
          next.push(notice);
        }
      }
      next.push({ id, message });
      return next;
    });

    const timer = window.setTimeout(() => {
      noticeTimersRef.current.delete(id);
      setWorkspaceNotices((current) =>
        current.filter((notice) => notice.id !== id)
      );
    }, durationMs);
    noticeTimersRef.current.set(id, timer);
  }

  useEffect(() => {
    pdfDocRef.current = pdfDoc;
  }, [pdfDoc]);

  useEffect(
    () => () => {
      for (const timer of noticeTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      noticeTimersRef.current.clear();
    },
    []
  );

  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange]
  );

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (
        readOnly ||
        busyRef.current ||
        !initialVisualReadyRef.current ||
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
          item.kind === 'file' &&
          ['image/png', 'image/jpeg', 'image/webp'].includes(item.type)
      );
      const text = clipboardData.getData('text/plain');
      if (!hasSupportedImage && text.trim().length === 0) {
        return;
      }

      event.preventDefault();
      void handleClipboardPaste(clipboardData);
    }

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [imageAnnotationsVisible, readOnly]);

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
        finishCurrentAnnotationEditWithValidation();
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

      if (
        saveAvailable &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        void handleSave();
        return;
      }

      if (
        printAvailable &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'p'
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
    printAvailable,
    readOnly,
    redoStack,
    saveAvailable,
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
    if (busyRef.current) {
      return;
    }

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
    if (busyRef.current) {
      return;
    }

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

    const snapshot = {
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

    if (
      documentHistorySnapshotByteSize(snapshot) >
      MAX_DOCUMENT_HISTORY_ENTRY_BYTES
    ) {
      if (!largeDocumentHistoryNoticeShownRef.current) {
        largeDocumentHistoryNoticeShownRef.current = true;
        showWorkspaceNotice(
          'Page edit undo is limited for this large PDF to reduce memory use.'
        );
      }
      return null;
    }

    return snapshot;
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
    largeDocumentHistoryNoticeShownRef.current = false;
    pdfFingerprintRef.current = '';
    cleanPdfBytesRef.current = null;
    cleanSignatureRefreshEnabledRef.current = true;
    downloadTargetRef.current = null;
    saveAsTargetRef.current = null;
    saveTargetRef.current = null;
    fileKeyRef.current = null;
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
      setCurrentCleanWorkSignature('');
    }
  }

  function setCurrentCleanWorkSignature(signature: string) {
    cleanWorkSignatureRef.current = signature;
    setCleanWorkSignature(signature);
  }

  function setWorkspaceBusy(nextBusy: boolean) {
    busyRef.current = nextBusy;
    onBusyChange?.(nextBusy);
    setBusy(nextBusy);
  }

  function beginBusyOperation() {
    if (busyRef.current) {
      return false;
    }

    setWorkspaceBusy(true);
    return true;
  }

  function finishBusyOperation() {
    setWorkspaceBusy(false);
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
      setWorkspaceBusy(false);
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
    setWorkspaceBusy(true);
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
          hasUnsavedChanges
        });
      } catch (error) {
        console.error(error);
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
      await printTarget.print(printableBytes, printableName(fileName));
    } catch (error) {
      console.error(error);
      handlePreparationError(error);
      showWorkspaceNotice(
        preparationErrorNotice(error, 'Could not prepare this PDF for printing.')
      );
    } finally {
      finishBusyOperation();
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

  async function restoreWorkspaceSession(session: SensitivePdfWorkspaceSession) {
    await loadPdfBytes(session.pdfBytes, session.fileName, {
      activePage: session.viewPosition?.pageIndex ?? session.activePageIndex,
      clearWorkingAnnotations: false,
      restoredSession: session,
      downloadTarget: session.downloadTarget ?? source.downloadTarget ?? null,
      saveTarget: session.saveTarget ?? source.saveTarget ?? null,
      saveAsTarget: session.saveAsTarget ?? source.saveAsTarget ?? null,
      fileKey: session.fileKey ?? source.fileKey,
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
        setWorkspaceBusy(true);
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
        sourceId: nextSource.sourceId
      });

      if (
        mountedRef.current &&
        nextSource.markDirty &&
        sourceLoadRef.current === loadKey
      ) {
        cleanSignatureRefreshEnabledRef.current = false;
        setCurrentCleanWorkSignature(
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
      setWorkspaceBusy(false);
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
      restoredSession?: SensitivePdfWorkspaceSession | null;
      downloadTarget?: PdfDownloadTarget | null;
      fileKey?: string;
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
    setWorkspaceBusy(true);

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
      fileKeyRef.current =
        restoredSession?.fileKey ?? options.fileKey ?? null;
      downloadTargetRef.current = options.downloadTarget ?? null;
      saveAsTargetRef.current = options.saveAsTarget ?? null;
      const nextEditingEnabled =
        nextReadOnlyReason === 'password protected'
          ? false
          : restoredSession?.editingEnabled ?? false;
      const nextSaveTarget =
        nextReadOnlyReason && nextEditingEnabled
          ? null
          : options.saveTarget ?? null;
      saveTargetRef.current = nextSaveTarget;
      setReadOnlyReason(nextReadOnlyReason);
      setEditingEnabled(nextEditingEnabled);
      activePageIndexRef.current = activePage;
      setActivePageIndex(activePage);

      if (restoredSession) {
        cleanAnnotationsRef.current = restoredSession.cleanAnnotations.map(
          normalizeAnnotationLayout
        );
        setTool(restoredSession.tool);
        setActiveToolKey(
          tools.some((item) => item.key === restoredSession.activeToolKey)
            ? restoredSession.activeToolKey
            : defaultToolKeyForTool(restoredSession.tool)
        );
        setToolSettings(restoredSession.toolSettings);
        setToolPresets(restoredSession.toolPresets);
        setScale(restoredSession.scale);
        setShowAnnotations(restoredSession.showAnnotations);
        setSidebarOpen(restoredSession.sidebarOpen);
        setSidebarWidth(restoredSession.sidebarWidth);
        setTrustedExternalLinkKeys([]);
        cleanSignatureRefreshEnabledRef.current =
          restoredSession.cleanSignatureRefreshEnabled ?? true;
        setCurrentCleanWorkSignature(restoredSession.cleanWorkSignature);
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
        setCurrentCleanWorkSignature(createWorkSignature(nextPdfFingerprint, []));
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
          setWorkspaceBusy(false);
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
    let pendingPdf: PDFDocumentProxy | null = null;
    structureReloadInProgressRef.current = true;
    setWorkspaceBusy(true);

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
      setCurrentCleanWorkSignature(snapshot.cleanWorkSignature);
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
        setWorkspaceBusy(false);
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

  async function handleMergePdf() {
    if (
      busyRef.current ||
      readOnly ||
      !mergePdfVisible ||
      !pickMergePdfFile ||
      !pdfBytes ||
      pages.length === 0 ||
      !beginBusyOperation()
    ) {
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
    try {
      const mergeFile = await pickMergePdfFile();
      if (!mergeFile) {
        return;
      }

      const { bytes: nextBytes } = await mergePdfAfterPage(
        pdfBytes,
        mergeFile.bytes,
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
      finishBusyOperation();
    }
  }

  async function handleDeletePage(pageIndex = activePageIndex) {
    if (
      readOnly ||
      !pdfBytes ||
      pages.length <= 1 ||
      !beginBusyOperation()
    ) {
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
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
      finishBusyOperation();
    }
  }

  async function handleAddPage(
    pageIndex = activePageIndex,
    position: 'before' | 'after' = 'after',
    kind: 'blank' | 'lined' = 'blank'
  ) {
    if (readOnly || !pdfBytes || !beginBusyOperation()) {
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
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
      finishBusyOperation();
    }
  }

  async function handleRotatePage(pageIndex = activePageIndex) {
    if (
      readOnly ||
      !pdfBytes ||
      pages.length === 0 ||
      !beginBusyOperation()
    ) {
      return;
    }

    finishAnnotationEdit();
    const undoEntry = documentHistoryEntry();
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
      finishBusyOperation();
    }
  }

  function markCurrentWorkClean(cleanPdfBytes?: Uint8Array) {
    if (cleanPdfBytes) {
      cleanPdfBytesRef.current = cleanPdfBytes;
    }
    cleanSignatureRefreshEnabledRef.current = true;
    cleanAnnotationsRef.current = currentPersistedAnnotations().map(
      normalizeAnnotationLayout
    );
    const nextCleanSignature = createWorkSignature(
      pdfFingerprintRef.current,
      cleanAnnotationsRef.current
    );
    setCurrentCleanWorkSignature(nextCleanSignature);
  }

  function refreshCleanWorkSignatureFromImports() {
    if (!cleanSignatureRefreshEnabledRef.current) {
      return;
    }

    const nextCleanSignature = createWorkSignature(
      pdfFingerprintRef.current,
      cleanAnnotationsRef.current
    );
    setCurrentCleanWorkSignature(nextCleanSignature);
  }

  async function handleSave() {
    if (!pdfBytes || !beginBusyOperation()) {
      return false;
    }

    try {
      const saveTarget = saveTargetRef.current;

      if (saveTarget) {
        const savedBytes = await currentPdfOutputBytes();
        try {
          await saveTarget.save(savedBytes);
          markCurrentWorkClean(savedBytes);
          return true;
        } catch (error) {
          console.error(error);
          const saveAsResult = await savePdfAs(
            () => Promise.resolve(savedBytes),
            fileName
          );
          if (saveAsResult === 'saved') {
            return true;
          }
          if (saveAsResult === 'unavailable') {
            await downloadPdfBytes(savedBytes, annotatedName(fileName));
            showWorkspaceNotice('Failed to save. Downloaded a copy instead.');
          }
          return false;
        }
      }

      const saveAsResult = await saveCurrentPdfAs(fileName);
      if (saveAsResult === 'saved') {
        return true;
      }
      if (saveAsResult === 'unavailable') {
        const savedBytes = await currentPdfOutputBytes();
        await downloadPdfBytes(savedBytes, annotatedName(fileName));
        showWorkspaceNotice('Could not open Save As. Downloaded a copy instead.');
      }
      return false;
    } catch (error) {
      console.error(error);
      handlePreparationError(error);
      showWorkspaceNotice(
        preparationErrorNotice(error, 'Could not prepare this PDF for saving.')
      );
      return false;
    } finally {
      finishBusyOperation();
    }
  }

  async function handleSaveAs() {
    return saveAsDocument(fileName);
  }

  async function saveAsDocument(suggestedName = fileName) {
    if (!pdfBytes || !beginBusyOperation()) {
      return false;
    }

    try {
      const saveAsResult = await saveCurrentPdfAs(suggestedName);
      if (saveAsResult === 'saved') {
        return true;
      }
      return false;
    } catch (error) {
      console.error(error);
      handlePreparationError(error);
      showWorkspaceNotice(
        preparationErrorNotice(error, 'Could not prepare this PDF for saving.')
      );
      return false;
    } finally {
      finishBusyOperation();
    }
  }

  async function saveCurrentPdfAs(suggestedName = fileName) {
    validateCurrentPdfOutput();
    return savePdfAs(currentPdfOutputBytes, suggestedName);
  }

  async function savePdfAs(
    createBytes: () => Promise<Uint8Array>,
    suggestedName = fileName
  ) {
    const saveAsTarget = saveAsTargetRef.current;
    if (!saveAsTarget) {
      return 'unavailable' as const;
    }

    let result;
    try {
      result = await saveAsTarget.saveAs(
        createBytes,
        safePdfFileName(suggestedName)
      );
    } catch (error) {
      if (error instanceof UnsupportedAnnotationTextError) {
        throw error;
      }
      console.error(error);
      return 'unavailable' as const;
    }
    if (!result) {
      return 'cancelled' as const;
    }

    saveTargetRef.current = result.saveTarget ?? null;
    fileKeyRef.current = result.fileKey ?? fileKeyRef.current;
    if (result.fileName) {
      setFileName(result.fileName);
    }
    markCurrentWorkClean(result.bytes);
    return 'saved' as const;
  }

  async function handleDownload() {
    if (!pdfBytes || !beginBusyOperation()) {
      return;
    }

    try {
      const savedBytes = await currentPdfOutputBytes();
      const outputName = annotatedName(fileName);
      await downloadPdfBytes(savedBytes, outputName);
    } catch (error) {
      console.error(error);
      handlePreparationError(error);
      showWorkspaceNotice(
        preparationErrorNotice(error, 'Could not download a copy of this PDF.')
      );
    } finally {
      finishBusyOperation();
    }
  }

  async function currentPdfOutputBytes() {
    if (!pdfBytes) {
      throw new Error('No PDF is open.');
    }

    const outputAnnotations = validateCurrentPdfOutput();

    if (hasCurrentUnsavedChanges()) {
      return annotatedPdfBytes(outputAnnotations);
    }

    return cleanPdfBytesRef.current ?? pdfBytes;
  }

  function currentPersistedAnnotations() {
    return annotationsRef.current.filter(hasAnnotationContent);
  }

  function hasCurrentUnsavedChanges() {
    const currentSignature = createWorkSignature(
      pdfFingerprintRef.current,
      currentPersistedAnnotations()
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
      await target.download(bytes, safePdfFileName(suggestedName));
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
        cleanAnnotationsRef.current
      )
    };
  }

  function validateCurrentPdfOutput() {
    const outputAnnotations = currentOutputAnnotations();
    assertAnnotationsTextIsSupported(outputAnnotations.annotationsToWrite);
    return outputAnnotations;
  }

  async function annotatedPdfBytes(
    outputAnnotations = currentOutputAnnotations()
  ) {
    if (!pdfBytes) {
      throw new Error('No PDF is open.');
    }

    const { annotationsForOutput, annotationsToWrite } = outputAnnotations;
    const replacePageIndexes = annotationReplacementPageIndexes(
      managedAnnotationPagesRef.current,
      annotationsForOutput
    );
    const replaceAnnotationSourceIds = annotationSourceIdsForReplacement(
      annotationsToWrite,
      removedAnnotationSourceIdsRef.current,
      annotationsForOutput,
      annotationsRef.current
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
      : writePdfAnnotations(pdfBytes, [], {
          removeAllAnnotations: true
        });
  }

  function handleAddAnnotation(annotation: PdfAnnotation) {
    if (readOnly || busyRef.current) {
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
    try {
      const file = await pickImageFile();
      if (file) {
        await handleAddImageFromFile(file);
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function handleClipboardPaste(clipboardData: DataTransfer) {
    if (readOnly || busyRef.current) {
      return;
    }

    if (imageAnnotationsVisible) {
      const image = await prepareImageStampFromClipboardItems(
        clipboardData.items
      ).catch((error) => {
        console.error(error);
        return null;
      });
      if (image) {
        addPreparedImageAnnotationFromData(image);
        return;
      }
    }

    const text = clipboardData.getData('text/plain');
    if (text.trim()) {
      addTextAnnotationForActivePage(text);
    }
  }

  async function addPreparedImageAnnotation(
    prepareImage: () => Promise<PreparedImageStamp>
  ) {
    if (
      readOnly ||
      !imageAnnotationsVisible ||
      busyRef.current ||
      !beginBusyOperation()
    ) {
      return;
    }

    try {
      const preparedImage = await prepareImage();
      addPreparedImageAnnotationFromData(preparedImage);
    } catch (error) {
      console.error(error);
      throw error;
    } finally {
      finishBusyOperation();
    }
  }

  function addPreparedImageAnnotationFromData(preparedImage: PreparedImageStamp) {
    if (readOnly || !imageAnnotationsVisible) {
      return;
    }

    const annotation = imageStampAnnotationForActivePage(preparedImage);
    if (!annotation) {
      return;
    }

    managedAnnotationPagesRef.current.add(annotation.pageIndex);
    setShowAnnotations(true);
    commitAnnotations(
      (current) => [...current, annotation],
      { assumeChanged: true }
    );
    setSelectedAnnotationIds([annotation.id]);
    setFocusedAnnotationId(null);
    setTool('select');
    setActiveToolKey(defaultToolKeyForTool('select'));
    setSettingsToolKey(null);
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
    setShowAnnotations(true);
    commitAnnotations(
      (current) => [...current, normalizeAnnotationLayout(annotation)],
      { assumeChanged: true }
    );
    setSelectedAnnotationIds([annotation.id]);
    setFocusedAnnotationId(null);
    setTool('select');
    setActiveToolKey(defaultToolKeyForTool('select'));
    setSettingsToolKey(null);
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
      (pageHeight * 0.6) / Math.max(1, naturalHeight)
    );
    const width = Math.max(12, naturalWidth * fitScale);
    const height = Math.max(12, naturalHeight * fitScale);
    const center = activePageVisibleCenter(pageIndex, viewport) ?? {
      x: pageBounds.x1 + pageWidth / 2,
      y: pageBounds.y1 + pageHeight / 2
    };
    const rect: PdfRect = {
      x1: clamp(center.x - width / 2, pageBounds.x1, pageBounds.x2 - width),
      x2: clamp(center.x - width / 2, pageBounds.x1, pageBounds.x2 - width) + width,
      y1: clamp(center.y - height / 2, pageBounds.y1, pageBounds.y2 - height),
      y2: clamp(center.y - height / 2, pageBounds.y1, pageBounds.y2 - height) + height
    };

    return {
      id: crypto.randomUUID(),
      imageData: image.data,
      heightPx: image.heightPx,
      kind: 'imageStamp',
      mimeType: image.mimeType,
      pageIndex,
      rect,
      widthPx: image.widthPx
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
      y: pageBounds.y1 + pageHeight / 2
    };
    const x1 = clamp(
      center.x - width / 2,
      pageBounds.x1,
      pageBounds.x2 - width
    );
    const y2 = clamp(
      center.y + height / 2,
      pageBounds.y1 + height,
      pageBounds.y2
    );

    return {
      id: crypto.randomUUID(),
      kind: 'freeText',
      pageIndex,
      rect: {
        x1,
        x2: x1 + width,
        y1: y2 - height,
        y2
      },
      text,
      fontSize: toolSettings.textFontSize,
      color: toolSettings.textColor,
      opacity: toolSettings.textOpacity
    } satisfies PdfAnnotation;
  }

  function activePageVisibleCenter(
    pageIndex: number,
    viewport: PageViewport
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
      (((visibleLeft + visibleRight) / 2 - pageBounds.left) *
        viewport.width) /
        Math.max(1, pageBounds.width),
      (((visibleTop + visibleBottom) / 2 - pageBounds.top) *
        viewport.height) /
        Math.max(1, pageBounds.height),
      viewport
    );
  }

  function updateAnnotation(
    id: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options: { recordUndo?: boolean } = {}
  ) {
    if (readOnly || busyRef.current) {
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

  function updateAnnotations(
    ids: string[],
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options: { recordUndo?: boolean } = {}
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
            : annotation
        ),
      options.recordUndo === false
        ? { assumeChanged: true, recordUndo: false }
        : { assumeChanged: true, coalesce: true }
    );
  }

  function deleteSelectedAnnotations() {
    if (readOnly || busyRef.current || selectedAnnotationIds.length === 0) {
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
    if (
      readOnly ||
      busyRef.current ||
      (deleteIds.length === 0 && pathUpdates.length === 0)
    ) {
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
    finishCurrentAnnotationEditWithValidation();

    setSelectedAnnotationIds(annotationIds);
    setFocusedAnnotationId(null);
  }

  function finishCurrentAnnotationEditWithValidation() {
    if (focusedAnnotationId) {
      handleFocusAnnotationConsumed(focusedAnnotationId);
      return;
    }

    warnUnsupportedTextInAnnotations(selectedAnnotationIds);
    finishAnnotationEdit();
  }

  function warnUnsupportedTextInAnnotations(annotationIds: string[]) {
    if (annotationIds.length === 0) {
      return;
    }

    const selectedIds = new Set(annotationIds);
    const annotationsToCheck = annotationsRef.current.filter((annotation) =>
      selectedIds.has(annotation.id)
    );

    if (annotationsToCheck.length === 0) {
      return;
    }

    try {
      assertAnnotationsTextIsSupported(annotationsToCheck);
    } catch (error) {
      if (error instanceof UnsupportedAnnotationTextError) {
        showWorkspaceNotice(error.message);
        return;
      }
      throw error;
    }
  }

  function handleFocusAnnotationConsumed(annotationId: string) {
    const annotation = annotationsRef.current.find(
      (item) => item.id === annotationId
    );

    if (annotation && !hasAnnotationContent(annotation)) {
      setFocusedAnnotationId((current) =>
        current === annotationId ? null : current
      );
      deleteAnnotations([annotationId]);
      finishAnnotationEdit();
      return;
    }

    if (annotation) {
      try {
        assertAnnotationsTextIsSupported([annotation]);
      } catch (error) {
        if (error instanceof UnsupportedAnnotationTextError) {
          setShowAnnotations(true);
          setSelectedAnnotationIds([annotation.id]);
          setFocusedAnnotationId((current) =>
            current === annotationId ? null : current
          );
          finishAnnotationEdit();
          showWorkspaceNotice(error.message);
          return;
        }
        throw error;
      }
    }

    setFocusedAnnotationId((current) =>
      current === annotationId ? null : current
    );
    finishAnnotationEdit();
  }

  function rememberRemovedAnnotationSource(annotation: PdfAnnotation) {
    if (annotation.sourceId) {
      removedAnnotationSourceIdsRef.current.add(annotation.sourceId);
    }
  }

  function updateToolSettings(update: Partial<ToolSettings>) {
    if (readOnly || busyRef.current) {
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
    if (readOnly || busyRef.current) {
      return;
    }

    const item = tools.find((candidate) => candidate.key === toolKey);
    if (!item) {
      return;
    }

    window.getSelection()?.removeAllRanges();
    finishCurrentAnnotationEditWithValidation();
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
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
    if (busyRef.current) {
      return;
    }

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

  function handlePreparationError(error: unknown) {
    if (!(error instanceof UnsupportedAnnotationTextError)) {
      return;
    }

    const annotation = annotationsRef.current.find(
      (candidate) => candidate.id === error.annotationId
    );

    if (!annotation) {
      void navigateToPage(error.pageIndex, { block: 'center' });
      return;
    }

    setShowAnnotations(true);
    setTool('select');
    setActiveToolKey('select');
    setSettingsToolKey(null);
    setSelectedAnnotationIds([annotation.id]);
    setFocusedAnnotationId(null);
    if (annotation.kind === 'freeText' || annotation.kind === 'stickyNote') {
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

  async function navigateToAnnotation(annotation: PdfAnnotation) {
    const targetPageIndex = clamp(annotation.pageIndex, 0, pages.length - 1);
    activePageIndexRef.current = targetPageIndex;
    setActivePageIndex(targetPageIndex);
    const page = await ensurePageLoaded(targetPageIndex);
    window.requestAnimationFrame(() =>
      scrollToAnnotation(annotation, {
        fallbackPage: page
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
          const movedAnnotation = moveAnnotation(
            { ...annotation, pageIndex: targetPageIndex },
            delta
          );

          if (movedBetweenPages && movedAnnotation.sourceId) {
            rememberRemovedAnnotationSource(annotation);
            // A PDF annotation object belongs to its original page. After a
            // cross-page move, save a fresh annotation on the target page so
            // deleting the source page cannot drop the moved annotation.
            return normalizeAnnotationLayout({
              ...movedAnnotation,
              sourceId: undefined
            });
          }

          return normalizeAnnotationLayout(movedAnnotation);
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
    if (busyRef.current) {
      return;
    }

    if (showAnnotations) {
      finishCurrentAnnotationEditWithValidation();
    }

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
    if (!canEditReadOnlyCopy(readOnlyReason)) {
      return;
    }

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

    if (block === 'start') {
      container.scrollTo({
        behavior: 'auto',
        top:
          pageTopInContainer(container, pageElement) -
          scrollContainerPaddingTop(container)
      });
      return;
    }

    pageElement.scrollIntoView({ block });
  }

  function scrollToAnnotation(
    annotation: PdfAnnotation,
    { fallbackPage }: { fallbackPage: PDFPageProxy | null }
  ) {
    const container = scrollContainerRef.current;
    const pageElement = container?.querySelector<HTMLElement>(
      `[data-page-index="${annotation.pageIndex}"]`
    );
    if (!container || !pageElement || !fallbackPage) {
      scrollToPage(annotation.pageIndex, {
        block: 'center',
        page: fallbackPage
      });
      return;
    }

    const viewport = fallbackPage.getViewport({ scale });
    const annotationRect = pdfRectToViewportRect(
      annotationBounds(annotation),
      viewport
    );
    if (!Number.isFinite(annotationRect.y)) {
      scrollToPage(annotation.pageIndex, {
        block: 'center',
        page: fallbackPage
      });
      return;
    }

    const pageTop = pageTopInContainer(container, pageElement);
    const noticeStack = container
      .closest('.pdf-annotator')
      ?.querySelector<HTMLElement>('.workspace-notice-stack');
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
      behavior: 'auto',
      top: Math.max(0, Math.min(preferredTop, centeredTop))
    });
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
      aria-busy={busy ? 'true' : undefined}
      className={['pdf-annotator', className].filter(Boolean).join(' ')}
      data-busy={busy ? 'true' : undefined}
      style={workspaceStyle}
    >
      {initialVisualReady && pages.length > 0 ? (
        <DocumentSidebar
          activePageIndex={activePageIndex}
          annotationsByPage={annotationsByPage}
          busy={busy}
          canMergePdf={mergePdfVisible}
          onAddPage={handleAddPage}
          onClose={() => setSidebarOpen(false)}
          onDeletePage={handleDeletePage}
          onMergePdf={() => void handleMergePdf()}
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
            disabled={busy}
            onClick={() => setSidebarOpen(true)}
            title="Show sidebar"
            type="button"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      ) : null}

      {initialVisualReady &&
      (workspaceNotices.length > 0 ||
        (readOnly && (readOnlyMessage || readOnlyReason))) ? (
        <WorkspaceNoticeStack
          notices={workspaceNotices}
          onDismissNotice={dismissWorkspaceNotice}
        >
          {readOnly && readOnlyMessage ? (
            <ReadOnlyNotice message={readOnlyMessage} />
          ) : readOnly && readOnlyReason ? (
            <ReadOnlyBanner
              canEditCopy={canEditReadOnlyCopy(readOnlyReason)}
              onEnableEditing={handleEnableEditing}
              reason={readOnlyReason}
            />
          ) : null}
        </WorkspaceNoticeStack>
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
                    onUpdateAnnotations={updateAnnotations}
                    page={page}
                    pageCount={pages.length}
                    pageIndex={index}
                    readOnly={readOnly || busy}
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
              disabled={busy}
              onChangeSettings={updateToolSettings}
              onCloseSettings={() => setSettingsToolKey(null)}
              onPickImageFile={() => void handlePickImageFile()}
              onSelectTool={selectToolbarTool}
              onToggleSettings={(nextToolKey) =>
                setSettingsToolKey((current) =>
                  current === nextToolKey ? null : nextToolKey
                )
              }
              settings={toolSettings}
              settingsToolKey={settingsToolKey}
              toolDefinitions={availableToolDefinitions}
              toolPresets={toolPresets}
            />
          ) : null}

          <FloatingDocumentControls
            busy={busy}
            onClosePdf={handleClosePdf}
            onDownload={downloadAvailable ? handleDownload : undefined}
            onPrint={printAvailable ? handlePrint : undefined}
            onSave={saveAvailable ? handleSave : undefined}
            onSaveAs={saveAsAvailable ? handleSaveAs : undefined}
            saveLabel="Save"
            onToggleAnnotations={handleToggleAnnotations}
            showCloseButton={showCloseButton}
            showAnnotations={showAnnotations}
          />

          <FloatingZoomControls
            activePageIndex={activePageIndex}
            disabled={busy}
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
              disabled={busy}
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

function downloadPdf(bytes: Uint8Array, name: string) {
  const blob = new Blob([uint8ArrayToArrayBuffer(bytes)], {
    type: 'application/pdf'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safePdfFileName(name);
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

function preparationErrorNotice(error: unknown, fallback: string) {
  return error instanceof UnsupportedAnnotationTextError
    ? error.message
    : fallback;
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
    } else if (annotation.kind === 'imageStamp') {
      sourceIds.add(annotation.id);
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

function groupAnnotationsByPageStable(
  annotations: PdfAnnotation[],
  previousByPage: Map<number, PdfAnnotation[]>
) {
  const grouped = groupAnnotationsByPage(annotations);
  for (const [pageIndex, pageAnnotations] of grouped) {
    const previousPageAnnotations = previousByPage.get(pageIndex);
    if (
      previousPageAnnotations &&
      annotationArraysEqual(previousPageAnnotations, pageAnnotations)
    ) {
      grouped.set(pageIndex, previousPageAnnotations);
    }
  }

  previousByPage.clear();
  for (const [pageIndex, pageAnnotations] of grouped) {
    previousByPage.set(pageIndex, pageAnnotations);
  }
  return grouped;
}

function annotationArraysEqual(
  left: PdfAnnotation[],
  right: PdfAnnotation[]
) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((annotation, index) => annotation === right[index]);
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

function documentHistorySnapshotByteSize(
  snapshot: PdfWorkspaceDocumentHistorySnapshot
) {
  const byteArrays = new Set<Uint8Array>();
  byteArrays.add(snapshot.pdfBytes);
  if (snapshot.cleanPdfBytes) {
    byteArrays.add(snapshot.cleanPdfBytes);
  }
  return Array.from(byteArrays).reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  );
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

function isTextEntryTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""]'
      )
    )
  );
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
