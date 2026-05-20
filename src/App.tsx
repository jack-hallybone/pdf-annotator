import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FilePlus2,
  FolderOpen
} from 'lucide-react';
import { getDocument } from 'pdfjs-dist';
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
import { DocumentSidebar } from './components/DocumentSidebar';
import {
  FloatingDocumentControls,
  FloatingHistoryControls,
  FloatingToolDock,
  FloatingZoomControls,
  PageLoadNotice
} from './components/FloatingControls';
import { PdfPageView } from './PdfPageView';
import {
  addBlankPageAt,
  mergePdfAfterPage,
  removePage,
  rotatePageClockwise,
  writePdfAnnotations
} from './pdfWriter';
import { PDFJS_DOCUMENT_OPTIONS } from './pdfRender';
import {
  canPickLocalPdfFile,
  localPdfFileFromDrop,
  pickLocalPdfFile,
  savePdfToLocalFile
} from './localFileAccess';
import type { LocalPdfFileHandle } from './localFileAccess';
import { readPdfFile } from './pdfFile';
import {
  createPdfTemplate
} from './pdfTemplates';
import type { PdfTemplateKind } from './pdfTemplates';
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
  PageSize,
  PdfAnnotation,
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
const PDF_TEMPLATES: Array<{ kind: PdfTemplateKind; label: string }> = [
  { kind: 'a4Blank', label: 'A4 blank' },
  { kind: 'a4Lined', label: 'A4 lined' },
  { kind: 'a4Cornell', label: 'A4 Cornell' }
];

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mergeFileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const lastUndoCommitTimeRef = useRef(0);
  const liveEditActiveRef = useRef(false);
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
  const cleanAnnotationsRef = useRef<PdfAnnotation[]>([]);
  const pendingZoomAnchorRef = useRef<{
    offsetRatio: number;
    pageIndex: number;
  } | null>(null);
  const activePageIndexRef = useRef(0);
  const printBlobUrlRef = useRef<string | null>(null);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);
  const localFileHandleRef = useRef<LocalPdfFileHandle | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFingerprint, setPdfFingerprint] = useState('');
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<LoadedPage[]>([]);
  const [pageSize, setPageSize] = useState<PageSize | null>(null);
  const [fileName, setFileName] = useState('document.pdf');
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
  const [undoStack, setUndoStack] = useState<PdfAnnotation[][]>([]);
  const [redoStack, setRedoStack] = useState<PdfAnnotation[][]>([]);
  const [status, setStatus] = useState('Open a PDF to begin.');
  const [busy, setBusy] = useState(false);
  const [loadingPageCount, setLoadingPageCount] = useState(0);
  const [pdfDragActive, setPdfDragActive] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [settingsToolKey, setSettingsToolKey] = useState<string | null>(null);
  const [pageMenuIndex, setPageMenuIndex] = useState<number | null>(null);
  const persistedAnnotations = annotations.filter(hasAnnotationContent);
  const annotationsByPage = useMemo(
    () => groupAnnotationsByPage(annotations),
    [annotations]
  );
  const currentWorkSignature = useMemo(
    () => createWorkSignature(pdfFingerprint, annotations),
    [annotations, pdfFingerprint]
  );
  const [cleanWorkSignature, setCleanWorkSignature] = useState('');
  const hasUnsavedChanges =
    Boolean(pdfBytes) &&
    cleanWorkSignature.length > 0 &&
    currentWorkSignature !== cleanWorkSignature;
  const loadedPageCount = pages.filter(Boolean).length;
  const showPageLoadNotice =
    pages.length > EAGER_PAGE_LIMIT &&
    loadingPageCount > 0 &&
    loadedPageCount > 0 &&
    loadedPageCount < pages.length;
  activePageIndexRef.current = activePageIndex;
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

  useEffect(() => {
    document.title =
      pages.length > 0
        ? `${hasUnsavedChanges ? '*' : ''}${fileName}`
        : 'PDF Annotator';
  }, [fileName, hasUnsavedChanges, pages.length]);

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
    const cleanup = () => {
      try {
        page.cleanup();
      } catch (error) {
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
    if (!hasUnsavedChanges) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

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
        (container.scrollTop - pageTop) / Math.max(1, anchorPage.offsetHeight),
      pageIndex: activePageIndex
    };
  }

  function fitZoomToPageWidth() {
    const container = scrollContainerRef.current;
    const page = activePageBaseSize();
    if (!container || !page) {
      return;
    }

    const availableWidth =
      container.clientWidth - 32 - (sidebarOpen ? sidebarWidth + 24 : 0);
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
      top: pageTop + anchor.offsetRatio * anchorPage.offsetHeight,
      behavior: 'auto'
    });
  }, [pages.length, scale]);

  useEffect(() => {
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

      if (event.key === 'Delete' && selectedAnnotationIds.length > 0) {
        event.preventDefault();
        deleteSelectedAnnotations();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undoAnnotations();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoAnnotations();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    annotations,
    focusedAnnotationId,
    hasUnsavedChanges,
    pages.length,
    redoStack,
    selectedAnnotationIds,
    undoStack
  ]);

  useEffect(() => {
    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();
      updateZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    }

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

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
    if (!pdfDoc || pages.length === 0) {
      return;
    }

    const start = Math.max(0, activePageIndex - LAZY_PAGE_BUFFER);
    const end = Math.min(pages.length - 1, activePageIndex + LAZY_PAGE_BUFFER);
    for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
      void ensurePageLoaded(pageIndex);
    }
  }, [activePageIndex, pages.length, pdfDoc]);

  useEffect(() => {
    function endLiveEdit() {
      liveEditActiveRef.current = false;
    }

    window.addEventListener('pointerup', endLiveEdit, true);
    window.addEventListener('blur', endLiveEdit);
    return () => {
      window.removeEventListener('pointerup', endLiveEdit, true);
      window.removeEventListener('blur', endLiveEdit);
    };
  }, []);

  function commitAnnotations(
    updater: (current: PdfAnnotation[]) => PdfAnnotation[],
    options: { coalesce?: boolean; recordUndo?: boolean } = {}
  ) {
    if (options.recordUndo === false) {
      setAnnotations((current) => updater(current));
      return;
    }

    setAnnotations((current) => {
      const now = Date.now();
      const shouldCoalesce =
        options.coalesce &&
        now - lastUndoCommitTimeRef.current < 600;

      setUndoStack((stack) =>
        shouldCoalesce && stack.length > 0 ? stack : [...stack, current]
      );
      lastUndoCommitTimeRef.current = now;
      setRedoStack([]);
      return updater(current);
    });
  }

  function beginAnnotationEdit() {
    if (liveEditActiveRef.current) {
      return;
    }
    liveEditActiveRef.current = true;
    setUndoStack((stack) => [...stack, annotations]);
    setRedoStack([]);
    lastUndoCommitTimeRef.current = Date.now();
  }

  function undoAnnotations() {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (!previous) {
        return stack;
      }

      setRedoStack((redo) => [...redo, annotations]);
      setAnnotations(previous);
      setSelectedAnnotationIds([]);
      setFocusedAnnotationId(null);
      lastUndoCommitTimeRef.current = 0;
      return stack.slice(0, -1);
    });
  }

  function redoAnnotations() {
    setRedoStack((stack) => {
      const next = stack.at(-1);
      if (!next) {
        return stack;
      }

      setUndoStack((undo) => [...undo, annotations]);
      setAnnotations(next);
      setSelectedAnnotationIds([]);
      setFocusedAnnotationId(null);
      lastUndoCommitTimeRef.current = 0;
      return stack.slice(0, -1);
    });
  }

  function resetPdfState({
    clearAnnotations = true,
    clearFileInfo = true
  }: {
    clearAnnotations?: boolean;
    clearFileInfo?: boolean;
  } = {}) {
    pagesRef.current = [];
    loadingPagesRef.current.clear();
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
    importedAnnotationPagesRef.current.clear();
    liveEditActiveRef.current = false;
    structureReloadInProgressRef.current = false;
    removedAnnotationSourceIdsRef.current.clear();
    pdfFingerprintRef.current = '';
    localFileHandleRef.current = null;
    setPdfBytes(null);
    setPdfFingerprint('');
    setPdfDoc(null);
    setPages([]);
    setPageSize(null);
    setScale(ACTUAL_SIZE_ZOOM);
    activePageIndexRef.current = 0;
    setActivePageIndex(0);
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(null);
    setShowAnnotations(true);
    setPageMenuIndex(null);
    setSettingsToolKey(null);
    setSidebarOpen(false);
    setLoadingPageCount(0);
    cleanupPrintResources();

    if (clearFileInfo) {
      setFileName('document.pdf');
      document.title = 'PDF Annotator';
    }

    if (clearAnnotations) {
      cleanAnnotationsRef.current = [];
      managedAnnotationPagesRef.current.clear();
      setAnnotations([]);
      setUndoStack([]);
      setRedoStack([]);
      setCleanWorkSignature('');
    }
  }

  async function destroyPdfDocument(doc: PDFDocumentProxy | null) {
    try {
      await doc?.destroy();
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

  function confirmDiscardUnsavedChanges() {
    return (
      !hasUnsavedChanges ||
      window.confirm('You have unsaved changes. Close this PDF and discard them?')
    );
  }

  async function handleClosePdf() {
    if (!confirmDiscardUnsavedChanges()) {
      return;
    }

    const currentPdfDoc = pdfDoc;
    loadGenerationRef.current += 1;
    shouldImportAnnotationsRef.current = true;
    resetPdfState();
    setTool('select');
    setActiveToolKey('select');
    setBusy(false);
    setStatus('Open a PDF to begin.');
    await cancelLoadingTask();
    await destroyPdfDocument(currentPdfDoc);
  }

  async function handlePrint() {
    if (!pdfBytes || pages.length === 0) {
      return;
    }

    setBusy(true);
    setStatus('Preparing printable PDF...');

    try {
      const printableBytes = await printablePdfBytes();
      setStatus('Opening browser print dialog...');
      void printPdfInFrame(printableBytes, printableName(fileName))
        .then(() => setStatus('Opened browser print dialog.'))
        .catch((error) => {
          console.error(error);
          setStatus(
            error instanceof Error ? error.message : 'Could not print PDF.'
          );
        });
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not print PDF.');
    } finally {
      setBusy(false);
    }
  }

  async function loadPdfBytes(
    bytes: Uint8Array,
    name: string,
    options: {
      activePage?: number;
      clearWorkingAnnotations?: boolean;
      fileHandle?: LocalPdfFileHandle | null;
    } = {}
  ) {
    const currentPdfDoc = pdfDoc;
    const generation = loadGenerationRef.current + 1;
    const nextPdfFingerprint = byteFingerprint(bytes);
    loadGenerationRef.current = generation;
    shouldImportAnnotationsRef.current = true;
    resetPdfState({
      clearAnnotations: options.clearWorkingAnnotations ?? true,
      clearFileInfo: false
    });
    setBusy(true);
    setStatus('Loading PDF...');

    try {
      await cancelLoadingTask();
      await destroyPdfDocument(currentPdfDoc);
      const loadingTask = getDocument({
        ...PDFJS_DOCUMENT_OPTIONS,
        data: bytes.slice()
      });
      loadingTaskRef.current = loadingTask;
      const loadedPdf = await loadingTask.promise;
      if (loadingTaskRef.current === loadingTask) {
        loadingTaskRef.current = null;
      }
      if (generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        return;
      }

      const activePage = Math.min(
        options.activePage ?? 0,
        loadedPdf.numPages - 1
      );
      const firstPage = await loadedPdf.getPage(activePage + 1);
      if (generation !== loadGenerationRef.current) {
        await destroyPdfDocument(loadedPdf);
        return;
      }

      const firstViewport = firstPage.getViewport({ scale: 1 });
      const initialPages = Array<LoadedPage>(loadedPdf.numPages).fill(null);
      initialPages[activePage] = firstPage;
      pagesRef.current = initialPages;
      markPageAccess(activePage);

      pdfFingerprintRef.current = nextPdfFingerprint;
      setPdfBytes(bytes);
      setPdfFingerprint(nextPdfFingerprint);
      setPdfDoc(loadedPdf);
      setPageSize({
        width: firstViewport.width,
        height: firstViewport.height
      });
      setPages(initialPages);
      setFileName(name);
      localFileHandleRef.current = options.fileHandle ?? null;
      activePageIndexRef.current = activePage;
      setActivePageIndex(activePage);

      if (options.clearWorkingAnnotations ?? true) {
        setTool('select');
        setActiveToolKey('select');
        cleanAnnotationsRef.current = [];
        setCleanWorkSignature(createWorkSignature(nextPdfFingerprint, []));
        setAnnotations([]);
        setSelectedAnnotationIds([]);
        setFocusedAnnotationId(null);
        setUndoStack([]);
        setRedoStack([]);
      }

      await importAnnotationsForLoadedPage(firstPage, activePage, generation);

      const remainingPageIndexes = Array.from(
        { length: loadedPdf.numPages },
        (_, index) => index
      ).filter((pageIndex) => pageIndex !== activePage);

      if (remainingPageIndexes.length === 0) {
        setStatus(`${name} loaded with ${loadedPdf.numPages} page(s).`);
        return;
      }

      if (loadedPdf.numPages <= EAGER_PAGE_LIMIT) {
        setStatus(
          `${name} opened. Loading remaining ${loadedPdf.numPages - 1} page(s) after the visible page.`
        );
        scheduleAfterVisiblePaint(() => {
          if (generation !== loadGenerationRef.current) {
            return;
          }

          void loadPagesEagerly(remainingPageIndexes, loadedPdf, generation)
            .then(() => {
              if (generation === loadGenerationRef.current) {
                setStatus(`${name} loaded with ${loadedPdf.numPages} page(s).`);
              }
            })
            .catch((error) => {
              if (generation === loadGenerationRef.current) {
                console.error(error);
              }
            });
        });
        return;
      }

      setStatus(
        `${name} opened in lazy mode. Pages load as you scroll.`
      );
    } catch (error) {
      if (generation === loadGenerationRef.current) {
        console.error(error);
        setStatus(error instanceof Error ? error.message : 'Could not load PDF.');
      }
    } finally {
      if (generation === loadGenerationRef.current) {
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
    shouldImportAnnotationsRef.current = true;
    importedAnnotationPagesRef.current.clear();
    loadingPagesRef.current.clear();
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
    setLoadingPageCount(0);
    cleanupPrintResources();

    let pendingPdf: PDFDocumentProxy | null = null;
    structureReloadInProgressRef.current = true;
    try {
      await cancelLoadingTask();
      const loadingTask = getDocument({
        ...PDFJS_DOCUMENT_OPTIONS,
        data: bytes.slice()
      });
      loadingTaskRef.current = loadingTask;
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
        scheduleAfterVisiblePaint(() => {
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
    setLoadingPageCount(loadingPagesRef.current.size);
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
      setLoadingPageCount(loadingPagesRef.current.size);
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
    setLoadingPageCount(loadingPagesRef.current.size);

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
      setLoadingPageCount(loadingPagesRef.current.size);
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
    setCleanWorkSignature(
      createWorkSignature(pdfFingerprintRef.current, cleanAnnotationsRef.current)
    );
    setAnnotations((current) =>
      mergeImportedAnnotations(current, importedAnnotations)
    );
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
    setCleanWorkSignature(
      createWorkSignature(pdfFingerprintRef.current, cleanAnnotationsRef.current)
    );
    setAnnotations((current) => mergeImportedAnnotations(current, importedAnnotations));
  }

  async function handleOpenPdfRequest() {
    if (pages.length > 0) {
      setStatus('Close the current PDF before opening another PDF.');
      return;
    }

    if (!canPickLocalPdfFile()) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const picked = await pickLocalPdfFile();
      if (!picked) {
        return;
      }

      await openPdfFile(picked.file, picked.handle);
    } catch (error) {
      console.error(error);
      setStatus('Could not use local file access. Falling back to browser open.');
      fileInputRef.current?.click();
    }
  }

  async function openPdfFile(
    file: File,
    fileHandle: LocalPdfFileHandle | null = null
  ) {
    try {
      const bytes = await readPdfFile(file);
      await loadPdfBytes(bytes, file.name, { fileHandle });
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not open PDF.');
    }
  }

  async function handleCreatePdfTemplate(kind: PdfTemplateKind) {
    if (pages.length > 0) {
      setStatus('Close the current PDF before creating another PDF.');
      return;
    }

    setBusy(true);
    setStatus('Creating PDF...');

    try {
      const { bytes, name } = await createPdfTemplate(kind);
      await loadPdfBytes(bytes, name);
      setCleanWorkSignature(
        createWorkSignature(`unsaved:${byteFingerprint(bytes)}`, [])
      );
      setStatus(`${name} created. Save or download it when ready.`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not create PDF.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await openPdfFile(file);
    } finally {
      event.target.value = '';
    }
  }

  function handlePdfDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setPdfDragActive(true);
  }

  function handlePdfDragOver(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = pages.length > 0 ? 'none' : 'copy';
    setPdfDragActive(true);
  }

  function handlePdfDragLeave(event: React.DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }

    setPdfDragActive(false);
  }

  async function handlePdfDrop(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setPdfDragActive(false);

    const file = pdfFileFromList(event.dataTransfer.files);
    if (!file) {
      setStatus('Drop a PDF file to open it.');
      return;
    }

    if (pages.length > 0) {
      setStatus('Close the current PDF before opening another PDF.');
      return;
    }

    try {
      const localFile = await localPdfFileFromDrop(event.dataTransfer);
      if (localFile) {
        await openPdfFile(localFile.file, localFile.handle);
        return;
      }
    } catch (error) {
      console.error(error);
    }

    await openPdfFile(file);
  }

  async function handleMergeFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    if (!file || !pdfBytes || pages.length === 0) {
      event.target.value = '';
      return;
    }

    setBusy(true);
    try {
      const mergeBytes = await readPdfFile(file);
      const { bytes: nextBytes, insertedPageCount } = await mergePdfAfterPage(
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
      setStatus(`Merged ${insertedPageCount} page(s) from ${file.name}.`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not merge PDF.');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function handleDeletePage(pageIndex = activePageIndex) {
    if (!pdfBytes || pages.length <= 1) {
      setStatus('A PDF must keep at least one page.');
      return;
    }

    setBusy(true);
    try {
      const nextBytes = await removePage(pdfBytes, pageIndex);
      managedAnnotationPagesRef.current = remapPageSetAfterDelete(
        managedAnnotationPagesRef.current,
        pageIndex
      );
      commitAnnotations((current) =>
        current
          .filter((annotation) => annotation.pageIndex !== pageIndex)
          .map((annotation) =>
            annotation.pageIndex > pageIndex
              ? { ...annotation, pageIndex: annotation.pageIndex - 1 }
              : annotation
          )
      );
      setSelectedAnnotationIds([]);
      const replaced = await replacePdfAfterStructureEdit(nextBytes, {
        activePage: Math.max(0, Math.min(pageIndex, pages.length - 2))
      });
      if (!replaced) {
        throw new Error('Could not reload the PDF after deleting the page.');
      }
      setPageMenuIndex(null);
      setStatus(`Deleted page ${pageIndex + 1}.`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not delete page.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAddBlankPage(pageIndex = activePageIndex, position: 'before' | 'after' = 'after') {
    if (!pdfBytes) {
      return;
    }

    setBusy(true);
    try {
      const insertIndex = position === 'before' ? pageIndex : pageIndex + 1;
      const nextBytes = await addBlankPageAt(pdfBytes, insertIndex, pageIndex);
      managedAnnotationPagesRef.current = remapPageSetAfterInsert(
        managedAnnotationPagesRef.current,
        insertIndex
      );
      commitAnnotations((current) =>
        current.map((annotation) =>
          annotation.pageIndex >= insertIndex
            ? { ...annotation, pageIndex: annotation.pageIndex + 1 }
            : annotation
        )
      );
      const replaced = await replacePdfAfterStructureEdit(nextBytes, {
        activePage: insertIndex
      });
      if (!replaced) {
        throw new Error('Could not reload the PDF after adding the page.');
      }
      setPageMenuIndex(null);
      setStatus(
        `Added a blank page ${position} page ${pageIndex + 1}.`
      );
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not add page.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRotatePage(pageIndex = activePageIndex) {
    if (!pdfBytes || pages.length === 0) {
      return;
    }

    setBusy(true);
    try {
      const nextBytes = await rotatePageClockwise(pdfBytes, pageIndex);
      const replaced = await replacePdfAfterStructureEdit(nextBytes, {
        activePage: pageIndex
      });
      if (!replaced) {
        throw new Error('Could not reload the PDF after rotating the page.');
      }
      setPageMenuIndex(null);
      setStatus(`Rotated page ${pageIndex + 1}.`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not rotate page.');
    } finally {
      setBusy(false);
    }
  }

  function markCurrentWorkClean() {
    cleanAnnotationsRef.current = persistedAnnotations.map(normalizeAnnotationLayout);
    setCleanWorkSignature(
      createWorkSignature(pdfFingerprintRef.current, cleanAnnotationsRef.current)
    );
  }

  async function handleSave() {
    if (!pdfBytes) {
      return;
    }

    if (!hasUnsavedChanges) {
      setStatus('No unsaved changes to save.');
      return;
    }

    setBusy(true);
    setStatus('Writing PDF...');

    try {
      const savedBytes = await annotatedPdfBytes();
      const localFileHandle = localFileHandleRef.current;

      if (localFileHandle) {
        try {
          setStatus('Saving PDF to the original file...');
          await savePdfToLocalFile(localFileHandle, savedBytes);
          markCurrentWorkClean();
          setStatus(`Saved ${fileName}. Annotations remain editable here.`);
          return;
        } catch (error) {
          console.error(error);
          const outputName = annotatedName(fileName);
          downloadPdf(savedBytes, outputName);
          setStatus(
            `Could not save to the original file. Downloaded ${outputName} instead; verify the download before closing.`
          );
          return;
        }
      }

      const outputName = annotatedName(fileName);
      downloadPdf(savedBytes, outputName);
      markCurrentWorkClean();
      setStatus(`Downloaded ${outputName}. Annotations remain editable here.`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Could not save PDF.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    if (!pdfBytes) {
      return;
    }

    setBusy(true);
    setStatus('Preparing PDF download...');

    try {
      const savedBytes = await annotatedPdfBytes();
      const outputName = annotatedName(fileName);
      downloadPdf(savedBytes, outputName);
      setStatus(`Downloaded ${outputName}. Unsaved changes remain tracked.`);
    } catch (error) {
      console.error(error);
      setStatus(
        error instanceof Error ? error.message : 'Could not download PDF.'
      );
    } finally {
      setBusy(false);
    }
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
      persistedAnnotations
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
      ? annotatedPdfBytes()
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
          downloadPdf(bytes, outputName);
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
    const printWindow = window.open(url, '_blank');
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
    managedAnnotationPagesRef.current.add(annotation.pageIndex);
    setShowAnnotations(true);
    commitAnnotations((current) => [...current, normalizeAnnotationLayout(annotation)]);
    setSelectedAnnotationIds([]);
    setFocusedAnnotationId(
      annotation.kind === 'freeText' || annotation.kind === 'stickyNote'
        ? annotation.id
        : null
    );
  }

  function updateAnnotation(
    id: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options: { recordUndo?: boolean } = {}
  ) {
    const pageIndex = annotations.find((annotation) => annotation.id === id)?.pageIndex;
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
    if (selectedAnnotationIds.length === 0) {
      return;
    }

    const selectedIds = new Set(selectedAnnotationIds);
    for (const annotation of annotations) {
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
  }

  function deleteAnnotations(ids: string[]) {
    if (ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    for (const annotation of annotations) {
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
  }

  function handleSelectAnnotations(annotationIds: string[]) {
    if (focusedAnnotationId) {
      handleFocusAnnotationConsumed(focusedAnnotationId);
    }

    setSelectedAnnotationIds(annotationIds);
    setFocusedAnnotationId(null);
  }

  function handleFocusAnnotationConsumed(annotationId: string) {
    const annotation = annotations.find((item) => item.id === annotationId);
    setFocusedAnnotationId((current) =>
      current === annotationId ? null : current
    );

    if (annotation && !hasAnnotationContent(annotation)) {
      deleteAnnotations([annotationId]);
    }
  }

  function rememberRemovedAnnotationSource(annotation: PdfAnnotation) {
    if (annotation.sourceId) {
      removedAnnotationSourceIdsRef.current.add(annotation.sourceId);
    }
  }

  function updateToolSettings(update: Partial<ToolSettings>) {
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

  return (
    <main
      className="relative h-screen min-w-0 overflow-hidden bg-app-bg text-app-ink"
      onDragEnter={handlePdfDragEnter}
      onDragLeave={handlePdfDragLeave}
      onDragOver={handlePdfDragOver}
      onDrop={(event) => void handlePdfDrop(event)}
    >
      <input
        accept="application/pdf"
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />
      <input
        accept="application/pdf"
        className="hidden"
        onChange={handleMergeFileChange}
        ref={mergeFileInputRef}
        type="file"
      />

      {pages.length > 0 ? (
        <DocumentSidebar
          activePageIndex={activePageIndex}
          annotationsByPage={annotationsByPage}
          busy={busy}
          onAddPage={handleAddBlankPage}
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
          setPageMenuIndex={setPageMenuIndex}
          showAnnotations={showAnnotations}
          status={busy ? 'Working...' : status}
          width={sidebarWidth}
        />
      ) : null}

      {pages.length > 0 && !sidebarOpen ? (
        <div className="ui-frame screen-only absolute left-2 top-2 z-40 p-1 text-app-ink sm:left-3 sm:top-3">
          <button
            className="ui-button grid h-8 w-8 place-items-center"
            onClick={() => setSidebarOpen(true)}
            title="Show pages"
            type="button"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      ) : null}

      <section
        className={
          pages.length === 0
            ? 'pdf-scroll-root h-full overflow-auto'
            : 'pdf-scroll-root h-full overflow-auto pt-4 pb-[50vh]'
        }
        ref={scrollContainerRef}
      >
        {pages.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="ui-frame screen-only w-[min(92vw,28rem)] p-2 text-app-ink">
              <button
                className="ui-button flex w-full items-center justify-center gap-3 px-5 py-4 text-base font-medium disabled:cursor-not-allowed disabled:opacity-45"
                disabled={busy}
                onClick={() => void handleOpenPdfRequest()}
                type="button"
              >
                <FolderOpen size={22} />
                Open a PDF
              </button>
              <div className="mt-2 grid grid-cols-1 gap-1 border-t border-app-ink/12 pt-2 sm:grid-cols-3">
                {PDF_TEMPLATES.map(({ kind, label }) => (
                  <button
                    className="ui-button flex min-h-16 flex-col items-center justify-center gap-2 px-3 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={busy}
                    key={kind}
                    onClick={() => void handleCreatePdfTemplate(kind)}
                    type="button"
                  >
                    <FilePlus2 size={18} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
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
                  onEnsureAnnotationsVisible={() => setShowAnnotations(true)}
                  onBeginAnnotationEdit={beginAnnotationEdit}
                  onSelectAnnotations={handleSelectAnnotations}
                  onToolChange={handleToolChange}
                  onUpdateAnnotation={updateAnnotation}
                  page={page}
                  pageCount={pages.length}
                  pageIndex={index}
                  renderPriority={pageRenderPriority(index, activePageIndex)}
                  scale={scale}
                  onNavigateDestination={(destination) =>
                    void handlePdfDestination(destination)
                  }
                  onNavigatePage={handlePdfPageNavigation}
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
        )}
      </section>

      {pages.length > 0 ? (
        <>
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

          <FloatingDocumentControls
            busy={busy}
            canSave={hasUnsavedChanges}
            onClosePdf={handleClosePdf}
            onDownload={handleDownload}
            onPrint={handlePrint}
            onSave={handleSave}
            onToggleAnnotations={handleToggleAnnotations}
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

          <FloatingHistoryControls
            canRedo={redoStack.length > 0}
            canUndo={undoStack.length > 0}
            onRedo={redoAnnotations}
            onUndo={undoAnnotations}
            sidebarOpen={sidebarOpen}
            sidebarWidth={sidebarWidth}
          />
        </>
      ) : null}

      {showPageLoadNotice ? (
        <PageLoadNotice
          loadedPageCount={loadedPageCount}
          pageCount={pages.length}
        />
      ) : null}

      {pdfDragActive ? (
        <div className="screen-only pointer-events-none absolute inset-0 z-50 grid place-items-center bg-app-ink/10">
          <div className="ui-frame px-5 py-4 text-sm font-medium text-app-ink">
            {pages.length > 0
              ? 'Close the current PDF before opening another'
              : 'Drop PDF to open'}
          </div>
        </div>
      ) : null}
    </main>
  );
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
      className="mx-auto mb-4 grid w-fit place-items-center bg-app-ui text-xs font-medium text-app-ink/50 shadow-sm shadow-app-ink/5"
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

function isFileDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes('Files');
}

function pdfFileFromList(files: FileList) {
  return (
    Array.from(files).find(
      (file) =>
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf')
    ) ?? null
  );
}

function annotationSourceIdsForReplacement(
  annotations: PdfAnnotation[],
  removedSourceIds: Set<string>,
  currentAnnotations: PdfAnnotation[]
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
  return sourceIds;
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

function pageTopInContainer(container: HTMLElement, pageElement: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const pageRect = pageElement.getBoundingClientRect();
  return container.scrollTop + pageRect.top - containerRect.top;
}

function clampZoom(value: number) {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}
