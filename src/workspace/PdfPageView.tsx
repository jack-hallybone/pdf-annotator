import { Copy, Highlighter, RotateCw, Trash2 } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { RefObject } from 'react';
import {
  AnnotationLayer,
  AnnotationMode,
  AnnotationType
} from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
  EventBus,
  PDFPageView as PdfJsPageView
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import type {
  PdfAnnotation,
  PageDisplaySize,
  PageRenderPriority,
  PageViewport,
  PdfPoint,
  PdfRect,
  Tool,
  ToolSettings
} from './types';
import {
  ColorPalette,
  NumberSetting,
  SettingsPanelShell
} from './SettingsPanel';
import { rgbToCss } from './annotationColors';
import {
  existingAnnotationId,
  getDisplayAnnotations,
  isEditableExistingAnnotation
} from './annotationImport';
import type { ExistingPdfAnnotation } from './annotationImport';
import {
  annotationBounds,
  annotationHitTest,
  annotationWhollyInsidePolygon,
  boundsForPoints,
  boundsForRects,
  dotPath,
  isLassoSelectableAnnotation,
  pathHitTest,
  pathLength,
  rectToQuadPoints,
  resizeFreeTextWidth,
  resizeImageStampRect,
  resizeImageStampToHeight,
  resizeImageStampToWidth
} from './annotationGeometry';
import {
  annotationMatchesEraserScope,
  buildEraserAnnotationIndex,
  queryEraserAnnotationIndex,
  type EraserAnnotationIndex,
  type EraserScope
} from './eraserGeometry';
import {
  appendDraftInkPoints,
  appendMutableInkPoint,
  freehandHighlightMinLength,
  inkDotMaxLength,
  normalizeDraftInkPath
} from './inkCapture';
import {
  clearDisplayCanvas,
  drawInkCanvasAnnotation,
  drawInkCanvasPath,
  eraseInkCanvasPaths,
  inkCanvasPixelRatio,
  prepareInkCanvasContextState,
  renderInkCanvasLayer,
  renderPdfPathCanvas,
  renderTextHighlightCanvas
} from './inkRendering';
import { millimetresToPdfUnits, pdfUnitsToMillimetres } from './pdfUnits';
import {
  annotationContentTransform,
  pdfArrayRectToViewportRect,
  pdfRectToViewportRect,
  viewportPointToPdfPoint,
  viewportRectToPdfRect
} from './pdfGeometry';
import {
  PDFJS_MAX_CANVAS_PIXELS,
  PDFJS_TEXT_LAYER_ENABLE,
  PDF_TO_CSS_UNITS,
  cachePageBaseRenderMode,
  cachedPageBaseRenderMode,
  canvasLooksEmpty,
  pageHasRenderableContent,
  safeCanvasPixelRatio
} from './pdfRender';
import { createPdfLinkService, downloadManager } from './pdfLinks';
import {
  getSelectedTextRects,
  getTextForHighlights,
  getTextLayerRects,
  joinTextLayerSegments,
  moveTextHighlightHandle,
  oppositeHighlightHandleAnchor,
  type TextLayerRect,
  textLayerSegmentsInRange,
  textLayerSegmentsToHighlightRects
} from './textLayerGeometry';
import { clamp } from './viewerConfig';
import {
  AutoFocusTextarea,
  FilledPathShape,
  LassoShape,
  NotePopover,
  PathShape,
  SELECTION_ACCENT,
  TEXT_HIGHLIGHT_STYLE
} from './components/AnnotationPrimitives';
import { FREE_TEXT_LINE_HEIGHT } from './freeTextLayout';

type ViewportRect = { x: number; y: number; width: number; height: number };
type TextHitRect = TextLayerRect & { viewportRect: ViewportRect };
type ActiveTextGeometry = {
  hitRects: TextHitRect[];
  textRects: TextLayerRect[];
};
type DragSelection = {
  annotationIds: string[];
  lastPoint: PdfPoint;
  pageIndex: number;
  pointerId: number;
};
type FreeTextResizeHandle = {
  annotationId: string;
  handle: 'left' | 'right';
  pointerId: number;
};
type ImageStampResizeHandle = {
  annotationId: string;
  handle: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  pointerId: number;
};
type DraftInkPath = {
  kind: 'draw' | 'freehandHighlight';
  // Which pointer surface started this gesture - the SVG interaction layer
  // (draw/freehandHighlight tools) or the page div (the highlight tool's
  // free-draw fallback, off text). Pointer capture keeps every move/up/
  // cancel event for this pointer routed to (and bubbling through) both
  // surfaces' handlers regardless of which one owns the gesture, and
  // regardless of whether the active `tool` changes mid-gesture - so
  // finalize/cleanup must key off this fixed origin, not the live tool,
  // or a mid-gesture tool switch leaves the draft stuck forever (neither
  // handler's now-mismatched tool check fires on pointerup).
  origin: 'pageDiv' | 'svg';
  path: PdfPoint[];
};
type EraserGesture = {
  pendingUntilDrag: boolean;
};
type AnnotationPathUpdate = {
  annotationId: string;
  paths: PdfPoint[][];
};
type PendingEraseChanges = {
  deleteIds: Set<string>;
  pathUpdates: Map<string, PdfPoint[][]>;
};
type InkCanvasRenderState = {
  annotations: PdfAnnotation[];
  displaySize: PageDisplaySize;
  pixelRatio: number;
  scale: number;
  viewportHeight: number;
  viewportRotation: number;
  viewportWidth: number;
};
type TextSelectionHighlightAction = {
  contents: string;
  quadPoints: number[][];
  rects: PdfRect[];
  x: number;
  y: number;
};
type VisiblePageBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

type PdfPageViewProps = {
  page: PDFPageProxy;
  pageIndex: number;
  pageCount: number;
  renderPriority: PageRenderPriority;
  readOnly?: boolean;
  scale: number;
  active: boolean;
  tool: Tool;
  annotations: PdfAnnotation[];
  selectedAnnotationIds: string[];
  focusedAnnotationId: string | null;
  showAnnotations: boolean;
  toolSettings: ToolSettings;
  onActivate: (pageIndex: number) => void;
  onAddAnnotation: (annotation: PdfAnnotation) => void;
  onBeginAnnotationEdit: (options?: { finishOnPointerUp?: boolean }) => void;
  onDeleteAnnotations: (annotationIds: string[]) => void;
  onEraseAnnotations: (changes: {
    deleteIds: string[];
    pathUpdates: AnnotationPathUpdate[];
  }) => void;
  onFocusAnnotationConsumed: (annotationId: string) => void;
  onEnsureAnnotationsVisible: () => void;
  onExternalLinkRequest: (url: string) => void;
  onMoveAnnotationsToPage: (options: {
    annotationIds: string[];
    clientX: number;
    clientY: number;
    sourcePageIndex: number;
    sourcePoint: PdfPoint;
  }) => { pageIndex: number; point: PdfPoint } | null;
  onNavigateDestination: (destination: string | unknown[]) => void;
  onNavigatePage: (pageIndex: number) => void;
  onNotice?: (message: string) => void;
  onPageReady?: (pageIndex: number) => void;
  onPruneOffPageAnnotations: (annotationIds: string[]) => void;
  onSelectAnnotations: (annotationIds: string[]) => void;
  onToolChange: (tool: Tool) => void;
  onUpdateAnnotation: (
    annotationId: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options?: { recordUndo?: boolean }
  ) => void;
  onUpdateAnnotations: (
    annotationIds: string[],
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options?: { recordUndo?: boolean }
  ) => void;
};

// Stable no-op used where AnnotationShape needs a drag-handle callback but
// the layer it's rendered in doesn't support that interaction (a shared
// module-level constant so it never breaks AnnotationShape's memoization).
const noopAnnotationDragHandler = () => undefined;

function PdfPageViewComponent({
  page,
  pageIndex,
  pageCount,
  renderPriority,
  readOnly = false,
  scale,
  active,
  tool,
  annotations,
  selectedAnnotationIds,
  focusedAnnotationId,
  showAnnotations,
  toolSettings,
  onActivate,
  onAddAnnotation,
  onBeginAnnotationEdit,
  onDeleteAnnotations,
  onEraseAnnotations,
  onFocusAnnotationConsumed,
  onEnsureAnnotationsVisible,
  onExternalLinkRequest,
  onMoveAnnotationsToPage,
  onNavigateDestination,
  onNavigatePage,
  onNotice,
  onPageReady,
  onPruneOffPageAnnotations,
  onSelectAnnotations,
  onToolChange,
  onUpdateAnnotation,
  onUpdateAnnotations
}: PdfPageViewProps) {
  const baseLayerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const appearanceLayerRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const highlightInkCanvasRef = useRef<HTMLCanvasElement>(null);
  const textHighlightCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftInkCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftHighlightInkCanvasRef = useRef<HTMLCanvasElement>(null);
  const eraserCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const existingAnnotationsPageRef = useRef<PDFPageProxy | null>(null);
  const renderRequestRef = useRef<{
    cancel: () => void;
    key: string;
    run: () => void;
  } | null>(null);
  const suppressNextTextHighlightRef = useRef(false);
  const dismissedSelectionPointerIdRef = useRef<number | null>(null);
  const eraserScopeRef = useRef<EraserScope>('all');
  const eraserGestureRef = useRef<EraserGesture | null>(null);
  const eraserAnnotationIndexRef = useRef<EraserAnnotationIndex | null>(null);
  const eraserPathRef = useRef<PdfPoint[] | null>(null);
  const eraserPreviewFrameRef = useRef<number | null>(null);
  const eraserRemainingPathsRef = useRef<Map<string, PdfPoint[][]>>(new Map());
  const eraserDeletedIdsRef = useRef<Set<string>>(new Set());
  const suppressNextContextMenuRef = useRef(false);
  const pendingEraseChangesRef = useRef<PendingEraseChanges>({
    deleteIds: new Set(),
    pathUpdates: new Map()
  });
  const pathBoundsCacheRef = useRef<WeakMap<PdfPoint[], PdfRect>>(new WeakMap());
  const inkCanvasRenderStateRef = useRef<InkCanvasRenderState | null>(null);
  const prepaintedInkAnnotationIdsRef = useRef<Set<string>>(new Set());
  const draftInkPathRef = useRef<DraftInkPath | null>(null);
  const draftInkFrameRef = useRef<number | null>(null);
  const [draftTextHighlight, setDraftTextHighlight] = useState<{
    startIndex: number;
    currentIndex: number;
  } | null>(null);
  const activeTextGeometryRef = useRef<ActiveTextGeometry | null>(null);
  const dragSelectionRef = useRef<DragSelection | null>(null);
  const [existingAnnotations, setExistingAnnotations] = useState<
    ExistingPdfAnnotation[]
  >([]);
  const [baseLayerReady, setBaseLayerReady] = useState(false);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(
    null
  );
  const [freeTextResizeHandle, setFreeTextResizeHandle] =
    useState<FreeTextResizeHandle | null>(null);
  const [imageStampResizeHandle, setImageStampResizeHandle] =
    useState<ImageStampResizeHandle | null>(null);
  const [dragHandle, setDragHandle] = useState<{
    anchorIndex: number | null;
    annotationId: string;
    handle: 'start' | 'end';
    pointerId: number;
  } | null>(null);
  const [lassoPath, setLassoPath] = useState<PdfPoint[] | null>(null);
  const [textSelectionHighlightAction, setTextSelectionHighlightAction] =
    useState<TextSelectionHighlightAction | null>(null);
  const navigateDestinationRef = useRef(onNavigateDestination);
  const externalLinkRequestRef = useRef(onExternalLinkRequest);
  const navigatePageRef = useRef(onNavigatePage);
  navigateDestinationRef.current = onNavigateDestination;
  externalLinkRequestRef.current = onExternalLinkRequest;
  navigatePageRef.current = onNavigatePage;
  // Mirrors used so the stable (useCallback, empty-deps) annotation
  // pointer-handlers below always read current values via .current instead
  // of closing over them - closing over annotations/selectedAnnotationIds
  // directly would force the handlers to change identity on every
  // annotation edit, which is exactly the per-drag-frame re-render cost
  // AnnotationShape's memoization is meant to avoid.
  const annotationsRef = useRef(annotations);
  const selectedAnnotationIdsRef = useRef(selectedAnnotationIds);
  const toolRef = useRef(tool);
  const readOnlyRef = useRef(readOnly);
  const onUpdateAnnotationRef = useRef(onUpdateAnnotation);
  const onSelectAnnotationsRef = useRef(onSelectAnnotations);
  const onBeginAnnotationEditRef = useRef(onBeginAnnotationEdit);
  const onActivateRef = useRef(onActivate);
  const onFocusAnnotationConsumedRef = useRef(onFocusAnnotationConsumed);
  const getActiveTextGeometryRef = useRef(getActiveTextGeometry);
  annotationsRef.current = annotations;
  selectedAnnotationIdsRef.current = selectedAnnotationIds;
  toolRef.current = tool;
  readOnlyRef.current = readOnly;
  onUpdateAnnotationRef.current = onUpdateAnnotation;
  onSelectAnnotationsRef.current = onSelectAnnotations;
  onBeginAnnotationEditRef.current = onBeginAnnotationEdit;
  onActivateRef.current = onActivate;
  onFocusAnnotationConsumedRef.current = onFocusAnnotationConsumed;
  getActiveTextGeometryRef.current = getActiveTextGeometry;
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  // Escape doesn't generate a pointerup/pointercancel DOM event, so nothing
  // in the pointer-driven gesture tracking below ever sees it on its own.
  // This ref lets a single window-level Escape listener (registered once)
  // always call the current render's cancelActiveGesture, which reads
  // whichever gesture state (drag/resize/eraser/ink/lasso) is live right now.
  const cancelActiveGestureRef = useRef(cancelActiveGesture);
  cancelActiveGestureRef.current = cancelActiveGesture;
  const renderKey = `${page.pageNumber}:${scale}`;
  const [displaySize, setDisplaySize] = useState(() =>
    viewportDisplaySize(viewport)
  );
  const linkService = useMemo(
    () =>
      createPdfLinkService({
        onExternalLinkRequest: (url) =>
          externalLinkRequestRef.current(url),
        onNavigateDestination: (destination) =>
          navigateDestinationRef.current(destination),
        onNavigatePage: (targetPageIndex) =>
          navigatePageRef.current(targetPageIndex),
        pageCount,
        pageIndex
      }),
    [pageCount, pageIndex]
  );
  const selectedAnnotationIdSet = useMemo(
    () => new Set(selectedAnnotationIds),
    [selectedAnnotationIds]
  );
  const selectedPageAnnotations = useMemo(
    () => {
      if (readOnly) {
        return [];
      }

      return annotations.filter((annotation) =>
        selectedAnnotationIdSet.has(annotation.id)
      );
    },
    [annotations, readOnly, selectedAnnotationIdSet]
  );
  // This page's annotations (from the workspace-wide `annotations` prop), sorted
  // into stacking order for rendering.
  const displayAnnotations = useMemo(
    () =>
      [...annotations].sort(
        (left, right) =>
          annotationRenderRank(left) - annotationRenderRank(right)
      ),
    [annotations]
  );
  const canvasInkAnnotations = useMemo(
    () =>
      displayAnnotations.filter((annotation) =>
        isCanvasBackedInkAnnotation(annotation, selectedAnnotationIdSet)
      ),
    [displayAnnotations, selectedAnnotationIdSet]
  );
  const imageDisplayAnnotations = useMemo(
    () =>
      displayAnnotations.filter((annotation) => annotation.kind === 'imageStamp'),
    [displayAnnotations]
  );
  const vectorDisplayAnnotations = useMemo(
    () =>
      displayAnnotations.filter(
        (annotation) =>
          annotation.kind !== 'imageStamp' &&
          !isCanvasBackedInkAnnotation(annotation, selectedAnnotationIdSet)
      ),
    [displayAnnotations, selectedAnnotationIdSet]
  );
  const overlayCapturesPointer =
    !readOnly &&
    (tool === 'draw' ||
      tool === 'freehandHighlight' ||
      tool === 'freeText' ||
      tool === 'stickyNote' ||
      tool === 'eraser' ||
      tool === 'lasso');
  const shouldMountInteractionOverlay = showAnnotations || overlayCapturesPointer;
  const showSynchronizedAnnotations = showAnnotations && baseLayerReady;
  const pageStyle = {
    width: displaySize.width,
    height: displaySize.height,
    '--pdf-page-width': String(viewport.width / scale),
    '--pdf-page-height': String(viewport.height / scale),
    '--scale-factor': String(scale),
    '--user-unit': String(viewport.userUnit),
    '--total-scale-factor': String(scale * viewport.userUnit),
    '--scale-round-x': '1px',
    '--scale-round-y': '1px'
  } as React.CSSProperties;

  function setPageDisplaySize(nextSize: PageDisplaySize) {
    setDisplaySize((currentSize) =>
      displaySizesMatch(currentSize, nextSize) ? currentSize : nextSize
    );
  }

  useEffect(() => {
    if (baseLayerReady) {
      onPageReady?.(pageIndex);
    }
  }, [baseLayerReady, onPageReady, pageIndex]);

  useEffect(
    () => () => {
      const frame = draftInkFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        draftInkFrameRef.current = null;
      }
      const eraserFrame = eraserPreviewFrameRef.current;
      if (eraserFrame !== null) {
        window.cancelAnimationFrame(eraserFrame);
        eraserPreviewFrameRef.current = null;
      }
      flushPendingEraseChanges();
      clearDraftInkCanvases();
      clearDisplayCanvas(eraserCanvasRef.current);
    },
    []
  );

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        cancelActiveGestureRef.current();
      }
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pageView: PdfJsPageView | null = null;
    let fallbackRenderTask: ReturnType<PDFPageProxy['render']> | null = null;
    let spinnerTimer: number | null = null;
    let canvasRevealed = false;
    let started = false;

    async function renderPdfPageView() {
      if (started || cancelled) {
        return;
      }

      started = true;
      const container = baseLayerRef.current;
      if (!container) {
        return;
      }
      const renderContainer = container;

      pageRef.current?.classList.remove('show-delayed-spinner');
      spinnerTimer = window.setTimeout(() => {
        pageRef.current?.classList.add('show-delayed-spinner');
      }, 500);

      container.replaceChildren();
      textLayerRef.current = null;
      activeTextGeometryRef.current = null;
      setBaseLayerReady(false);
      setPageDisplaySize(viewportDisplaySize(viewport));
      const cachedRenderMode = cachedPageBaseRenderMode(page);

      function syncDisplaySizeFromRenderedPage() {
        setPageDisplaySize(
          displaySizeFromElement(
            renderContainer.querySelector<HTMLDivElement>('.page')
          ) ?? viewportDisplaySize(viewport)
        );
      }

      function revealCanvasIfReady() {
        if (cancelled || canvasRevealed) {
          return;
        }

        const canvas = renderContainer.querySelector<HTMLCanvasElement>(
          '.canvasWrapper canvas'
        );
        if (!canvas || canvasLooksEmpty(canvas)) {
          return;
        }

        canvasRevealed = true;
        if (cachedRenderMode !== 'annotationAppearance') {
          cachePageBaseRenderMode(page, 'normal');
        }
        syncDisplaySizeFromRenderedPage();
        setBaseLayerReady(true);
      }

      async function renderRasterFallbackWithRecovery() {
        const fallbackCanvas = await renderRasterFallback(
          page,
          viewport,
          renderContainer,
          AnnotationMode.DISABLE,
          (renderTask) => {
            fallbackRenderTask = renderTask;
          }
        );
        if (!cancelled && fallbackCanvas && canvasLooksEmpty(fallbackCanvas)) {
          const hasPageContent = await pageHasRenderableContent(page);
          if (hasPageContent) {
            cachePageBaseRenderMode(page, 'normal');
            return;
          }

          const recoveredCanvas = await renderRasterFallback(
            page,
            viewport,
            renderContainer,
            AnnotationMode.ENABLE,
            (renderTask) => {
              fallbackRenderTask = renderTask;
            }
          );
          if (recoveredCanvas && !canvasLooksEmpty(recoveredCanvas)) {
            cachePageBaseRenderMode(page, 'annotationAppearance');
          }
          return;
        }

        if (fallbackCanvas) {
          cachePageBaseRenderMode(page, 'normal');
        }
      }

      try {
        if (cachedRenderMode === 'annotationAppearance') {
          const hasPageContent = await pageHasRenderableContent(page);
          await renderRasterFallback(
            page,
            viewport,
            renderContainer,
            hasPageContent ? AnnotationMode.DISABLE : AnnotationMode.ENABLE,
            (renderTask) => {
              fallbackRenderTask = renderTask;
            }
          );
          if (hasPageContent) {
            cachePageBaseRenderMode(page, 'normal');
          }
        } else {
          const eventBus = new EventBus();
          eventBus.on('pagerendered', revealCanvasIfReady, { once: true });
          pageView = new PdfJsPageView({
            annotationMode: AnnotationMode.DISABLE,
            container,
            defaultViewport: page.getViewport({ scale }),
            enableSelectionRendering: true,
            eventBus,
            id: pageIndex + 1,
            maxCanvasPixels: PDFJS_MAX_CANVAS_PIXELS,
            scale: scale / PDF_TO_CSS_UNITS,
            textLayerMode: PDFJS_TEXT_LAYER_ENABLE
          });
          pageView.setPdfPage(page);

          await pageView.draw();
          if (
            !cancelled &&
            cachedRenderMode !== 'normal' &&
            shouldUseRasterFallback(container)
          ) {
            await renderRasterFallbackWithRecovery();
          } else if (!cancelled) {
            cachePageBaseRenderMode(page, 'normal');
          }
        }
      } catch (error) {
        if (!cancelled && !isRenderCancellation(error)) {
          try {
            await renderRasterFallbackWithRecovery();
          } catch (fallbackError) {
            if (!isRenderCancellation(fallbackError)) {
              onNotice?.(`Could not display page ${pageIndex + 1}.`);
            }
          }
        }
      } finally {
        if (spinnerTimer !== null) {
          window.clearTimeout(spinnerTimer);
          spinnerTimer = null;
        }
        pageRef.current?.classList.remove('show-delayed-spinner');
      }

      if (cancelled) {
        return;
      }

      textLayerRef.current =
        ((pageView as any).textLayer?.div as HTMLDivElement | undefined) ??
        container.querySelector<HTMLDivElement>('.textLayer');
      activeTextGeometryRef.current = null;
      if (!canvasRevealed) {
        syncDisplaySizeFromRenderedPage();
        setBaseLayerReady(true);
      }
    }

    const cancelScheduledRender = schedulePriorityTask(
      renderPriority,
      renderPdfPageView
    );
    renderRequestRef.current = {
      cancel: cancelScheduledRender,
      key: renderKey,
      run: () => void renderPdfPageView()
    };

    return () => {
      cancelled = true;
      if (spinnerTimer !== null) {
        window.clearTimeout(spinnerTimer);
      }
      pageRef.current?.classList.remove('show-delayed-spinner');
      cancelScheduledRender();
      if (renderRequestRef.current?.key === renderKey) {
        renderRequestRef.current = null;
      }
      pageView?.destroy();
      fallbackRenderTask?.cancel();
      if (baseLayerRef.current) {
        disposeCanvases(baseLayerRef.current);
        baseLayerRef.current.replaceChildren();
      }
      textLayerRef.current = null;
      activeTextGeometryRef.current = null;
    };
  }, [page, pageIndex, renderKey, scale]);

  useEffect(() => {
    if (renderPriority !== 'visible') {
      return;
    }

    const renderRequest = renderRequestRef.current;
    if (renderRequest?.key !== renderKey) {
      return;
    }

    renderRequest.cancel();
    renderRequest.run();
  }, [renderKey, renderPriority]);

  useEffect(() => {
    setExistingAnnotations([]);
    existingAnnotationsPageRef.current = null;
  }, [page]);

  useEffect(() => {
    if (!baseLayerReady || existingAnnotationsPageRef.current === page) {
      return;
    }

    let cancelled = false;
    const cancelScheduledRead = schedulePriorityTask(renderPriority, () => {
      void getDisplayAnnotations(page)
        .then((annotationsForDisplay) => {
          if (!cancelled) {
            existingAnnotationsPageRef.current = page;
            setExistingAnnotations(annotationsForDisplay);
          }
        })
        .catch(() => {
          if (!cancelled) {
            onNotice?.(`Could not load annotations on page ${pageIndex + 1}.`);
          }
        });
    });

    return () => {
      cancelled = true;
      cancelScheduledRead();
    };
  }, [baseLayerReady, page, renderPriority]);

  // Only the *set* of imported image-stamp ids matters for deciding whether
  // to hide a native-rendered stamp below - deriving this narrow key (rather
  // than depending on `annotations` directly) keeps the overlay re-render
  // below from firing on every unrelated annotation edit/drag.
  const importedImageStampIdsKey = annotations
    .filter((annotation) => annotation.kind === 'imageStamp')
    .map((annotation) => annotation.id)
    .sort()
    .join('|');

  useEffect(() => {
    async function renderAnnotationAppearanceOverlay() {
      const overlayCanvas = appearanceLayerRef.current;
      const baseCanvas =
        baseLayerRef.current?.querySelector<HTMLCanvasElement>(
          '.canvasWrapper canvas'
        );
      if (!overlayCanvas) {
        return;
      }

      const hasAppearanceOverlayAnnotations = existingAnnotations.some(
        (annotation) =>
          shouldRenderExistingAnnotationInAppearanceOverlay(
            annotation,
            annotationsRef.current,
            pageIndex
          )
      );
      const hasReadOnlyTextMarkups = existingAnnotations.some(
        isReadOnlyTextMarkupAnnotation
      );

      clearCanvas(overlayCanvas);
      if (
        !showAnnotations ||
        !baseLayerReady ||
        !baseCanvas ||
        (!hasAppearanceOverlayAnnotations && !hasReadOnlyTextMarkups)
      ) {
        return;
      }

      const context = overlayCanvas.getContext('2d', {
        willReadFrequently: true
      });
      const baseContext = baseCanvas.getContext('2d', {
        willReadFrequently: true
      });
      if (!context || !baseContext) {
        return;
      }

      const width = baseCanvas.width;
      const height = baseCanvas.height;
      if (width === 0 || height === 0) {
        return;
      }

      const baseCanvasBounds = baseCanvas.getBoundingClientRect();
      overlayCanvas.width = width;
      overlayCanvas.height = height;
      overlayCanvas.style.width = `${
        baseCanvasBounds.width || viewport.width
      }px`;
      overlayCanvas.style.height = `${
        baseCanvasBounds.height || viewport.height
      }px`;

      const scaleX = width / Math.max(1, viewport.width);
      const scaleY = height / Math.max(1, viewport.height);
      if (hasAppearanceOverlayAnnotations) {
        context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
        const renderTask = page.render({
          annotationMode: AnnotationMode.ENABLE,
          background: pageBackgroundColor(pageRef.current),
          canvas: overlayCanvas,
          canvasContext: context,
          viewport
        });
        appearanceRenderTask = renderTask;
        await renderTask.promise;

        if (cancelled || appearanceRenderTask !== renderTask) {
          return;
        }

        context.setTransform(1, 0, 0, 1, 0, 0);
        const appearancePixels = context.getImageData(0, 0, width, height);
        const basePixels = baseContext.getImageData(0, 0, width, height);
        keepOnlyChangedPixelsInAnnotationRects(
          appearancePixels,
          basePixels,
          existingAnnotations,
          annotationsRef.current,
          pageIndex,
          viewport,
          scaleX,
          scaleY
        );
        context.putImageData(appearancePixels, 0, 0);
        clearManagedAnnotationRectsFromAppearanceOverlay(
          context,
          existingAnnotations,
          annotationsRef.current,
          pageIndex,
          viewport,
          scaleX,
          scaleY
        );
      }

      if (hasReadOnlyTextMarkups && !cancelled) {
        drawReadOnlyTextDecorations(
          context,
          existingAnnotations,
          viewport,
          scaleX,
          scaleY,
          scale
        );
      }
    }

    let cancelled = false;
    let appearanceRenderTask: ReturnType<PDFPageProxy['render']> | null = null;
    const cancelScheduledRender = schedulePriorityTask(renderPriority, () => {
      void renderAnnotationAppearanceOverlay().catch((error) => {
        if (!cancelled && !isRenderCancellation(error)) {
          onNotice?.(`Could not display some annotations on page ${pageIndex + 1}.`);
        }
      });
    });

    return () => {
      cancelled = true;
      cancelScheduledRender();
      appearanceRenderTask?.cancel();
      if (appearanceLayerRef.current) {
        clearCanvas(appearanceLayerRef.current);
      }
    };
  }, [
    baseLayerReady,
    existingAnnotations,
    importedImageStampIdsKey,
    page,
    pageIndex,
    renderPriority,
    showAnnotations,
    viewport
  ]);

  useEffect(() => {
    // pdf.js populates `div` asynchronously inside layer.render() below, so
    // without this guard a stale invocation (superseded by a newer one
    // while its render() was still in flight - e.g. rapid zoom changes)
    // would still write its nodes into the div once it finally resolves,
    // landing on top of/mixed with whatever the newer render already put
    // there. Matches the cancellation pattern the sibling appearance-layer
    // effect above already uses.
    let cancelled = false;

    async function renderAnnotationLayer() {
      const div = annotationLayerRef.current;
      if (!div) {
        return;
      }

      div.replaceChildren();
      if (!showAnnotations || !baseLayerReady) {
        return;
      }

      const annotationViewport = viewport.clone({ dontFlip: true });
      const htmlAnnotations = existingAnnotations.filter(
        (annotation, index) =>
          shouldRenderExistingAnnotationInPdfJsLayer(
            annotation,
            index
          )
      );
      if (htmlAnnotations.length === 0) {
        return;
      }

      const layer = new AnnotationLayer({
        div,
        page,
        viewport: annotationViewport,
        linkService: linkService as any,
        annotationStorage: null,
        annotationCanvasMap: new Map(),
        accessibilityManager: null,
        annotationEditorUIManager: null,
        structTreeLayer: null,
        commentManager: null
      });

      await layer.render({
        div,
        page,
        viewport: annotationViewport,
        annotations: htmlAnnotations,
        linkService: linkService as any,
        downloadManager: downloadManager as any,
        // No embedded PDF script execution and no interactive form widgets:
        // this app only displays existing annotations, never runs their scripts.
        enableScripting: false,
        renderForms: false
      });

      if (cancelled) {
        div.replaceChildren();
      }
    }

    renderAnnotationLayer().catch(() => {
      if (!cancelled) {
        onNotice?.(`Could not display some annotations on page ${pageIndex + 1}.`);
      }
    });

    return () => {
      cancelled = true;
      annotationLayerRef.current?.replaceChildren();
    };
  }, [
    existingAnnotations,
    baseLayerReady,
    linkService,
    page,
    showAnnotations,
    viewport
  ]);

  useEffect(() => {
    function handleCopy(event: ClipboardEvent) {
      if (
        isEditingTarget(event.target) ||
        !selectedPageAnnotations.some(
          (annotation) => annotation.kind === 'textHighlight'
        )
      ) {
        return;
      }

      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        return;
      }

      const text = getTextForHighlights(
        selectedPageAnnotations,
        textLayerRef.current,
        pageRef.current,
        viewport
      );

      if (!text) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData('text/plain', text);
    }

    window.addEventListener('copy', handleCopy);
    return () => window.removeEventListener('copy', handleCopy);
  }, [selectedPageAnnotations, viewport]);

  useLayoutEffect(() => {
    const canvases = [highlightInkCanvasRef.current, inkCanvasRef.current];
    if (!showSynchronizedAnnotations) {
      canvases.forEach(clearDisplayCanvas);
      inkCanvasRenderStateRef.current = null;
      return;
    }

    const previousRender = inkCanvasRenderStateRef.current;
    const addedAnnotation =
      previousRender &&
      sameInkCanvasRenderFrame(previousRender, displaySize, scale, viewport)
        ? findSingleAddedInkAnnotation(
            previousRender.annotations,
            canvasInkAnnotations
          )
        : null;

    const frame = window.requestAnimationFrame(() => {
      if (addedAnnotation) {
        if (prepaintedInkAnnotationIdsRef.current.has(addedAnnotation.id)) {
          prepaintedInkAnnotationIdsRef.current.delete(addedAnnotation.id);
        } else {
          drawInkCanvasAnnotation({
            annotation: addedAnnotation,
            canvas:
              addedAnnotation.kind === 'draw'
                ? inkCanvasRef.current
                : highlightInkCanvasRef.current,
            clear: false,
            displaySize,
            scale,
            viewport
          });
        }
      } else {
        prepaintedInkAnnotationIdsRef.current.clear();
        renderInkCanvasLayer({
          annotations: canvasInkAnnotations,
          canvas: highlightInkCanvasRef.current,
          displaySize,
          kind: 'freehandHighlight',
          scale,
          viewport
        });
        renderInkCanvasLayer({
          annotations: canvasInkAnnotations,
          canvas: inkCanvasRef.current,
          displaySize,
          kind: 'draw',
          scale,
          viewport
        });
      }

      inkCanvasRenderStateRef.current = {
        annotations: canvasInkAnnotations,
        displaySize,
        pixelRatio: inkCanvasPixelRatio(displaySize),
        scale,
        viewportHeight: viewport.height,
        viewportRotation: viewport.rotation,
        viewportWidth: viewport.width
      };
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canvasInkAnnotations,
    displaySize,
    scale,
    showSynchronizedAnnotations,
    viewport
  ]);

  useEffect(() => {
    if (readOnly || tool !== 'select') {
      setTextSelectionHighlightAction(null);
      return;
    }

    let animationFrame = 0;

    function updateSelectionAction() {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        setTextSelectionHighlightAction(
          getTextSelectionHighlightAction(
            window.getSelection(),
            pageRef.current,
            textLayerRef.current,
            viewport
          )
        );
      });
    }

    document.addEventListener('selectionchange', updateSelectionAction);
    window.addEventListener('keyup', updateSelectionAction);
    window.addEventListener('mouseup', updateSelectionAction);
    updateSelectionAction();

    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener(
        'selectionchange',
        updateSelectionAction
      );
      window.removeEventListener('keyup', updateSelectionAction);
      window.removeEventListener('mouseup', updateSelectionAction);
    };
  }, [readOnly, tool, viewport]);

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    onActivate(pageIndex);
    if (readOnly) {
      return;
    }

    const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
    if ((tool === 'draw' || tool === 'highlight') && isRightButton) {
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      beginEraserGesture(point, {
        requireMovement: true,
        scope: tool === 'draw' ? 'draw' : 'highlight'
      });
      return;
    }

    const isPrimaryButton = event.button === 0;
    if (isPrimaryButton && isAnnotationCreationTool(tool)) {
      onEnsureAnnotationsVisible();
    }

    if (isPrimaryButton && (tool === 'freeText' || tool === 'stickyNote')) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (
      isPrimaryButton &&
      event.target === event.currentTarget &&
      selectedPageAnnotations.length > 0
    ) {
      // Image stamps render in a separate SVG layer beneath this interaction
      // layer, so once anything is selected and this layer's pointer-events
      // flip to 'auto', a click that visually lands on a stamp still hits
      // this layer's own empty background (event.target === currentTarget)
      // rather than the stamp's own <g>. Without this check, clicking an
      // already-selected stamp to start a drag would instead deselect it.
      if (tool === 'select') {
        const point = eventToPdfPoint(event, viewport);
        const hitStamp = [...imageDisplayAnnotations]
          .reverse()
          .find((candidate) => annotationHitTest(candidate, point, scale));
        if (hitStamp) {
          event.preventDefault();
          if (!selectedAnnotationIds.includes(hitStamp.id)) {
            onSelectAnnotations([hitStamp.id]);
          }
          beginMoveAnnotationAtPoint({
            annotationId: hitStamp.id,
            captureTarget: event.currentTarget,
            point,
            pointerId: event.pointerId
          });
          return;
        }
      }

      onSelectAnnotations([]);
      dismissedSelectionPointerIdRef.current = event.pointerId;
      event.preventDefault();
      return;
    }

    if (tool === 'select') {
      if (event.target === event.currentTarget) {
        onSelectAnnotations([]);
      }
      return;
    }

    if (tool === 'eraser') {
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      beginEraserGesture(point, {
        requireMovement: false,
        scope: 'all'
      });
      return;
    }

    if (tool === 'lasso') {
      event.preventDefault();
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      setLassoPath([point]);
      return;
    }

    if (tool !== 'draw' && tool !== 'freehandHighlight') {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginDraftInkPath(
      tool === 'draw' ? 'draw' : 'freehandHighlight',
      'svg',
      eventToPdfPoint(event, viewport)
    );
  }

  function handlePagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (isPdfLinkTarget(event.target)) {
      return;
    }
    if (readOnly) {
      onActivate(pageIndex);
      return;
    }

    const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
    if (tool === 'highlight' && isRightButton) {
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      const point = eventToPdfPointFromElement(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      beginEraserGesture(point, {
        requireMovement: true,
        scope: 'highlight'
      });
      return;
    }

    const isPrimaryButton = event.button === 0;
    if (isPrimaryButton && (tool === 'freeText' || tool === 'stickyNote')) {
      event.preventDefault();
      onEnsureAnnotationsVisible();
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (isPrimaryButton && tool === 'select' && isTextLayerTarget(event.target)) {
      return;
    }

    if (
      isPrimaryButton &&
      (tool === 'select' || tool === 'highlight') &&
      !isTextLayerTarget(event.target)
    ) {
      const point = eventToPdfPointFromElement(event, viewport);
      const hitAnnotation = findCanvasBackedInkAnnotationAtPoint(point);
      if (hitAnnotation) {
        event.preventDefault();
        onActivate(pageIndex);
        if (!selectedAnnotationIdSet.has(hitAnnotation.id)) {
          onSelectAnnotations([hitAnnotation.id]);
        }
        // The highlight tool intentionally shares this select-and-drag
        // affordance with the select tool (so highlights can be nudged/
        // recolored without switching tools) - the draw tool deliberately
        // does not, since ink strokes are thin enough that clicking one
        // precisely while trying to draw nearby would be error-prone.
        if (tool === 'select' || tool === 'highlight') {
          beginMoveAnnotationAtPoint({
            annotationId: hitAnnotation.id,
            captureTarget: event.currentTarget,
            point,
            pointerId: event.pointerId
          });
        }
        return;
      }
    }

    if (
      isPrimaryButton &&
      selectedPageAnnotations.length > 0
    ) {
      onSelectAnnotations([]);
      dismissedSelectionPointerIdRef.current = event.pointerId;
      event.preventDefault();
      return;
    }

    if (tool === 'select') {
      onSelectAnnotations([]);
      return;
    }

    if (tool === 'highlight') {
      onEnsureAnnotationsVisible();
      const geometry = getActiveTextGeometry();
      const startSegment = nearestTextSegmentFromPointerEventWithGeometry(
        event,
        geometry
      );
      if (startSegment) {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraftTextHighlight({
          startIndex: startSegment.index,
          currentIndex: startSegment.index
        });
        return;
      }

      activeTextGeometryRef.current = null;

      if (isTextLayerTarget(event.target)) {
        return;
      }

      event.preventDefault();
      suppressNextTextHighlightRef.current = true;
      window.getSelection()?.removeAllRanges();
      const point = eventToPdfPointFromElement(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      beginDraftInkPath('freehandHighlight', 'pageDiv', point);
    }
  }

  function handlePagePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (readOnly) {
      return;
    }

    if (moveActiveDragSelection(event.clientX, event.clientY)) {
      event.preventDefault();
      return;
    }

    if (eraserPathRef.current) {
      const points = eventToPdfPointsFromElement(event, viewport);
      event.preventDefault();
      appendEraserPoints(points);
      return;
    }

    // Gated on the draft state itself, not the live `tool` - once a pointer
    // is captured, this handler keeps receiving its move/up events even if
    // the tool changes mid-gesture (see DraftInkPath's `origin` comment).
    if (draftTextHighlight) {
      event.preventDefault();
      const segment = nearestTextSegmentFromPointerEventWithGeometry(
        event,
        getActiveTextGeometry(),
        { x: 60, y: 24 }
      );
      if (segment) {
        setDraftTextHighlight((current) =>
          current && current.currentIndex !== segment.index
            ? { ...current, currentIndex: segment.index }
            : current
        );
      }
      return;
    }

    if (draftInkPathRef.current?.origin !== 'pageDiv') {
      return;
    }

    const points = eventToPdfPointsFromElement(event, viewport);
    event.preventDefault();
    appendDraftInkPath(points);
  }

  function getActiveTextGeometry() {
    if (!activeTextGeometryRef.current) {
      const textRects = getTextLayerRects(
        textLayerRef.current,
        pageRef.current,
        viewport
      );
      activeTextGeometryRef.current = {
        hitRects: textRects.map((textRect) => ({
          ...textRect,
          viewportRect: pdfRectToViewportRect(textRect.rect, viewport)
        })),
        textRects
      };
    }

    return activeTextGeometryRef.current;
  }

  function moveActiveDragSelection(clientX: number, clientY: number) {
    const activeDragSelection = dragSelectionRef.current;
    if (!activeDragSelection) {
      return false;
    }

    const nextPosition = onMoveAnnotationsToPage({
      annotationIds: activeDragSelection.annotationIds,
      clientX,
      clientY,
      sourcePageIndex: activeDragSelection.pageIndex,
      sourcePoint: activeDragSelection.lastPoint
    });

    if (nextPosition) {
      dragSelectionRef.current = {
        ...activeDragSelection,
        lastPoint: nextPosition.point,
        pageIndex: nextPosition.pageIndex
      };
    }

    return true;
  }

  function endActiveDragSelection(event: React.PointerEvent<Element>) {
    const activeDragSelection = dragSelectionRef.current;
    if (!activeDragSelection) {
      return false;
    }

    releasePointer(event, activeDragSelection.pointerId);
    onPruneOffPageAnnotations(activeDragSelection.annotationIds);
    dragSelectionRef.current = null;
    return true;
  }

  function nearestTextSegmentFromPointerEventWithGeometry(
    event: React.PointerEvent<Element>,
    geometry: ActiveTextGeometry,
    tolerance = { x: 36, y: 16 }
  ) {
    const pageElement = pageRef.current;
    if (!pageElement || geometry.hitRects.length === 0) {
      return null;
    }

    const origin = clientPointToViewportPoint(
      event.clientX,
      event.clientY,
      pageElement.getBoundingClientRect(),
      viewport
    );
    return nearestTextHitRect(
      origin,
      geometry.hitRects,
      tolerance
    );
  }

  function handlePagePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (readOnly) {
      return;
    }

    if (dismissedSelectionPointerIdRef.current === event.pointerId) {
      dismissedSelectionPointerIdRef.current = null;
      return;
    }

    if (endActiveDragSelection(event)) {
      return;
    }

    if (eraserPathRef.current) {
      releasePointer(event, event.pointerId);
      endEraserGesture();
      return;
    }

    // Gated on the draft state itself, not the live `tool` - see the
    // matching comment in handlePagePointerMove above.
    if (draftTextHighlight) {
      releasePointer(event, event.pointerId);
      const geometry = getActiveTextGeometry();
      const endSegment = nearestTextSegmentFromPointerEventWithGeometry(
        event,
        geometry,
        { x: 60, y: 24 }
      );
      const endIndex = endSegment?.index ?? draftTextHighlight.currentIndex;
      const selectedTextRects = textLayerSegmentsInRange(
        geometry.textRects,
        draftTextHighlight.startIndex,
        endIndex
      );
      const rects = textLayerSegmentsToHighlightRects(selectedTextRects);
      setDraftTextHighlight(null);
      activeTextGeometryRef.current = null;

      if (
        endIndex !== draftTextHighlight.startIndex &&
        rects.length > 0 &&
        joinTextLayerSegments(selectedTextRects).trim().length > 0
      ) {
        onAddAnnotation({
          id: crypto.randomUUID(),
          kind: 'textHighlight',
          pageIndex,
          rects,
          quadPoints: rects.map(rectToQuadPoints),
          color: toolSettings.highlightColor,
          opacity: toolSettings.highlightOpacity,
          contents: joinTextLayerSegments(selectedTextRects)
        });
      }
      return;
    }

    if (tool === 'freeText' || tool === 'stickyNote') {
      releasePointer(event, event.pointerId);
      const origin = clientPointToViewportPoint(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        viewport
      );
      addTextOrNoteAnnotationAtViewportPoint(origin);
      return;
    }

    if (draftInkPathRef.current?.origin !== 'pageDiv') {
      return;
    }

    const path = appendDraftInkPath(
      eventToPdfPointsFromElement(event, viewport)
    );
    const normalizedPath = normalizeDraftInkPath(path, viewport);
    endDraftInkPath();
    releasePointer(event, event.pointerId);

    if (
      path.length > 2 &&
      pathLength(path) > freehandHighlightMinLength(viewport)
    ) {
      onAddAnnotation({
        id: crypto.randomUUID(),
        kind: 'freehandHighlight',
        pageIndex,
        paths: [normalizedPath],
        color: toolSettings.highlightColor,
        opacity: toolSettings.highlightOpacity,
        width: toolSettings.highlightWidth,
        contents: ''
      });
    }
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (readOnly) {
      return;
    }

    if (moveActiveDragSelection(event.clientX, event.clientY)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (dragHandle) {
      const point = eventToPdfPoint(event, viewport);
      const geometry = getActiveTextGeometry();
      onUpdateAnnotation(
        dragHandle.annotationId,
        (annotation) =>
          annotation.kind === 'textHighlight'
            ? moveTextHighlightHandle(
                annotation,
                dragHandle.handle,
                point,
                geometry.textRects,
                dragHandle.anchorIndex
              )
            : annotation,
        { recordUndo: false }
      );
      return;
    }

    if (freeTextResizeHandle) {
      const point = eventToPdfPoint(event, viewport);
      onUpdateAnnotation(
        freeTextResizeHandle.annotationId,
        (annotation) =>
          annotation.kind === 'freeText'
            ? resizeFreeTextWidth(
                annotation,
                point,
                freeTextResizeHandle.handle
              )
            : annotation,
        { recordUndo: false }
      );
      return;
    }

    if (imageStampResizeHandle) {
      const point = eventToPdfPoint(event, viewport);
      onUpdateAnnotation(
        imageStampResizeHandle.annotationId,
        (annotation) =>
          annotation.kind === 'imageStamp'
            ? resizeImageStampRect(
                annotation,
                point,
                imageStampResizeHandle.handle,
                scale
              )
            : annotation,
        { recordUndo: false }
      );
      return;
    }

    if (eraserPathRef.current) {
      const points = eventToPdfPoints(event, viewport);
      event.preventDefault();
      appendEraserPoints(points);
      return;
    }

    if (lassoPath) {
      const points = eventToPdfPoints(event, viewport);
      event.preventDefault();
      setLassoPath((current) =>
        current ? appendPdfPoints(current, points) : current
      );
      return;
    }

    // Gated on the draft's own origin, not the live `tool` - see the
    // matching comment in handlePagePointerMove/DraftInkPath.
    if (draftInkPathRef.current?.origin !== 'svg') {
      return;
    }

    const points = eventToPdfPoints(event, viewport);
    event.preventDefault();
    appendDraftInkPath(points);
  }

  function handlePointerCancel(event: React.PointerEvent<Element>) {
    if (dismissedSelectionPointerIdRef.current === event.pointerId) {
      dismissedSelectionPointerIdRef.current = null;
    }

    if (dragSelectionRef.current?.pointerId === event.pointerId) {
      dragSelectionRef.current = null;
    }

    if (freeTextResizeHandle?.pointerId === event.pointerId) {
      setFreeTextResizeHandle(null);
    }

    if (imageStampResizeHandle?.pointerId === event.pointerId) {
      setImageStampResizeHandle(null);
    }

    if (dragHandle?.pointerId === event.pointerId) {
      setDragHandle(null);
      activeTextGeometryRef.current = null;
    }

    if (eraserPathRef.current) {
      endEraserGesture();
    }

    if (lassoPath) {
      setLassoPath(null);
    }

    if (draftTextHighlight) {
      setDraftTextHighlight(null);
      activeTextGeometryRef.current = null;
    }

    if (draftInkPathRef.current) {
      endDraftInkPath();
    }
  }

  // Escape-key counterpart to handlePointerCancel above - same gesture
  // cleanup, but unconditional (no pointerId to match against, since Escape
  // isn't a pointer event) and treats an in-progress annotation move as
  // finished-in-place (pruning off-page annotations) rather than abandoned,
  // matching what releasing the pointer normally does.
  function cancelActiveGesture() {
    const activeDragSelection = dragSelectionRef.current;
    if (activeDragSelection) {
      dragSelectionRef.current = null;
      onPruneOffPageAnnotations(activeDragSelection.annotationIds);
    }

    if (freeTextResizeHandle) {
      setFreeTextResizeHandle(null);
    }

    if (imageStampResizeHandle) {
      setImageStampResizeHandle(null);
    }

    if (dragHandle) {
      setDragHandle(null);
      activeTextGeometryRef.current = null;
    }

    if (eraserPathRef.current) {
      endEraserGesture();
    }

    if (lassoPath) {
      setLassoPath(null);
    }

    if (draftTextHighlight) {
      setDraftTextHighlight(null);
      activeTextGeometryRef.current = null;
    }

    if (draftInkPathRef.current) {
      endDraftInkPath();
    }
  }

  function handlePointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (readOnly) {
      return;
    }

    if (dismissedSelectionPointerIdRef.current === event.pointerId) {
      dismissedSelectionPointerIdRef.current = null;
      return;
    }

    if (endActiveDragSelection(event)) {
      return;
    }

    if (freeTextResizeHandle) {
      releasePointer(event, freeTextResizeHandle.pointerId);
      setFreeTextResizeHandle(null);
      return;
    }

    if (imageStampResizeHandle) {
      releasePointer(event, imageStampResizeHandle.pointerId);
      setImageStampResizeHandle(null);
      return;
    }

    if (dragHandle) {
      releasePointer(event, dragHandle.pointerId);
      setDragHandle(null);
      activeTextGeometryRef.current = null;
      return;
    }

    if (eraserPathRef.current) {
      releasePointer(event, event.pointerId);
      endEraserGesture();
      return;
    }

    if (lassoPath) {
      releasePointer(event, event.pointerId);
      const selectedIds = annotations
        .filter(
          (annotation) =>
            isLassoSelectableAnnotation(annotation) &&
            annotationWhollyInsidePolygon(annotation, lassoPath)
        )
        .map((annotation) => annotation.id);
      onSelectAnnotations(selectedIds);
      onToolChange('select');
      setLassoPath(null);
      return;
    }

    // Gated on the draft's own origin/kind, not the live `tool` - see the
    // matching comment in handlePagePointerMove/DraftInkPath. The gesture
    // may have started under a different tool than whatever `tool` is now,
    // so every style/shape decision below uses the kind captured at
    // pointerdown rather than the live value.
    if (draftInkPathRef.current?.origin === 'svg') {
      const draftKind = draftInkPathRef.current.kind;
      const path = appendDraftInkPath(eventToPdfPoints(event, viewport));
      const normalizedPath =
        draftKind === 'draw' && pathLength(path) <= inkDotMaxLength(viewport)
          ? dotPath(path[0], toolSettings.drawWidth)
          : normalizeDraftInkPath(path, viewport);
      let annotation: PdfAnnotation | null = null;
      if (
        (draftKind === 'draw'
          ? normalizedPath.length > 0
          : path.length > 2) &&
        (draftKind !== 'freehandHighlight' ||
          pathLength(path) > freehandHighlightMinLength(viewport))
      ) {
        annotation = {
          id: crypto.randomUUID(),
          kind: draftKind,
          pageIndex,
          paths: [normalizedPath],
          color:
            draftKind === 'draw'
              ? toolSettings.drawColor
              : toolSettings.highlightColor,
          opacity:
            draftKind === 'draw'
              ? toolSettings.drawOpacity
              : toolSettings.highlightOpacity,
          width:
            draftKind === 'draw'
              ? toolSettings.drawWidth
              : toolSettings.highlightWidth,
          contents:
            draftKind === 'draw' ? 'Freehand drawing' : 'Freehand highlight'
        };
        // Paint the finalized, smoothed stroke before clearing the raw draft
        // layer so pen-up does not leave a visible gap on dense pages.
        prepaintCommittedInkAnnotation(annotation);
      }

      endDraftInkPath();
      releasePointer(event, event.pointerId);

      if (annotation) {
        onAddAnnotation(annotation);
      }

      return;
    }

    if (event.target !== event.currentTarget) {
      return;
    }

    if (tool === 'freeText' || tool === 'stickyNote') {
      addTextOrNoteAnnotationAtViewportPoint(eventToViewportPoint(event, viewport));
    }
  }

  function addTextOrNoteAnnotationAtViewportPoint(origin: PdfPoint) {
    if (tool !== 'freeText' && tool !== 'stickyNote') {
      return;
    }

    const textHeight = Math.max(84, toolSettings.textFontSize * scale * 4);
    const textLineHeight =
      toolSettings.textFontSize * scale * FREE_TEXT_LINE_HEIGHT;
    const noteSize = 28;
    const rect =
      tool === 'freeText'
        ? viewportRectToPdfRect(
            origin.x,
            origin.y - textLineHeight / 2,
            260,
            textHeight,
            viewport
          )
        : viewportRectToPdfRect(
            origin.x - noteSize / 2,
            origin.y - noteSize / 2,
            noteSize,
            noteSize,
            viewport
          );

    const annotation: PdfAnnotation =
      tool === 'freeText'
        ? {
            id: crypto.randomUUID(),
            kind: 'freeText',
            pageIndex,
            rect,
            text: '',
            fontSize: toolSettings.textFontSize,
            color: toolSettings.textColor,
            opacity: toolSettings.textOpacity
          }
        : {
            id: crypto.randomUUID(),
            kind: 'stickyNote',
            pageIndex,
            rect,
            text: '',
            color: toolSettings.noteColor
          };

    onAddAnnotation(annotation);
    onToolChange('select');
  }

  // Stable (empty/near-empty deps) so it can be passed to AnnotationShape
  // without forcing every annotation on the page to re-render whenever any
  // one of them changes - reads current values via refs instead of closing
  // over annotations/selectedAnnotationIds/tool/readOnly/viewport directly.
  const beginMoveAnnotationAtPoint = useCallback(
    ({
      annotationId,
      captureTarget,
      point,
      pointerId
    }: {
      annotationId: string;
      captureTarget: Element;
      point: PdfPoint;
      pointerId: number;
    }) => {
      const targetAnnotation = annotationsRef.current.find(
        (annotation) => annotation.id === annotationId
      );
      if (targetAnnotation?.kind === 'textHighlight') {
        return;
      }

      const selectedOnPage = selectedAnnotationIdsRef.current.filter((id) =>
        annotationsRef.current.some((annotation) => annotation.id === id)
      );
      const annotationIds = selectedOnPage.includes(annotationId)
        ? selectedOnPage
        : [annotationId];
      onBeginAnnotationEditRef.current({ finishOnPointerUp: true });
      captureTarget.setPointerCapture?.(pointerId);
      const nextDragSelection = {
        annotationIds,
        lastPoint: point,
        pageIndex,
        pointerId
      };
      dragSelectionRef.current = nextDragSelection;
    },
    [pageIndex]
  );

  const beginMoveAnnotation = useCallback(
    (event: React.PointerEvent<SVGGElement>, annotationId: string) => {
      if (
        readOnlyRef.current ||
        (toolRef.current !== 'select' && toolRef.current !== 'highlight')
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const captureTarget =
        event.currentTarget.ownerSVGElement ?? event.currentTarget;
      beginMoveAnnotationAtPoint({
        annotationId,
        captureTarget,
        point: eventToPdfPointFromElement(event, viewportRef.current),
        pointerId: event.pointerId
      });
    },
    [beginMoveAnnotationAtPoint]
  );

  // The following handlers back AnnotationShape's callback props. They're
  // all stable (useCallback with only pageIndex, which never changes for a
  // mounted page instance, as a dep) so passing the same annotation array
  // reference's unrelated entries down to AnnotationShape (memoized below)
  // lets React skip re-rendering annotations that aren't the one changing.
  const handleAnnotationSelect = useCallback(
    (annotationId: string) => {
      onActivateRef.current(pageIndex);
      onSelectAnnotationsRef.current([annotationId]);
    },
    [pageIndex]
  );

  const handleAnnotationHoverChange = useCallback(
    (hovered: boolean, annotationId: string) => {
      setHoveredAnnotationId(hovered ? annotationId : null);
    },
    []
  );

  const handleAnnotationUpdate = useCallback(
    (
      annotationId: string,
      updater: (annotation: PdfAnnotation) => PdfAnnotation
    ) => {
      onUpdateAnnotationRef.current(annotationId, updater, {
        recordUndo: false
      });
    },
    []
  );

  const handleAnnotationFocusEnd = useCallback((annotationId: string) => {
    onFocusAnnotationConsumedRef.current(annotationId);
  }, []);

  const handleAnnotationBeginEdit = useCallback(() => {
    onBeginAnnotationEditRef.current();
  }, []);

  const handleBeginHighlightHandleDrag = useCallback(
    (
      event: React.PointerEvent<SVGCircleElement>,
      handle: 'start' | 'end',
      annotationId: string
    ) => {
      event.stopPropagation();
      onBeginAnnotationEditRef.current({ finishOnPointerUp: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const annotation = annotationsRef.current.find(
        (candidate) => candidate.id === annotationId
      );
      const geometry = getActiveTextGeometryRef.current();
      setDragHandle({
        anchorIndex:
          annotation?.kind === 'textHighlight'
            ? oppositeHighlightHandleAnchor(annotation, handle, geometry.textRects)
            : null,
        annotationId,
        handle,
        pointerId: event.pointerId
      });
    },
    []
  );

  const handleBeginFreeTextResizeHandleDrag = useCallback(
    (
      event: React.PointerEvent<SVGCircleElement>,
      handle: 'left' | 'right',
      annotationId: string
    ) => {
      event.stopPropagation();
      onBeginAnnotationEditRef.current({ finishOnPointerUp: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      setFreeTextResizeHandle({
        annotationId,
        handle,
        pointerId: event.pointerId
      });
    },
    []
  );

  const handleBeginImageStampResizeHandleDrag = useCallback(
    (
      event: React.PointerEvent<SVGCircleElement>,
      handle: ImageStampResizeHandle['handle'],
      annotationId: string
    ) => {
      event.stopPropagation();
      onBeginAnnotationEditRef.current({ finishOnPointerUp: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      setImageStampResizeHandle({
        annotationId,
        handle,
        pointerId: event.pointerId
      });
    },
    []
  );

  function findCanvasBackedInkAnnotationAtPoint(point: PdfPoint) {
    for (let index = displayAnnotations.length - 1; index >= 0; index -= 1) {
      const annotation = displayAnnotations[index];
      if (
        isCanvasBackedInkAnnotation(annotation, selectedAnnotationIdSet) &&
        annotationHitTest(annotation, point, scale)
      ) {
        return annotation;
      }
    }

    return null;
  }

  function eraseAtPoint(point: PdfPoint) {
    if (readOnly) {
      return;
    }

    const eraserAnnotationIndex = eraserAnnotationIndexRef.current;
    if (!eraserAnnotationIndex) {
      return;
    }

    const scope = eraserScopeRef.current;
    // Ink deletions/path edits stay deferred to gesture-end (queued below) -
    // a single stroke can generate hundreds of point samples, so committing
    // annotation state on every one would force expensive re-renders. Other
    // annotation kinds are a single hit each (already deduped via
    // eraserDeletedIdsRef above), so they're cheap to commit immediately for
    // real-time visual feedback instead of waiting for pointer-up.
    const deleteIds: string[] = [];
    const pathUpdates: AnnotationPathUpdate[] = [];
    const immediateDeleteIds: string[] = [];

    for (const { annotation, bounds } of queryEraserAnnotationIndex(
      eraserAnnotationIndex,
      point
    )) {
      if (eraserDeletedIdsRef.current.has(annotation.id)) {
        continue;
      }

      if (!annotationMatchesEraserScope(annotation, scope)) {
        continue;
      }

      if (annotation.kind === 'draw' || annotation.kind === 'freehandHighlight') {
        const eraserRadius = Math.max(
          toolSettings.eraserWidth / 2 / scale,
          1 / scale
        );
        const threshold = Math.max(annotation.width * 1.4, eraserRadius);
        if (!expandedRectContainsPoint(bounds, point, threshold)) {
          continue;
        }

        const currentPaths =
          eraserRemainingPathsRef.current.get(annotation.id) ??
          annotation.paths;
        let changed = false;
        const remainingPaths = currentPaths.filter((path) => {
          const pathBounds = cachedPathBounds(path, pathBoundsCacheRef.current);
          if (!expandedRectContainsPoint(pathBounds, point, threshold)) {
            return true;
          }

          const hit = pathHitTest(path, point, threshold);
          changed ||= hit;
          return !hit;
        });

        if (!changed) {
          continue;
        }

        eraserRemainingPathsRef.current.set(annotation.id, remainingPaths);

        if (remainingPaths.length === 0 && currentPaths.length > 0) {
          eraseCommittedInkPaths(annotation, currentPaths);
          deleteIds.push(annotation.id);
          eraserDeletedIdsRef.current.add(annotation.id);
        } else {
          const remainingPathSet = new Set(remainingPaths);
          eraseCommittedInkPaths(
            annotation,
            currentPaths.filter((path) => !remainingPathSet.has(path))
          );
          pathUpdates.push({
            annotationId: annotation.id,
            paths: remainingPaths
          });
        }

        continue;
      }

      const padding = 6 / scale;
      if (
        expandedRectContainsPoint(bounds, point, padding) &&
        annotationHitTest(annotation, point, scale)
      ) {
        immediateDeleteIds.push(annotation.id);
        eraserDeletedIdsRef.current.add(annotation.id);
      }
    }

    queueEraseAnnotationChanges(deleteIds, pathUpdates);
    if (immediateDeleteIds.length > 0) {
      onEraseAnnotations({ deleteIds: immediateDeleteIds, pathUpdates: [] });
    }
  }

  function queueEraseAnnotationChanges(
    deleteIds: string[],
    pathUpdates: AnnotationPathUpdate[]
  ) {
    if (deleteIds.length === 0 && pathUpdates.length === 0) {
      return;
    }

    const pending = pendingEraseChangesRef.current;
    for (const id of deleteIds) {
      pending.deleteIds.add(id);
      pending.pathUpdates.delete(id);
    }
    for (const update of pathUpdates) {
      if (!pending.deleteIds.has(update.annotationId)) {
        pending.pathUpdates.set(update.annotationId, update.paths);
      }
    }

    // Commit once at the end of the gesture. Updating React state on every
    // eraser sample forces expensive annotation and canvas redraws on dense ink.
  }

  function flushPendingEraseChanges() {
    const pending = pendingEraseChangesRef.current;
    if (pending.deleteIds.size === 0 && pending.pathUpdates.size === 0) {
      return;
    }

    pendingEraseChangesRef.current = {
      deleteIds: new Set(),
      pathUpdates: new Map()
    };
    onEraseAnnotations({
      deleteIds: Array.from(pending.deleteIds),
      pathUpdates: Array.from(pending.pathUpdates, ([annotationId, paths]) => ({
        annotationId,
        paths
      }))
    });
  }

  function eraseCommittedInkPaths(
    annotation: Extract<PdfAnnotation, { kind: 'draw' | 'freehandHighlight' }>,
    paths: PdfPoint[][]
  ) {
    if (!showSynchronizedAnnotations || paths.length === 0) {
      return;
    }

    eraseInkCanvasPaths({
      annotation,
      canvas:
        annotation.kind === 'draw'
          ? inkCanvasRef.current
          : highlightInkCanvasRef.current,
      displaySize,
      paths,
      scale,
      viewport
    });
  }

  function prepaintCommittedInkAnnotation(annotation: PdfAnnotation) {
    if (
      !showSynchronizedAnnotations ||
      (annotation.kind !== 'draw' && annotation.kind !== 'freehandHighlight')
    ) {
      return;
    }

    drawInkCanvasAnnotation({
      annotation,
      canvas:
        annotation.kind === 'draw'
          ? inkCanvasRef.current
          : highlightInkCanvasRef.current,
      clear: false,
      displaySize,
      scale,
      viewport
    });
    prepaintedInkAnnotationIdsRef.current.add(annotation.id);
  }

  function beginEraserGesture(
    point: PdfPoint,
    {
      requireMovement,
      scope
    }: {
      requireMovement: boolean;
      scope: EraserScope;
    }
  ) {
    flushPendingEraseChanges();
    eraserScopeRef.current = scope;
    eraserAnnotationIndexRef.current = buildEraserAnnotationIndex(
      annotations,
      scale,
      toolSettings.eraserWidth
    );
    eraserPathRef.current = [point];
    eraserRemainingPathsRef.current = new Map();
    eraserDeletedIdsRef.current = new Set();
    eraserGestureRef.current = {
      pendingUntilDrag: requireMovement
    };
    // Only a right-click-drag erase gesture that actually crosses the
    // minimum drag distance (below, once pendingUntilDrag clears) should
    // suppress the browser's native context menu - reset here rather than
    // deriving from `requireMovement`, since that's also true for the
    // ordinary left-click Eraser-tool path, which has no context menu to
    // suppress and shouldn't arm this for an unrelated later right-click.
    suppressNextContextMenuRef.current = false;
    scheduleEraserPreviewRender();

    if (!requireMovement) {
      eraseAtPoint(point);
    }
  }

  function appendEraserPoints(points: PdfPoint[]) {
    if (points.length === 0) {
      return;
    }

    const currentPath = eraserPathRef.current;
    if (!currentPath) {
      return;
    }

    const nextPath = appendMutablePdfPoints(currentPath, points);
    eraserPathRef.current = nextPath;
    scheduleEraserPreviewRender();

    const gesture = eraserGestureRef.current;
    if (!gesture) {
      points.forEach(eraseAtPoint);
      return;
    }

    if (gesture.pendingUntilDrag) {
      if (pathLength(nextPath) < typeEraserMinLength(viewport)) {
        return;
      }

      gesture.pendingUntilDrag = false;
      suppressNextContextMenuRef.current = true;
      nextPath.forEach(eraseAtPoint);
      return;
    }

    points.forEach(eraseAtPoint);
  }

  function endEraserGesture() {
    flushPendingEraseChanges();
    eraserPathRef.current = null;
    eraserGestureRef.current = null;
    eraserAnnotationIndexRef.current = null;
    eraserScopeRef.current = 'all';
    eraserRemainingPathsRef.current = new Map();
    eraserDeletedIdsRef.current = new Set();
    const frame = eraserPreviewFrameRef.current;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      eraserPreviewFrameRef.current = null;
    }
    clearDisplayCanvas(eraserCanvasRef.current);
  }

  function handleMouseUp() {
    if (readOnly) {
      return;
    }

    const selection = window.getSelection();
    if (suppressNextTextHighlightRef.current) {
      suppressNextTextHighlightRef.current = false;
      selection?.removeAllRanges();
      return;
    }

    const isHighlightTool = tool === 'highlight' || tool === 'textHighlight';
    if (!isHighlightTool || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const pageElement = pageRef.current;
    if (!pageElement) {
      return;
    }

    const { rects, quadPoints } = getSelectedTextRects(
      selection,
      pageElement,
      textLayerRef.current,
      viewport
    );

    if (rects.length > 0) {
      onAddAnnotation({
        id: crypto.randomUUID(),
        kind: 'textHighlight',
        pageIndex,
        rects,
        quadPoints,
        color: toolSettings.highlightColor,
        opacity: toolSettings.highlightOpacity,
        contents: selection.toString()
      });
    }

    selection.removeAllRanges();
  }

  const draftTextHighlightRects = useMemo(
    () =>
      draftTextHighlight
        ? textLayerSegmentsToHighlightRects(
            textLayerSegmentsInRange(
              activeTextGeometryRef.current?.textRects ?? [],
              draftTextHighlight.startIndex,
              draftTextHighlight.currentIndex
            )
          )
        : [],
    [draftTextHighlight]
  );

  useLayoutEffect(() => {
    if (!showSynchronizedAnnotations) {
      clearDisplayCanvas(textHighlightCanvasRef.current);
      return;
    }

    renderTextHighlightCanvas({
      annotations,
      canvas: textHighlightCanvasRef.current,
      displaySize,
      draftHighlight:
        draftTextHighlightRects.length > 0
          ? {
              color: toolSettings.highlightColor,
              opacity: toolSettings.highlightOpacity,
              rects: draftTextHighlightRects
            }
          : undefined,
      viewport
    });
  }, [
    annotations,
    displaySize,
    draftTextHighlightRects,
    showSynchronizedAnnotations,
    toolSettings.highlightColor,
    toolSettings.highlightOpacity,
    viewport
  ]);

  function copySelectedHighlightText() {
    const text = getTextForHighlights(
      selectedPageAnnotations,
      textLayerRef.current,
      pageRef.current,
      viewport
    );
    if (!text || !navigator.clipboard) {
      return;
    }

    void navigator.clipboard.writeText(text).catch(() => {
      onNotice?.('Could not copy text.');
    });
  }

  function createHighlightFromTextSelection(
    event: React.MouseEvent<HTMLButtonElement>
  ) {
    event.preventDefault();
    event.stopPropagation();

    if (!textSelectionHighlightAction) {
      return;
    }

    onEnsureAnnotationsVisible();
    onAddAnnotation({
      id: crypto.randomUUID(),
      kind: 'textHighlight',
      pageIndex,
      rects: textSelectionHighlightAction.rects,
      quadPoints: textSelectionHighlightAction.quadPoints,
      color: toolSettings.highlightColor,
      opacity: toolSettings.highlightOpacity,
      contents: textSelectionHighlightAction.contents
    });
    window.getSelection()?.removeAllRanges();
    setTextSelectionHighlightAction(null);
  }

  function beginDraftInkPath(
    kind: 'draw' | 'freehandHighlight',
    origin: 'pageDiv' | 'svg',
    point: PdfPoint
  ) {
    clearDraftInkCanvases();
    draftInkPathRef.current = { kind, origin, path: [point] };
    scheduleDraftInkRender();
  }

  function appendDraftInkPath(points: PdfPoint[]) {
    const draft = draftInkPathRef.current;
    if (!draft || points.length === 0) {
      return draft?.path ?? [];
    }

    draft.path = appendDraftInkPoints(draft.path, points, viewport);
    scheduleDraftInkRender();
    return draft.path;
  }

  function endDraftInkPath() {
    draftInkPathRef.current = null;
    const frame = draftInkFrameRef.current;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      draftInkFrameRef.current = null;
    }
    clearDraftInkCanvases();
  }

  function clearDraftInkCanvases() {
    clearDisplayCanvas(draftInkCanvasRef.current);
    clearDisplayCanvas(draftHighlightInkCanvasRef.current);
  }

  function scheduleEraserPreviewRender() {
    if (eraserPreviewFrameRef.current !== null) {
      return;
    }

    eraserPreviewFrameRef.current = window.requestAnimationFrame(() => {
      eraserPreviewFrameRef.current = null;
      renderEraserPreviewPath();
    });
  }

  function renderEraserPreviewPath() {
    const path = eraserPathRef.current;
    if (!path) {
      clearDisplayCanvas(eraserCanvasRef.current);
      return;
    }

    renderPdfPathCanvas({
      canvas: eraserCanvasRef.current,
      color: resolvedAccentColor(pageRef.current),
      displaySize,
      opacity: 0.35,
      path,
      viewport,
      width: toolSettings.eraserWidth
    });
  }

  function scheduleDraftInkRender() {
    if (draftInkFrameRef.current !== null) {
      return;
    }

    draftInkFrameRef.current = window.requestAnimationFrame(() => {
      draftInkFrameRef.current = null;
      renderDraftInkPath();
    });
  }

  function renderDraftInkPath() {
    const draft = draftInkPathRef.current;
    if (!draft) {
      clearDraftInkCanvases();
      return;
    }

    const prepared = prepareInkCanvasContextState({
      canvas:
        draft.kind === 'draw'
          ? draftInkCanvasRef.current
          : draftHighlightInkCanvasRef.current,
      clear: true,
      displaySize,
      viewport
    });
    if (!prepared) {
      return;
    }

    const color =
      draft.kind === 'draw'
        ? toolSettings.drawColor
        : toolSettings.highlightColor;
    const opacity =
      draft.kind === 'draw'
        ? toolSettings.drawOpacity
        : toolSettings.highlightOpacity;
    const width =
      draft.kind === 'draw'
        ? toolSettings.drawWidth
        : toolSettings.highlightWidth;
    const displayPath =
      draft.kind === 'draw' && pathLength(draft.path) <= inkDotMaxLength(viewport)
        ? dotPath(draft.path[0], toolSettings.drawWidth)
        : normalizeDraftInkPath(draft.path, viewport);

    prepared.context.globalAlpha = clamp(opacity, 0, 1);
    prepared.context.fillStyle = rgbToCss(color);
    prepared.context.strokeStyle = rgbToCss(color);
    prepared.context.lineWidth = Math.max(0.25, width * scale);
    drawInkCanvasPath(
      prepared.context,
      displayPath,
      viewport,
      false,
      width * scale
    );
    prepared.context.globalAlpha = 1;
  }

  return (
    <article
      aria-current={active ? 'page' : undefined}
      className="pdf-page-frame"
      data-page-ready={baseLayerReady ? 'true' : 'false'}
      onClick={() => onActivate(pageIndex)}
    >
      <div
        className="pdf-page"
        data-tool={tool}
        ref={pageRef}
        style={pageStyle}
        onPointerDown={handlePagePointerDown}
        onPointerMove={handlePagePointerMove}
        onPointerUp={handlePagePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onMouseUp={handleMouseUp}
        onContextMenu={(event) => {
          if (suppressNextContextMenuRef.current) {
            suppressNextContextMenuRef.current = false;
            event.preventDefault();
          }
        }}
      >
        <div className="pdfa-fill">
          <div
            className="pdfViewer pdfa-fill"
            ref={baseLayerRef}
            style={{
              '--page-border': '0 solid transparent',
              '--page-margin': '0',
              '--scale-factor': String(scale)
            } as React.CSSProperties}
          />
          <canvas
            className="pdfa-annotation-appearance-layer pdfa-fill"
            ref={appearanceLayerRef}
          />
          <div
            className="annotationLayer pdfa-fill"
            ref={annotationLayerRef}
            style={{ pointerEvents: 'none' }}
          />
          {showSynchronizedAnnotations && imageDisplayAnnotations.length > 0 ? (
            <svg
              className="pdfa-image-stamp-layer pdfa-fill"
              height={displaySize.height}
              style={{ pointerEvents: readOnly ? 'none' : 'auto' }}
              viewBox={`0 0 ${viewport.width} ${viewport.height}`}
              width={displaySize.width}
            >
              {imageDisplayAnnotations.map((annotation) => (
                <AnnotationShape
                  annotation={annotation}
                  focused={false}
                  key={annotation.id}
                  onBeginHighlightHandleDrag={noopAnnotationDragHandler}
                  onBeginFreeTextResizeHandleDrag={noopAnnotationDragHandler}
                  onBeginImageStampResizeHandleDrag={noopAnnotationDragHandler}
                  onBeginMoveDrag={beginMoveAnnotation}
                  onHoverChange={handleAnnotationHoverChange}
                  onBeginEdit={handleAnnotationBeginEdit}
                  onFocusEnd={handleAnnotationFocusEnd}
                  onSelect={handleAnnotationSelect}
                  onUpdate={handleAnnotationUpdate}
                  partOfSelection={selectedAnnotationIds.includes(annotation.id)}
                  readOnly={readOnly}
                  scale={scale}
                  selected={false}
                  showPopover={false}
                  tool={tool}
                  viewport={viewport}
                />
              ))}
            </svg>
          ) : null}
          <canvas
            className="pdfa-ink-canvas-layer pdfa-highlight-canvas-layer pdfa-fill"
            ref={textHighlightCanvasRef}
          />
          <canvas
            className="pdfa-ink-canvas-layer pdfa-highlight-canvas-layer pdfa-fill"
            ref={highlightInkCanvasRef}
          />
          <canvas
            className="pdfa-ink-canvas-layer pdfa-fill"
            ref={inkCanvasRef}
          />
          <canvas
            className="pdfa-ink-canvas-layer pdfa-highlight-canvas-layer pdfa-fill"
            ref={draftHighlightInkCanvasRef}
          />
          <canvas
            className="pdfa-ink-canvas-layer pdfa-fill"
            ref={draftInkCanvasRef}
          />
          <canvas
            className="pdfa-ink-canvas-layer pdfa-fill"
            ref={eraserCanvasRef}
          />
          {shouldMountInteractionOverlay ? (
            <svg
              className="pdfa-interaction-layer pdfa-fill"
              height={displaySize.height}
              style={{
                pointerEvents:
                  overlayCapturesPointer ||
                  (selectedPageAnnotations.length > 0 && tool !== 'highlight')
                    ? 'auto'
                    : 'none'
              }}
              viewBox={`0 0 ${viewport.width} ${viewport.height}`}
              width={displaySize.width}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
            >
            {showSynchronizedAnnotations ? vectorDisplayAnnotations.map((annotation) => (
              <AnnotationShape
                annotation={annotation}
                focused={focusedAnnotationId === annotation.id}
                key={annotation.id}
                onBeginHighlightHandleDrag={handleBeginHighlightHandleDrag}
                onBeginFreeTextResizeHandleDrag={handleBeginFreeTextResizeHandleDrag}
                onBeginImageStampResizeHandleDrag={handleBeginImageStampResizeHandleDrag}
                onBeginMoveDrag={beginMoveAnnotation}
                onHoverChange={handleAnnotationHoverChange}
                onBeginEdit={handleAnnotationBeginEdit}
                onFocusEnd={handleAnnotationFocusEnd}
                onSelect={handleAnnotationSelect}
                onUpdate={handleAnnotationUpdate}
                partOfSelection={selectedAnnotationIds.includes(annotation.id)}
                readOnly={readOnly}
                scale={scale}
                selected={selectedAnnotationIds.includes(annotation.id)}
                showPopover={
                  annotation.kind === 'stickyNote'
                    ? focusedAnnotationId === annotation.id ||
                      selectedAnnotationIds.includes(annotation.id)
                    : focusedAnnotationId === annotation.id ||
                      (selectedPageAnnotations.length <= 1 &&
                        selectedAnnotationIds.includes(annotation.id)) ||
                      hoveredAnnotationId === annotation.id
                }
                tool={tool}
                viewport={viewport}
              />
            )) : null}
            {showSynchronizedAnnotations
              ? selectedPageAnnotations
                  .filter((annotation) => annotation.kind === 'imageStamp')
                  .map((annotation) => (
                    <ImageStampSelectionOverlay
                      annotation={annotation}
                      key={`image-selection-${annotation.id}`}
                      onBeginDrag={(event, handle) => {
                        event.stopPropagation();
                        onBeginAnnotationEdit({ finishOnPointerUp: true });
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setImageStampResizeHandle({
                          annotationId: annotation.id,
                          handle,
                          pointerId: event.pointerId
                        });
                      }}
                      viewport={viewport}
                    />
                  ))
              : null}
            {!readOnly && showSynchronizedAnnotations && selectedPageAnnotations.length > 0 ? (
              <SelectionToolbar
                annotations={selectedPageAnnotations}
                onBeginEdit={onBeginAnnotationEdit}
                onDelete={() =>
                  onDeleteAnnotations(
                    selectedPageAnnotations.map((annotation) => annotation.id)
                  )
                }
                onClose={() => onSelectAnnotations([])}
                onCopyText={copySelectedHighlightText}
                onUpdate={(updater) => {
                  onUpdateAnnotations(
                    selectedPageAnnotations.map((annotation) => annotation.id),
                    updater,
                    { recordUndo: false }
                  );
                }}
                pageRef={pageRef}
                viewport={viewport}
              />
            ) : null}
            {lassoPath ? (
              <LassoShape points={lassoPath} viewport={viewport} />
            ) : null}
            </svg>
          ) : null}
          {!readOnly && textSelectionHighlightAction ? (
            <button
              className="text-selection-highlight-button"
              onClick={createHighlightFromTextSelection}
              onPointerDown={(event) => event.stopPropagation()}
              style={{
                left: textSelectionHighlightAction.x,
                top: textSelectionHighlightAction.y
              }}
              title="Highlight selection"
              type="button"
            >
              <Highlighter size={15} />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export const PdfPageView = memo(PdfPageViewComponent, arePdfPageViewPropsEqual);

function arePdfPageViewPropsEqual(
  previous: PdfPageViewProps,
  next: PdfPageViewProps
) {
  return (
    previous.active === next.active &&
    previous.annotations === next.annotations &&
    previous.focusedAnnotationId === next.focusedAnnotationId &&
    previous.page === next.page &&
    previous.pageCount === next.pageCount &&
    previous.pageIndex === next.pageIndex &&
    previous.readOnly === next.readOnly &&
    previous.renderPriority === next.renderPriority &&
    previous.scale === next.scale &&
    previous.showAnnotations === next.showAnnotations &&
    previous.tool === next.tool &&
    previous.toolSettings === next.toolSettings &&
    stringArraysEqual(
      previous.selectedAnnotationIds,
      next.selectedAnnotationIds
    )
  );
}

function stringArraysEqual(left: string[], right: string[]) {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

const AnnotationShape = memo(function AnnotationShape({
  annotation,
  focused,
  onBeginEdit,
  onBeginFreeTextResizeHandleDrag,
  onBeginHighlightHandleDrag,
  onBeginImageStampResizeHandleDrag,
  onBeginMoveDrag,
  onFocusEnd,
  onHoverChange,
  onSelect,
  onUpdate,
  partOfSelection,
  readOnly,
  scale,
  selected,
  showPopover,
  tool,
  viewport
}: {
  annotation: PdfAnnotation;
  focused: boolean;
  onBeginEdit: () => void;
  onBeginFreeTextResizeHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: 'left' | 'right',
    annotationId: string
  ) => void;
  onBeginImageStampResizeHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: ImageStampResizeHandle['handle'],
    annotationId: string
  ) => void;
  onBeginHighlightHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: 'start' | 'end',
    annotationId: string
  ) => void;
  onBeginMoveDrag: (
    event: React.PointerEvent<SVGGElement>,
    annotationId: string
  ) => void;
  onFocusEnd: (annotationId: string) => void;
  onHoverChange: (hovered: boolean, annotationId: string) => void;
  onSelect: (annotationId: string) => void;
  onUpdate: (
    annotationId: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation
  ) => void;
  // Whether this annotation is currently in the selection, independent of
  // `selected` below - image stamps always pass `selected={false}` here to
  // avoid double-rendering their selection outline/resize handles (a
  // separate ImageStampSelectionOverlay owns that), but a drag-start still
  // needs to know the TRUE selection membership so clicking one image in an
  // existing multi-selection doesn't collapse it down to just that image.
  partOfSelection: boolean;
  readOnly: boolean;
  scale: number;
  selected: boolean;
  showPopover: boolean;
  tool: Tool;
  viewport: PageViewport;
}) {
  const commonProps = {
    onPointerDown: (event: React.PointerEvent<SVGGElement>) => {
      if (readOnly) {
        return;
      }

      if (tool === 'eraser') {
        return;
      }

      const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
      if ((tool === 'draw' || tool === 'highlight') && isRightButton) {
        return;
      }

      if (isRightButton) {
        return;
      }

      if (tool === 'draw') {
        return;
      }

      event.stopPropagation();

      if (tool === 'highlight') {
        if (
          annotation.kind === 'textHighlight' ||
          annotation.kind === 'freehandHighlight' ||
          annotation.kind === 'draw'
        ) {
          event.preventDefault();
          if (!selected) {
            onSelect(annotation.id);
          }
          onBeginMoveDrag(event, annotation.id);
        }
        return;
      }

      if (tool !== 'select') {
        return;
      }

      event.preventDefault();
      if (!partOfSelection) {
        onSelect(annotation.id);
      }
      onBeginMoveDrag(event, annotation.id);
    },
    onPointerUp: (event: React.PointerEvent<SVGGElement>) => {
      if (readOnly) {
        return;
      }

      if (tool === 'freeText' || tool === 'stickyNote') {
        event.stopPropagation();
      }
    },
    onPointerEnter: () => onHoverChange(true, annotation.id),
    onPointerLeave: () => onHoverChange(false, annotation.id),
    style: { cursor: 'pointer', pointerEvents: 'auto' as const }
  };

  switch (annotation.kind) {
    case 'textHighlight':
      return (
        <g {...commonProps}>
          {annotation.rects.map((rect, index) => {
            const bounds = pdfRectToViewportRect(rect, viewport);
            return (
              <g key={`${annotation.id}-${index}`}>
                {/* The visible fill is painted on the highlight canvas layer
                    (see renderTextHighlightCanvas) so its multiply blend can
                    reach the real page content - an outermost <svg> always
                    isolates blend modes, so this rect only exists as an
                    invisible hit target for selecting/dragging. */}
                <rect
                  fill={rgbToCss(annotation.color)}
                  height={bounds.height}
                  style={{ opacity: 0, pointerEvents: 'all' }}
                  width={bounds.width}
                  x={bounds.x}
                  y={bounds.y}
                />
                {selected ? (
                  <rect
                    fill="none"
                    height={bounds.height}
                    stroke={SELECTION_ACCENT}
                    strokeDasharray="4 3"
                    strokeWidth="1.5"
                    width={bounds.width}
                    x={bounds.x}
                    y={bounds.y}
                  />
                ) : null}
              </g>
            );
          })}
          {selected ? (
            <TextHighlightHandles
              annotation={annotation}
              onBeginDrag={(event, handle) =>
                onBeginHighlightHandleDrag(event, handle, annotation.id)
              }
              viewport={viewport}
            />
          ) : null}
        </g>
      );

    case 'draw':
    case 'freehandHighlight':
      return (
        <g {...commonProps}>
          {annotation.paths.map((path, index) => {
            const filledHighlight =
              annotation.kind === 'freehandHighlight' &&
              annotation.filled === true;
            return (
              <g key={`${annotation.id}-${index}`}>
                {selected ? (
                  <PathShape
                    color={SELECTION_ACCENT}
                    opacity={0.28}
                    points={path}
                    viewport={viewport}
                    width={annotation.width * scale + 8}
                  />
                ) : null}
                {filledHighlight ? (
                  <FilledPathShape
                    color={rgbToCss(annotation.color)}
                    opacity={annotation.opacity}
                    points={path}
                    viewport={viewport}
                  />
                ) : (
                  <PathShape
                    color={rgbToCss(annotation.color)}
                    opacity={annotation.opacity}
                    points={path}
                    style={
                      annotation.kind === 'freehandHighlight'
                        ? TEXT_HIGHLIGHT_STYLE
                        : undefined
                    }
                    viewport={viewport}
                    width={annotation.width * scale}
                  />
                )}
              </g>
            );
          })}
        </g>
      );

    case 'freeText': {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      const { localWidth, localHeight, transform } = annotationContentTransform(
        rect,
        viewport,
        annotation.rotation ?? 0
      );
      const editable = selected || focused;
      return (
        <g {...commonProps}>
          <foreignObject
            height={localHeight}
            transform={transform}
            width={localWidth}
          >
            {editable ? (
              <AutoFocusTextarea
                autoFocus={focused}
                className="free-text-editor"
                ignoreInitialBlurMs={
                  focused && annotation.text.trim().length === 0 ? 750 : 0
                }
                onChange={(event) =>
                  onUpdate(annotation.id, (current) =>
                    current.kind === 'freeText'
                      ? { ...current, text: event.target.value }
                      : current
                  )
                }
                onBlur={editable ? () => onFocusEnd(annotation.id) : undefined}
                onFocus={
                  focused && annotation.text.trim().length === 0
                    ? undefined
                    : onBeginEdit
                }
                placeholder="Text..."
                style={{
                  color: rgbToCss(annotation.color),
                  fontSize: annotation.fontSize * scale,
                  lineHeight: FREE_TEXT_LINE_HEIGHT,
                  opacity: annotation.opacity
                }}
                value={annotation.text}
              />
            ) : (
              <div
                className="free-text-view"
                style={{
                  color: rgbToCss(annotation.color),
                  fontSize: annotation.fontSize * scale,
                  lineHeight: FREE_TEXT_LINE_HEIGHT,
                  opacity: annotation.opacity
                }}
              >
                {annotation.text}
              </div>
            )}
          </foreignObject>
          {editable ? (
            <FreeTextWidthHandles
              annotation={annotation}
              onBeginDrag={(event, handle) =>
                onBeginFreeTextResizeHandleDrag(event, handle, annotation.id)
              }
              viewport={viewport}
            />
          ) : null}
        </g>
      );
    }

    case 'imageStamp': {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      const { localWidth, localHeight, transform } = annotationContentTransform(
        rect,
        viewport,
        annotation.rotation ?? 0
      );
      return (
        <g {...commonProps}>
          <image
            height={localHeight}
            href={`data:${annotation.mimeType};base64,${annotation.imageData}`}
            preserveAspectRatio="xMidYMid meet"
            transform={transform}
            width={localWidth}
          />
          {selected ? (
            <>
              <rect
                fill="none"
                height={localHeight}
                stroke={SELECTION_ACCENT}
                strokeDasharray="4 3"
                strokeWidth="1.5"
                transform={transform}
                width={localWidth}
              />
              <ImageStampResizeHandles
                annotation={annotation}
                onBeginDrag={(event, handle) =>
                  onBeginImageStampResizeHandleDrag(event, handle, annotation.id)
                }
                viewport={viewport}
              />
            </>
          ) : null}
        </g>
      );
    }

    case 'stickyNote': {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      const detailColor = 'var(--pdfa-ink)';
      return (
        <g {...commonProps} transform={`translate(${rect.x} ${rect.y})`}>
          <rect
            fill={rgbToCss(annotation.color)}
            height={Math.max(rect.height, 22)}
            rx="3"
            stroke={detailColor}
            strokeOpacity={selected ? 0.95 : 0.62}
            strokeWidth={selected ? 2 : 1}
            width={Math.max(rect.width, 22)}
          />
          <path
            d="M6 7h12M6 12h10M6 17h8"
            fill="none"
            stroke={detailColor}
            strokeLinecap="round"
            strokeOpacity="0.66"
            strokeWidth="1.5"
          />
          {showPopover ? (
            <NotePopover
              autoFocus={focused}
              color={annotation.color}
              editable={selected || focused}
              ignoreInitialBlurMs={
                focused && annotation.text.trim().length === 0 ? 750 : 0
              }
              onBlur={
                selected || focused ? () => onFocusEnd(annotation.id) : undefined
              }
              onFocus={
                focused && annotation.text.trim().length === 0
                  ? undefined
                  : onBeginEdit
              }
              onTextChange={(text) =>
                onUpdate(annotation.id, (current) =>
                  current.kind === 'stickyNote' ? { ...current, text } : current
                )
              }
              text={annotation.text}
              anchorRect={rect}
              viewport={viewport}
            />
          ) : null}
        </g>
      );
    }
  }
});

function TextHighlightHandles({
  annotation,
  onBeginDrag,
  viewport
}: {
  annotation: Extract<PdfAnnotation, { kind: 'textHighlight' }>;
  onBeginDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: 'start' | 'end'
  ) => void;
  viewport: PageViewport;
}) {
  const first = annotation.rects[0];
  const last = annotation.rects.at(-1);

  if (!first || !last) {
    return null;
  }

  const start = viewport.convertToViewportPoint(first.x1, (first.y1 + first.y2) / 2);
  const end = viewport.convertToViewportPoint(last.x2, (last.y1 + last.y2) / 2);

  return (
    <g style={{ pointerEvents: 'auto' }}>
      <circle
        className="highlight-handle"
        cx={start[0]}
        cy={start[1]}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, 'start')}
        r="6"
        stroke="white"
        strokeWidth="2"
      />
      <circle
        className="highlight-handle"
        cx={end[0]}
        cy={end[1]}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, 'end')}
        r="6"
        stroke="white"
        strokeWidth="2"
      />
    </g>
  );
}

function FreeTextWidthHandles({
  annotation,
  onBeginDrag,
  viewport
}: {
  annotation: Extract<PdfAnnotation, { kind: 'freeText' }>;
  onBeginDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: 'left' | 'right'
  ) => void;
  viewport: PageViewport;
}) {
  const bounds = pdfRectToViewportRect(annotation.rect, viewport);
  const { localWidth, localHeight, transform } = annotationContentTransform(
    bounds,
    viewport,
    annotation.rotation ?? 0
  );
  const centerY = localHeight / 2;

  return (
    <g style={{ pointerEvents: 'auto' }} transform={transform}>
      <circle
        className="free-text-width-handle"
        cx={0}
        cy={centerY}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, 'left')}
        r="5"
        stroke="white"
        strokeWidth="2"
      />
      <circle
        className="free-text-width-handle"
        cx={localWidth}
        cy={centerY}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, 'right')}
        r="5"
        stroke="white"
        strokeWidth="2"
      />
    </g>
  );
}

function ImageStampSelectionOverlay({
  annotation,
  onBeginDrag,
  viewport
}: {
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>;
  onBeginDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: ImageStampResizeHandle['handle']
  ) => void;
  viewport: PageViewport;
}) {
  const rect = pdfRectToViewportRect(annotation.rect, viewport);
  const { localWidth, localHeight, transform } = annotationContentTransform(
    rect,
    viewport,
    annotation.rotation ?? 0
  );
  return (
    <g style={{ pointerEvents: 'auto' }}>
      <rect
        fill="none"
        height={localHeight}
        stroke={SELECTION_ACCENT}
        strokeDasharray="4 3"
        strokeWidth="1.5"
        transform={transform}
        width={localWidth}
      />
      <ImageStampResizeHandles
        annotation={annotation}
        onBeginDrag={onBeginDrag}
        viewport={viewport}
      />
    </g>
  );
}

function ImageStampResizeHandles({
  annotation,
  onBeginDrag,
  viewport
}: {
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>;
  onBeginDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: ImageStampResizeHandle['handle']
  ) => void;
  viewport: PageViewport;
}) {
  const rect = pdfRectToViewportRect(annotation.rect, viewport);
  const { localWidth, localHeight, transform } = annotationContentTransform(
    rect,
    viewport,
    annotation.rotation ?? 0
  );
  const handles: Array<{
    handle: ImageStampResizeHandle['handle'];
    point: [number, number];
  }> = [
    { handle: 'top-left', point: [0, 0] },
    { handle: 'top-right', point: [localWidth, 0] },
    { handle: 'bottom-left', point: [0, localHeight] },
    { handle: 'bottom-right', point: [localWidth, localHeight] }
  ];

  return (
    <g style={{ pointerEvents: 'auto' }} transform={transform}>
      {handles.map(({ handle, point }) => (
        <circle
          cx={point[0]}
          cy={point[1]}
          fill={SELECTION_ACCENT}
          key={handle}
          onPointerDown={(event) => onBeginDrag(event, handle)}
          r="4.5"
          stroke="white"
          strokeWidth="1.5"
          style={{ cursor: `${handle.replace('-', '')}-resize` }}
        />
      ))}
    </g>
  );
}

function SelectionToolbar({
  annotations,
  onClose,
  onBeginEdit,
  onCopyText,
  onDelete,
  onUpdate,
  pageRef,
  viewport
}: {
  annotations: PdfAnnotation[];
  onClose: () => void;
  onBeginEdit: () => void;
  onCopyText?: () => void;
  onDelete: () => void;
  onUpdate: (updater: (annotation: PdfAnnotation) => PdfAnnotation) => void;
  pageRef: RefObject<HTMLDivElement | null>;
  viewport: PageViewport;
}) {
  const bounds = pdfRectToViewportRect(
    boundsForRects(annotations.map(annotationBounds)),
    viewport
  );
  const first = annotations[0];
  const showsFontSize = annotations.length === 1 && first?.kind === 'freeText';
  const showsImageSize =
    annotations.length === 1 && first?.kind === 'imageStamp';
  const showsStroke = annotations.some(hasStroke);
  const showsOpacity = annotations.some(hasOpacity);
  const showsCopyText = annotations.some(
    (annotation) => annotation.kind === 'textHighlight'
  );
  const showsColor = Boolean(first && hasColor(first));
  const showsRotate = annotations.some(
    (annotation) => annotation.kind === 'freeText' || annotation.kind === 'imageStamp'
  );
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const visibleBounds = useVisiblePageBounds(pageRef, viewport);
  const rowHeights = [
    showsColor ? 22 : 0,
    showsOpacity ? 30 : 0,
    showsStroke ? 30 : 0,
    showsFontSize ? 30 : 0,
    showsImageSize ? 30 : 0,
    showsImageSize ? 30 : 0,
    30
  ].filter((height) => height > 0);
  const toolbarHeight =
    22 +
    rowHeights.reduce((total, height) => total + height, 0) +
    Math.max(0, rowHeights.length - 1) * 8;
  const [measuredToolbarHeight, setMeasuredToolbarHeight] =
    useState(toolbarHeight);
  const [measuredToolbarWidth, setMeasuredToolbarWidth] = useState(260);
  const activeToolbarHeight = measuredToolbarHeight || toolbarHeight;
  const activeToolbarWidth = Math.min(
    Math.max(120, visibleBounds.right - visibleBounds.left),
    measuredToolbarWidth || 260
  );
  const minToolbarX = visibleBounds.left;
  const maxToolbarX = Math.max(
    minToolbarX,
    visibleBounds.right - activeToolbarWidth
  );
  const toolbarX = clamp(
    bounds.x + bounds.width / 2 - activeToolbarWidth / 2,
    minToolbarX,
    maxToolbarX
  );
  const aboveY = bounds.y - activeToolbarHeight - 4;
  const belowY = bounds.y + bounds.height + 4;
  const minToolbarY = visibleBounds.top;
  const maxToolbarY = Math.max(
    minToolbarY,
    visibleBounds.bottom - activeToolbarHeight
  );
  const preferredToolbarY =
    aboveY >= minToolbarY
      ? aboveY
      : belowY + activeToolbarHeight <= visibleBounds.bottom
        ? belowY
        : belowY;
  const toolbarY = clamp(preferredToolbarY, minToolbarY, maxToolbarY);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return;
    }

    const updateSize = () => {
      const bounds = toolbar.getBoundingClientRect();
      setMeasuredToolbarHeight(Math.ceil(bounds.height));
      setMeasuredToolbarWidth(Math.ceil(bounds.width));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  return (
    <foreignObject
      height={activeToolbarHeight}
      style={{ pointerEvents: 'auto' }}
      width={activeToolbarWidth}
      x={toolbarX}
      y={toolbarY}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div
        className="selection-toolbar"
        ref={toolbarRef}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <SettingsPanelShell>
          {first && hasColor(first) ? (
            <div onPointerDownCapture={onBeginEdit}>
              <ColorPalette
                color={first.color}
                label={null}
                onChange={(color) =>
                  onUpdate((current) =>
                    hasColor(current) ? { ...current, color } : current
                  )
                }
                onCommit={onClose}
              />
            </div>
          ) : null}
          {showsOpacity && first && hasOpacity(first) ? (
            <div onPointerDownCapture={onBeginEdit}>
              <NumberSetting
                label="Opacity"
                max={1}
                min={0.1}
                onChange={(value) =>
                  onUpdate((current) =>
                    hasOpacity(current)
                      ? { ...current, opacity: value }
                      : current
                  )
                }
                step={0.05}
                value={first.opacity}
              />
            </div>
          ) : null}
          {showsStroke && first && hasStroke(first) ? (
            <div onPointerDownCapture={onBeginEdit}>
              <NumberSetting
                label="Stroke"
                max={28}
                min={0.5}
                onChange={(value) =>
                  onUpdate((current) =>
                    hasStroke(current)
                      ? { ...current, width: value }
                      : current
                  )
                }
                step={0.1}
                value={first.width}
              />
            </div>
          ) : null}
          {showsFontSize && first.kind === 'freeText' ? (
            <div onPointerDownCapture={onBeginEdit}>
              <NumberSetting
                label="Size"
                max={48}
                min={8}
                onChange={(value) =>
                  onUpdate((current) =>
                    current.kind === 'freeText'
                      ? { ...current, fontSize: value }
                      : current
                  )
                }
                step={1}
                value={first.fontSize}
              />
            </div>
          ) : null}
          {showsImageSize && first.kind === 'imageStamp' ? (
            <>
              <div onPointerDownCapture={onBeginEdit}>
                <NumberSetting
                  label="W mm"
                  max={1000}
                  min={5}
                  onChange={(value) =>
                    onUpdate((current) =>
                      current.kind === 'imageStamp'
                        ? resizeImageStampToWidth(current, millimetresToPdfUnits(value, viewport))
                        : current
                    )
                  }
                  step={1}
                  value={pdfUnitsToMillimetres(
                    Math.abs(first.rect.x2 - first.rect.x1),
                    viewport
                  )}
                />
              </div>
              <div onPointerDownCapture={onBeginEdit}>
                <NumberSetting
                  label="H mm"
                  max={1000}
                  min={5}
                  onChange={(value) =>
                    onUpdate((current) =>
                      current.kind === 'imageStamp'
                        ? resizeImageStampToHeight(current, millimetresToPdfUnits(value, viewport))
                        : current
                    )
                  }
                  step={1}
                  value={pdfUnitsToMillimetres(
                    Math.abs(first.rect.y2 - first.rect.y1),
                    viewport
                  )}
                />
              </div>
            </>
          ) : null}
          <div className="selection-toolbar-actions">
            {showsCopyText && onCopyText ? (
              <button
                className="selection-copy-button"
                onClick={onCopyText}
                type="button"
              >
                <Copy size={14} />
                Copy text
              </button>
            ) : null}
            {showsRotate ? (
              <button
                className="selection-rotate-button"
                onClick={() =>
                  onUpdate((current) =>
                    current.kind === 'freeText' || current.kind === 'imageStamp'
                      ? { ...current, rotation: ((current.rotation ?? 0) + 90) % 360 }
                      : current
                  )
                }
                title="Rotate 90°"
                type="button"
              >
                <RotateCw size={15} />
              </button>
            ) : null}
            <button
              className="selection-delete-button"
              onClick={onDelete}
              title="Delete"
              type="button"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </SettingsPanelShell>
      </div>
    </foreignObject>
  );
}

function annotationRenderRank(annotation: PdfAnnotation) {
  switch (annotation.kind) {
    case 'textHighlight':
    case 'freehandHighlight':
      return 0;
    case 'imageStamp':
      return 1;
    case 'draw':
      return 2;
    case 'freeText':
      return 3;
    case 'stickyNote':
      return 4;
  }
}

function sameInkCanvasRenderFrame(
  previous: InkCanvasRenderState,
  displaySize: PageDisplaySize,
  scale: number,
  viewport: PageViewport
) {
  return (
    displaySizesMatch(previous.displaySize, displaySize) &&
    previous.pixelRatio === inkCanvasPixelRatio(displaySize) &&
    previous.scale === scale &&
    previous.viewportWidth === viewport.width &&
    previous.viewportHeight === viewport.height &&
    // Width/height alone can't distinguish a rotation on a square page (they
    // don't change numerically), which would otherwise let the single-added-
    // stroke fast path paint just the new stroke onto an otherwise-stale,
    // pre-rotation canvas.
    previous.viewportRotation === viewport.rotation
  );
}

function findSingleAddedInkAnnotation(
  previousAnnotations: PdfAnnotation[],
  nextAnnotations: PdfAnnotation[]
) {
  if (nextAnnotations.length !== previousAnnotations.length + 1) {
    return null;
  }

  const previousById = new Map(
    previousAnnotations.map((annotation) => [annotation.id, annotation])
  );
  let addedAnnotation: PdfAnnotation | null = null;

  for (const annotation of nextAnnotations) {
    const previousAnnotation = previousById.get(annotation.id);
    if (!previousAnnotation) {
      if (addedAnnotation) {
        return null;
      }
      addedAnnotation = annotation;
      continue;
    }

    if (previousAnnotation !== annotation) {
      return null;
    }
  }

  return addedAnnotation?.kind === 'draw' ||
    addedAnnotation?.kind === 'freehandHighlight'
    ? addedAnnotation
    : null;
}

function isCanvasBackedInkAnnotation(
  annotation: PdfAnnotation,
  selectedAnnotationIds: Set<string>
) {
  return (
    !selectedAnnotationIds.has(annotation.id) &&
    (annotation.kind === 'draw' || annotation.kind === 'freehandHighlight')
  );
}

function resolvedAccentColor(element: Element | null) {
  const source = element ?? document.documentElement;
  return (
    getComputedStyle(source).getPropertyValue('--pdfa-accent').trim() ||
    getComputedStyle(document.documentElement)
      .getPropertyValue('--app-accent')
      .trim() ||
    '#cc41bf'
  );
}

function getTextSelectionHighlightAction(
  selection: Selection | null,
  pageElement: HTMLDivElement | null,
  textLayerElement: HTMLDivElement | null,
  viewport: PageViewport
): TextSelectionHighlightAction | null {
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !pageElement ||
    !textLayerElement ||
    !selectionIntersectsElement(selection, textLayerElement)
  ) {
    return null;
  }

  const contents = selection.toString();
  if (contents.trim().length === 0) {
    return null;
  }

  const { rects, quadPoints } = getSelectedTextRects(
    selection,
    pageElement,
    textLayerElement,
    viewport
  );
  const firstRect = rects[0];
  if (!firstRect) {
    return null;
  }

  const pageBounds = pageElement.getBoundingClientRect();
  const viewportBounds = pdfRectToViewportRect(firstRect, viewport);
  const xScale = pageBounds.width / Math.max(1, viewport.width);
  const yScale = pageBounds.height / Math.max(1, viewport.height);
  // Keep in sync with .text-selection-highlight-button's height/width in
  // styles.css - used to clamp the button inside the page bounds.
  const buttonSize = 34;
  const pagePadding = 4;

  return {
    contents,
    quadPoints,
    rects,
    x: clamp(
      viewportBounds.x * xScale - buttonSize - pagePadding,
      pagePadding,
      Math.max(pagePadding, pageBounds.width - buttonSize - pagePadding)
    ),
    y: clamp(
      viewportBounds.y * yScale - buttonSize - pagePadding,
      pagePadding,
      Math.max(pagePadding, pageBounds.height - buttonSize - pagePadding)
    )
  };
}

function selectionIntersectsElement(selection: Selection, element: Element) {
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(element)) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function useVisiblePageBounds(
  pageRef: RefObject<HTMLDivElement | null>,
  viewport: PageViewport
) {
  const [bounds, setBounds] = useState<VisiblePageBounds>(() =>
    fullPageBounds(viewport)
  );

  useLayoutEffect(() => {
    let animationFrame = 0;

    const updateBounds = () => {
      animationFrame = 0;
      const nextBounds = visiblePageBounds(pageRef.current, viewport);
      setBounds((current) =>
        sameVisiblePageBounds(current, nextBounds) ? current : nextBounds
      );
    };

    const scheduleUpdate = () => {
      if (animationFrame) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateBounds);
    };

    updateBounds();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);

    const observedPage = pageRef.current;
    const observedHost = observedPage?.closest('.pdf-annotator');
    const observer = observedPage ? new ResizeObserver(scheduleUpdate) : null;
    if (observedPage) {
      observer?.observe(observedPage);
    }
    if (observedHost && observedHost !== observedPage) {
      observer?.observe(observedHost);
    }

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
      observer?.disconnect();
    };
  }, [pageRef, viewport]);

  return bounds;
}

function visiblePageBounds(
  pageElement: HTMLDivElement | null,
  viewport: PageViewport
): VisiblePageBounds {
  if (!pageElement) {
    return fullPageBounds(viewport);
  }

  const margin = 4;
  const pageRect = pageElement.getBoundingClientRect();
  const scaleX = viewport.width / Math.max(1, pageRect.width);
  const scaleY = viewport.height / Math.max(1, pageRect.height);
  const maxRight = Math.max(margin, viewport.width - margin);
  const maxBottom = Math.max(margin, viewport.height - margin);
  const hostRect =
    pageElement.closest('.pdf-annotator')?.getBoundingClientRect() ?? {
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
      top: 0
    };
  let left = clamp(
    (hostRect.left - pageRect.left) * scaleX + margin,
    margin,
    maxRight
  );
  let right = clamp(
    (hostRect.right - pageRect.left) * scaleX - margin,
    margin,
    maxRight
  );
  let top = clamp(
    (hostRect.top - pageRect.top) * scaleY + margin,
    margin,
    maxBottom
  );
  let bottom = clamp(
    (hostRect.bottom - pageRect.top) * scaleY - margin,
    margin,
    maxBottom
  );

  if (right <= left) {
    left = margin;
    right = maxRight;
  }

  if (bottom <= top) {
    top = margin;
    bottom = maxBottom;
  }

  return { bottom, left, right, top };
}

function fullPageBounds(viewport: PageViewport): VisiblePageBounds {
  const margin = 4;
  return {
    bottom: Math.max(margin, viewport.height - margin),
    left: margin,
    right: Math.max(margin, viewport.width - margin),
    top: margin
  };
}

function sameVisiblePageBounds(
  left: VisiblePageBounds,
  right: VisiblePageBounds
) {
  return (
    Math.abs(left.bottom - right.bottom) < 0.5 &&
    Math.abs(left.left - right.left) < 0.5 &&
    Math.abs(left.right - right.right) < 0.5 &&
    Math.abs(left.top - right.top) < 0.5
  );
}

function viewportDisplaySize(viewport: PageViewport): PageDisplaySize {
  return {
    height: viewport.height,
    width: viewport.width
  };
}

function displaySizeFromElement(
  element: HTMLElement | null
): PageDisplaySize | null {
  if (!element) {
    return null;
  }

  const bounds = element.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) {
    return null;
  }

  return {
    height: bounds.height,
    width: bounds.width
  };
}

function displaySizesMatch(left: PageDisplaySize, right: PageDisplaySize) {
  return (
    Math.abs(left.height - right.height) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5
  );
}

function eventToPdfPoint(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: PageViewport
) {
  return eventToPdfPoints(event, viewport).at(-1) ?? { x: 0, y: 0 };
}

function eventToPdfPoints(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: PageViewport
) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return pointerSamples(event).map((sample) =>
    viewportPointToPdfPoint(
      ...clientPointToViewportTuple(
        sample.clientX,
        sample.clientY,
        bounds,
        viewport
      ),
      viewport
    )
  );
}

function eventToPdfPointFromElement(
  event: React.PointerEvent<Element>,
  viewport: PageViewport
) {
  return eventToPdfPointsFromElement(event, viewport).at(-1) ?? { x: 0, y: 0 };
}

function eventToPdfPointsFromElement(
  event: React.PointerEvent<Element>,
  viewport: PageViewport
) {
  const pageElement = (event.currentTarget as Element).closest('.pdf-page');
  const bounds = pageElement?.getBoundingClientRect();

  if (!bounds) {
    return [];
  }

  return pointerSamples(event).map((sample) =>
    viewportPointToPdfPoint(
      ...clientPointToViewportTuple(
        sample.clientX,
        sample.clientY,
        bounds,
        viewport
      ),
      viewport
    )
  );
}

function eventToViewportPoint(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: PageViewport
) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const sample = pointerSamples(event).at(-1) ?? event.nativeEvent;
  return clientPointToViewportPoint(
    sample.clientX,
    sample.clientY,
    bounds,
    viewport
  );
}

function clientPointToViewportTuple(
  clientX: number,
  clientY: number,
  bounds: DOMRect,
  viewport: PageViewport
): [number, number] {
  const point = clientPointToViewportPoint(clientX, clientY, bounds, viewport);
  return [point.x, point.y];
}

function clientPointToViewportPoint(
  clientX: number,
  clientY: number,
  bounds: DOMRect,
  viewport: PageViewport
) {
  const scaleX = viewport.width / Math.max(1, bounds.width);
  const scaleY = viewport.height / Math.max(1, bounds.height);
  return {
    x: clamp((clientX - bounds.left) * scaleX, 0, viewport.width),
    y: clamp((clientY - bounds.top) * scaleY, 0, viewport.height)
  };
}

function pointerSamples(event: React.PointerEvent<Element>) {
  const nativeEvent = event.nativeEvent;
  const coalesced =
    typeof nativeEvent.getCoalescedEvents === 'function'
      ? nativeEvent.getCoalescedEvents()
      : [];
  const samples = coalesced.length > 0 ? [...coalesced] : [nativeEvent];
  const last = samples.at(-1);
  if (
    !last ||
    last.clientX !== nativeEvent.clientX ||
    last.clientY !== nativeEvent.clientY
  ) {
    samples.push(nativeEvent);
  }
  return samples;
}

function nearestTextHitRect(
  point: { x: number; y: number },
  hitRects: TextHitRect[],
  tolerance: { x: number; y: number }
) {
  let best: TextHitRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const textRect of hitRects) {
    const rect = textRect.viewportRect;
    const dx =
      point.x < rect.x
        ? rect.x - point.x
        : point.x > rect.x + rect.width
          ? point.x - (rect.x + rect.width)
          : 0;
    const dy =
      point.y < rect.y
        ? rect.y - point.y
        : point.y > rect.y + rect.height
          ? point.y - (rect.y + rect.height)
          : 0;

    if (dx > tolerance.x || dy > tolerance.y) {
      continue;
    }

    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = textRect;
    }
  }

  return best;
}

function releasePointer(event: React.PointerEvent, pointerId: number) {
  try {
    (event.target as Element).releasePointerCapture?.(pointerId);
  } catch {
    // Capture may already have ended if the pointer left the original element.
  }
}

function shouldRenderExistingAnnotationInPdfJsLayer(
  annotation: ExistingPdfAnnotation,
  _annotationIndex: number
) {
  return annotation.annotationType === AnnotationType.LINK;
}

function shouldRenderExistingAnnotationInAppearanceOverlay(
  annotation: ExistingPdfAnnotation,
  pageAnnotations: PdfAnnotation[],
  pageIndex: number
) {
  if (
    annotation.annotationType === AnnotationType.LINK ||
    annotation.annotationType === AnnotationType.POPUP ||
    annotation.annotationType === AnnotationType.WIDGET ||
    isReadOnlyTextMarkupAnnotation(annotation)
  ) {
    return false;
  }

  return !isManagedExistingAnnotation(annotation, pageAnnotations, pageIndex);
}

function isReadOnlyTextMarkupAnnotation(annotation: ExistingPdfAnnotation) {
  if (isEditableExistingAnnotation(annotation)) {
    return false;
  }

  return (
    annotation.annotationType === AnnotationType.UNDERLINE ||
    annotation.annotationType === AnnotationType.SQUIGGLY ||
    annotation.annotationType === AnnotationType.STRIKEOUT
  );
}

// pdf.js's Stamp metadata can't tell us on its own whether a stamp will
// import as an editable image (that requires the async pdf-lib byte
// extraction in annotationImport.ts) - so instead of duplicating that
// structural check here, this looks at whether the import already
// succeeded, i.e. whether a matching imported `imageStamp` annotation is
// currently present. That keeps the "hide the native PDF rendering" and
// "did the import work" decisions from ever disagreeing, which would
// otherwise either double-render the stamp or make it vanish.
function isManagedExistingAnnotation(
  annotation: ExistingPdfAnnotation,
  pageAnnotations: PdfAnnotation[],
  pageIndex: number
) {
  if (annotation.annotationType === AnnotationType.STAMP) {
    const importedId = `imported-${pageIndex}-${existingAnnotationId(annotation)}`;
    return pageAnnotations.some(
      (candidate) => candidate.kind === 'imageStamp' && candidate.id === importedId
    );
  }

  return isEditableExistingAnnotation(annotation);
}

function keepOnlyChangedPixelsInAnnotationRects(
  appearance: ImageData,
  base: ImageData,
  existingAnnotations: ExistingPdfAnnotation[],
  pageAnnotations: PdfAnnotation[],
  pageIndex: number,
  viewport: PageViewport,
  scaleX: number,
  scaleY: number
) {
  const appearanceData = appearance.data;
  const baseData = base.data;
  const threshold = 8;
  const sourceAlphaByPixel = new Uint8ClampedArray(appearanceData.length / 4);
  for (let index = 3, pixelIndex = 0; index < appearanceData.length; index += 4) {
    sourceAlphaByPixel[pixelIndex] = appearanceData[index];
    appearanceData[index] = 0;
    pixelIndex += 1;
  }

  for (const annotation of existingAnnotations) {
    if (
      !shouldRenderExistingAnnotationInAppearanceOverlay(
        annotation,
        pageAnnotations,
        pageIndex
      )
    ) {
      continue;
    }

    const rect = existingAnnotationViewportRect(annotation, viewport);
    if (!rect) {
      continue;
    }

    for (const pixelIndex of annotationPixelIndexes(
      rect,
      appearance.width,
      appearance.height,
      scaleX,
      scaleY
    )) {
      const index = pixelIndex * 4;
      const sourceAlpha = sourceAlphaByPixel[pixelIndex];
      if (sourceAlpha <= 16) {
        appearanceData[index + 3] = 0;
        continue;
      }

      const difference =
        Math.abs(appearanceData[index] - baseData[index]) +
        Math.abs(appearanceData[index + 1] - baseData[index + 1]) +
        Math.abs(appearanceData[index + 2] - baseData[index + 2]) +
        Math.abs(sourceAlpha - baseData[index + 3]);

      appearanceData[index + 3] =
        difference > threshold ? sourceAlpha : 0;
    }
  }
}

function* annotationPixelIndexes(
  rect: ViewportRect,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number
) {
  const padding = 12;
  const left = clamp(
    Math.floor((rect.x - padding) * scaleX),
    0,
    Math.max(0, width - 1)
  );
  const right = clamp(
    Math.ceil((rect.x + rect.width + padding) * scaleX),
    left,
    width
  );
  const top = clamp(
    Math.floor((rect.y - padding) * scaleY),
    0,
    Math.max(0, height - 1)
  );
  const bottom = clamp(
    Math.ceil((rect.y + rect.height + padding) * scaleY),
    top,
    height
  );

  for (let y = top; y < bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x < right; x += 1) {
      yield rowOffset + x;
    }
  }
}

function clearManagedAnnotationRectsFromAppearanceOverlay(
  context: CanvasRenderingContext2D,
  existingAnnotations: ExistingPdfAnnotation[],
  pageAnnotations: PdfAnnotation[],
  pageIndex: number,
  viewport: PageViewport,
  scaleX: number,
  scaleY: number
) {
  const padding = 8;
  existingAnnotations.forEach((annotation) => {
    if (
      !isManagedExistingAnnotation(annotation, pageAnnotations, pageIndex) &&
      !isReadOnlyTextMarkupAnnotation(annotation)
    ) {
      return;
    }

    const rect = existingAnnotationViewportRect(annotation, viewport);
    if (!rect) {
      return;
    }

    context.clearRect(
      Math.floor((rect.x - padding) * scaleX),
      Math.floor((rect.y - padding) * scaleY),
      Math.ceil((rect.width + padding * 2) * scaleX),
      Math.ceil((rect.height + padding * 2) * scaleY)
    );
  });
}

function existingAnnotationViewportRect(
  annotation: ExistingPdfAnnotation,
  viewport: PageViewport
) {
  if (!Array.isArray(annotation.rect) && !(annotation.rect instanceof Float32Array)) {
    return null;
  }

  const rect = Array.from(annotation.rect).map(Number);
  if (rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) {
    return null;
  }

  return pdfArrayRectToViewportRect(rect.slice(0, 4), viewport);
}

function drawReadOnlyTextDecorations(
  context: CanvasRenderingContext2D,
  annotations: ExistingPdfAnnotation[],
  viewport: PageViewport,
  scaleX: number,
  scaleY: number,
  scale: number
) {
  context.save();
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  context.lineCap = 'round';
  context.lineJoin = 'round';

  for (const annotation of annotations) {
    if (!isReadOnlyTextMarkupAnnotation(annotation)) {
      continue;
    }

    const rects = textMarkupViewportRects(annotation, viewport);
    context.strokeStyle = rgbToCss(existingAnnotationColor(annotation));
    context.globalAlpha = existingAnnotationOpacity(annotation);
    context.lineWidth = existingAnnotationStrokeWidth(annotation, scale);

    for (const rect of rects) {
      switch (annotation.annotationType) {
        case AnnotationType.UNDERLINE:
          strokeLine(
            context,
            rect.x,
            rect.y + rect.height * 0.9,
            rect.x + rect.width,
            rect.y + rect.height * 0.9
          );
          break;

        case AnnotationType.SQUIGGLY:
          strokeSquigglyRect(context, rect);
          break;

        case AnnotationType.STRIKEOUT:
          strokeLine(
            context,
            rect.x,
            rect.y + rect.height * 0.55,
            rect.x + rect.width,
            rect.y + rect.height * 0.55
          );
          break;
      }
    }
  }

  context.restore();
}

function textMarkupViewportRects(
  annotation: ExistingPdfAnnotation,
  viewport: PageViewport
) {
  const quadPoints = flatNumberArray(annotation.quadPoints);
  const rects: ViewportRect[] = [];

  for (let index = 0; index + 7 < quadPoints.length; index += 8) {
    const xs = [
      quadPoints[index],
      quadPoints[index + 2],
      quadPoints[index + 4],
      quadPoints[index + 6]
    ];
    const ys = [
      quadPoints[index + 1],
      quadPoints[index + 3],
      quadPoints[index + 5],
      quadPoints[index + 7]
    ];
    if (![...xs, ...ys].every(Number.isFinite)) {
      continue;
    }

    rects.push(
      pdfArrayRectToViewportRect(
        [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        viewport
      )
    );
  }

  const fallbackRect = existingAnnotationViewportRect(annotation, viewport);
  return rects.length > 0 ? rects : fallbackRect ? [fallbackRect] : [];
}

function strokeSquigglyRect(
  context: CanvasRenderingContext2D,
  rect: ViewportRect
) {
  const amplitude = Math.max(1, Math.min(2.5, rect.height * 0.12));
  const wavelength = Math.max(4, rect.height * 0.45);
  const baseline = rect.y + rect.height * 0.9;
  const endX = rect.x + rect.width;

  context.beginPath();
  context.moveTo(rect.x, baseline);
  for (let x = rect.x; x <= endX; x += wavelength / 2) {
    const nextX = Math.min(x + wavelength / 2, endX);
    const controlX = (x + nextX) / 2;
    const controlY =
      baseline + (Math.floor((x - rect.x) / (wavelength / 2)) % 2 === 0
        ? -amplitude
        : amplitude);
    context.quadraticCurveTo(controlX, controlY, nextX, baseline);
  }
  context.stroke();
}

function strokeLine(
  context: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function flatNumberArray(value: unknown) {
  if (!value || typeof value === 'string') {
    return [];
  }

  if (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    return [];
  }

  return Array.from(value as Iterable<unknown>)
    .map(Number)
    .filter(Number.isFinite);
}

function existingAnnotationColor(
  annotation: ExistingPdfAnnotation
): [number, number, number] {
  const color = annotation.color;
  if (!color || typeof color === 'string') {
    return [0.05, 0.2, 0.42];
  }

  const channels = flatNumberArray(color);
  if (channels.length < 3) {
    return [0.05, 0.2, 0.42];
  }

  const divisor = channels.some((channel) => channel > 1) ? 255 : 1;
  return [
    clamp(channels[0] / divisor, 0, 1),
    clamp(channels[1] / divisor, 0, 1),
    clamp(channels[2] / divisor, 0, 1)
  ];
}

function existingAnnotationOpacity(annotation: ExistingPdfAnnotation) {
  const opacity = annotation.opacity ?? annotation.ca;
  return typeof opacity === 'number' && Number.isFinite(opacity)
    ? clamp(opacity, 0, 1)
    : 1;
}

function existingAnnotationStrokeWidth(
  annotation: ExistingPdfAnnotation,
  scale: number
) {
  const rawWidth =
    typeof annotation.borderStyle?.rawWidth === 'number'
      ? annotation.borderStyle.rawWidth
      : typeof annotation.borderStyle?.width === 'number'
        ? annotation.borderStyle.width
        : 1;
  return Math.max(1, rawWidth * scale);
}

function clearCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function shouldUseRasterFallback(container: HTMLDivElement) {
  const canvas = container.querySelector<HTMLCanvasElement>(
    '.canvasWrapper canvas'
  );
  return !canvas || canvasLooksEmpty(canvas);
}

async function renderRasterFallback(
  page: PDFPageProxy,
  viewport: PageViewport,
  container: HTMLDivElement,
  annotationMode: number,
  onRenderTask: (renderTask: ReturnType<PDFPageProxy['render']>) => void
) {
  const pdfPage =
    container.querySelector<HTMLDivElement>('.page') ??
    createFallbackPdfPage(container, viewport);
  pdfPage.style.width = `${viewport.width}px`;
  pdfPage.style.height = `${viewport.height}px`;

  const canvasWrapper =
    pdfPage.querySelector<HTMLDivElement>('.canvasWrapper') ??
    createFallbackCanvasWrapper(pdfPage);
  canvasWrapper.replaceChildren();

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const pixelRatio = safeCanvasPixelRatio(
    viewport.width,
    viewport.height,
    Math.max(2, window.devicePixelRatio || 1)
  );
  canvas.width = Math.ceil(viewport.width * pixelRatio);
  canvas.height = Math.ceil(viewport.height * pixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  canvasWrapper.append(canvas);

  const renderTask = page.render({
    annotationMode,
    canvas,
    canvasContext: context,
    viewport
  });
  onRenderTask(renderTask);
  await renderTask.promise;
  return canvas;
}

function createFallbackPdfPage(container: HTMLDivElement, viewport: PageViewport) {
  const pdfPage = document.createElement('div');
  pdfPage.className = 'page';
  pdfPage.setAttribute('data-page-number', String(viewport.viewBox[3] || 1));
  container.append(pdfPage);
  return pdfPage;
}

function createFallbackCanvasWrapper(pdfPage: HTMLDivElement) {
  const canvasWrapper = document.createElement('div');
  canvasWrapper.className = 'canvasWrapper';
  pdfPage.prepend(canvasWrapper);
  return canvasWrapper;
}

function isRenderCancellation(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'RenderingCancelledException' ||
      error.message.includes('cancelled'))
  );
}

function disposeCanvases(container: Element) {
  for (const canvas of container.querySelectorAll('canvas')) {
    releaseCanvasBuffer(canvas);
  }
}

function releaseCanvasBuffer(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

function isAnnotationCreationTool(tool: Tool) {
  return (
    tool === 'draw' ||
    tool === 'highlight' ||
    tool === 'textHighlight' ||
    tool === 'freehandHighlight' ||
    tool === 'freeText' ||
    tool === 'stickyNote'
  );
}

const TYPE_ERASER_MIN_DISTANCE_PX = 5;

function appendPdfPoints(path: PdfPoint[], points: PdfPoint[]) {
  return appendMutablePdfPoints([...path], points);
}

function appendMutablePdfPoints(path: PdfPoint[], points: PdfPoint[]) {
  for (const point of points) {
    appendMutableInkPoint(path, point, Number.EPSILON);
  }
  return path;
}

function cachedPathBounds(
  path: PdfPoint[],
  cache: WeakMap<PdfPoint[], PdfRect>
) {
  const cached = cache.get(path);
  if (cached) {
    return cached;
  }

  const bounds = boundsForPoints(path);
  cache.set(path, bounds);
  return bounds;
}

function expandedRectContainsPoint(
  rect: PdfRect,
  point: PdfPoint,
  padding: number
) {
  return (
    point.x >= Math.min(rect.x1, rect.x2) - padding &&
    point.x <= Math.max(rect.x1, rect.x2) + padding &&
    point.y >= Math.min(rect.y1, rect.y2) - padding &&
    point.y <= Math.max(rect.y1, rect.y2) + padding
  );
}

function typeEraserMinLength(viewport: PageViewport) {
  const start = viewportPointToPdfPoint(0, 0, viewport);
  const end = viewportPointToPdfPoint(TYPE_ERASER_MIN_DISTANCE_PX, 0, viewport);
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function schedulePriorityTask(
  priority: PageRenderPriority,
  task: () => void | Promise<void>
) {
  if (priority === 'visible') {
    void task();
    return () => undefined;
  }

  if (priority === 'near') {
    const timeout = window.setTimeout(() => void task(), 0);
    return () => window.clearTimeout(timeout);
  }

  if (window.requestIdleCallback && window.cancelIdleCallback) {
    const handle = window.requestIdleCallback(() => void task(), {
      timeout: 1200
    });
    return () => window.cancelIdleCallback(handle);
  }

  const timeout = window.setTimeout(() => void task(), 180);
  return () => window.clearTimeout(timeout);
}

function hasOpacity(
  annotation: PdfAnnotation
): annotation is Extract<PdfAnnotation, { opacity: number }> {
  return (
    annotation.kind === 'textHighlight' ||
    annotation.kind === 'draw' ||
    annotation.kind === 'freehandHighlight' ||
    annotation.kind === 'freeText'
  );
}

function hasColor(
  annotation: PdfAnnotation
): annotation is Extract<PdfAnnotation, { color: [number, number, number] }> {
  return annotation.kind !== 'imageStamp';
}

function hasStroke(
  annotation: PdfAnnotation
): annotation is Extract<PdfAnnotation, { width: number }> {
  return annotation.kind === 'draw' || annotation.kind === 'freehandHighlight';
}

function isTextLayerTarget(target: EventTarget) {
  return target instanceof Element && Boolean(target.closest('.textLayer span'));
}

function isPdfLinkTarget(target: EventTarget) {
  return target instanceof Element && Boolean(target.closest('.annotationLayer a'));
}

function pageBackgroundColor(element: HTMLElement | null) {
  const value = element
    ? getComputedStyle(element).getPropertyValue('--pdfa-page').trim()
    : '';
  return value || 'white';
}

function isEditingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'TEXTAREA' ||
      target.tagName === 'INPUT' ||
      target.isContentEditable)
  );
}
