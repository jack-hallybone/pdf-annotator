import { Copy, Highlighter, Trash2 } from 'lucide-react';
import {
  memo,
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
  PageRenderPriority,
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
  inkPathCommands,
  isLassoSelectableAnnotation,
  nearestRectIndex,
  pathHitTest,
  pathLength,
  rectToQuadPoints,
  resampleInkPath,
  simplifyInkPath
} from './annotationGeometry';
import {
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
  nearestTextRectIndex,
  type TextLayerRect,
  textLayerSegmentsInRange,
  textLayerSegmentsToHighlightRects,
  textRectOverlapsHighlight
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
import {
  FREE_TEXT_LINE_HEIGHT,
  FREE_TEXT_MAX_WIDTH,
  FREE_TEXT_MIN_WIDTH
} from './freeTextLayout';

type PageViewport = ReturnType<PDFPageProxy['getViewport']>;
type EraserScope = 'all' | 'draw' | 'highlight';
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
  path: PdfPoint[];
};
type EraserGesture = {
  pendingUntilDrag: boolean;
};
type EraserAnnotationIndexEntry = {
  annotation: PdfAnnotation;
  bounds: PdfRect;
};
type EraserAnnotationIndex = {
  cellSize: number;
  grid: Map<string, EraserAnnotationIndexEntry[]>;
  queryPadding: number;
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
type PageDisplaySize = {
  height: number;
  width: number;
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
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
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
              console.error(error);
              console.error(fallbackError);
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
        .catch((error) => {
          if (!cancelled) {
            console.error(error);
          }
        });
    });

    return () => {
      cancelled = true;
      cancelScheduledRead();
    };
  }, [baseLayerReady, page, renderPriority]);

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
        (annotation, index) =>
          shouldRenderExistingAnnotationInAppearanceOverlay(annotation, index)
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
          viewport,
          scaleX,
          scaleY
        );
        context.putImageData(appearancePixels, 0, 0);
        clearManagedAnnotationRectsFromAppearanceOverlay(
          context,
          existingAnnotations,
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
          console.error(error);
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
    page,
    renderPriority,
    showAnnotations,
    viewport
  ]);

  useEffect(() => {
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
        renderForms: false
      });
    }

    renderAnnotationLayer().catch(console.error);

    return () => {
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
        if (tool === 'select') {
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
      beginDraftInkPath('freehandHighlight', point);
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

    if (tool === 'highlight' && draftTextHighlight) {
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

    if (tool !== 'highlight' || !draftInkPathRef.current) {
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

    if (tool === 'highlight' && draftTextHighlight) {
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

    if (tool !== 'highlight' || !draftInkPathRef.current) {
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

    if (
      !draftInkPathRef.current ||
      (tool !== 'draw' && tool !== 'freehandHighlight')
    ) {
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

    if (
      draftInkPathRef.current &&
      (tool === 'draw' || tool === 'freehandHighlight')
    ) {
      const path = appendDraftInkPath(eventToPdfPoints(event, viewport));
      const normalizedPath =
        tool === 'draw' && pathLength(path) <= inkDotMaxLength(viewport)
          ? dotPath(path[0], toolSettings.drawWidth)
          : normalizeDraftInkPath(path, viewport);
      let annotation: PdfAnnotation | null = null;
      if (
        (tool === 'draw'
          ? normalizedPath.length > 0
          : path.length > 2) &&
        (tool !== 'freehandHighlight' ||
          pathLength(path) > freehandHighlightMinLength(viewport))
      ) {
        annotation = {
          id: crypto.randomUUID(),
          kind: tool,
          pageIndex,
          paths: [normalizedPath],
          color:
            tool === 'draw'
              ? toolSettings.drawColor
              : toolSettings.highlightColor,
          opacity:
            tool === 'draw'
              ? toolSettings.drawOpacity
              : toolSettings.highlightOpacity,
          width:
            tool === 'draw'
              ? toolSettings.drawWidth
              : toolSettings.highlightWidth,
          contents:
            tool === 'draw' ? 'Freehand drawing' : 'Freehand highlight'
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

  function beginMoveAnnotation(
    event: React.PointerEvent<SVGGElement>,
    annotationId: string
  ) {
    if (readOnly || tool !== 'select') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const captureTarget = event.currentTarget.ownerSVGElement ?? event.currentTarget;
    beginMoveAnnotationAtPoint({
      annotationId,
      captureTarget,
      point: eventToPdfPointFromElement(event, viewport),
      pointerId: event.pointerId
    });
  }

  function beginMoveAnnotationAtPoint({
    annotationId,
    captureTarget,
    point,
    pointerId
  }: {
    annotationId: string;
    captureTarget: Element;
    point: PdfPoint;
    pointerId: number;
  }) {
    const targetAnnotation = annotations.find(
      (annotation) => annotation.id === annotationId
    );
    if (targetAnnotation?.kind === 'textHighlight') {
      return;
    }

    const selectedOnPage = selectedAnnotationIds.filter((id) =>
      annotations.some((annotation) => annotation.id === id)
    );
    const annotationIds = selectedOnPage.includes(annotationId)
      ? selectedOnPage
      : [annotationId];
    onBeginAnnotationEdit({ finishOnPointerUp: true });
    captureTarget.setPointerCapture?.(pointerId);
    const nextDragSelection = {
      annotationIds,
      lastPoint: point,
      pageIndex,
      pointerId
    };
    dragSelectionRef.current = nextDragSelection;
  }

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
    const deleteIds: string[] = [];

    const pathUpdates: AnnotationPathUpdate[] = [];

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
        deleteIds.push(annotation.id);
        eraserDeletedIdsRef.current.add(annotation.id);
      }
    }

    queueEraseAnnotationChanges(deleteIds, pathUpdates);
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
    suppressNextContextMenuRef.current = !requireMovement;
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

    void navigator.clipboard.writeText(text).catch(console.error);
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
    point: PdfPoint
  ) {
    clearDraftInkCanvases();
    draftInkPathRef.current = { kind, path: [point] };
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
                  onBeginHighlightHandleDrag={() => undefined}
                  onBeginFreeTextResizeHandleDrag={() => undefined}
                  onBeginImageStampResizeHandleDrag={() => undefined}
                  onBeginMoveDrag={beginMoveAnnotation}
                  onHoverChange={(hovered) =>
                    setHoveredAnnotationId(hovered ? annotation.id : null)
                  }
                  onBeginEdit={onBeginAnnotationEdit}
                  onFocusEnd={onFocusAnnotationConsumed}
                  onSelect={() => {
                    onActivate(pageIndex);
                    onSelectAnnotations([annotation.id]);
                  }}
                  onUpdate={(updater) =>
                    onUpdateAnnotation(annotation.id, updater, {
                      recordUndo: false
                    })
                  }
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
            {draftTextHighlightRects.map((rect, index) => {
              const bounds = pdfRectToViewportRect(rect, viewport);
              return (
                <rect
                  fill={rgbToCss(toolSettings.highlightColor)}
                  height={bounds.height}
                  key={`draft-text-highlight-${index}`}
                  opacity={toolSettings.highlightOpacity}
                  style={TEXT_HIGHLIGHT_STYLE}
                  width={bounds.width}
                  x={bounds.x}
                  y={bounds.y}
                />
              );
            })}
            {showSynchronizedAnnotations ? vectorDisplayAnnotations.map((annotation) => (
              <AnnotationShape
                annotation={annotation}
                focused={focusedAnnotationId === annotation.id}
                key={annotation.id}
                onBeginHighlightHandleDrag={(event, handle) => {
                  event.stopPropagation();
                  onBeginAnnotationEdit({ finishOnPointerUp: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const geometry = getActiveTextGeometry();
                  setDragHandle({
                    anchorIndex:
                      annotation.kind === 'textHighlight'
                        ? oppositeHighlightHandleAnchor(
                            annotation,
                            handle,
                            geometry.textRects
                          )
                        : null,
                    annotationId: annotation.id,
                    handle,
                    pointerId: event.pointerId
                  });
                }}
                onBeginFreeTextResizeHandleDrag={(event, handle) => {
                  event.stopPropagation();
                  onBeginAnnotationEdit({ finishOnPointerUp: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setFreeTextResizeHandle({
                    annotationId: annotation.id,
                    handle,
                    pointerId: event.pointerId
                  });
                }}
                onBeginImageStampResizeHandleDrag={(event, handle) => {
                  event.stopPropagation();
                  onBeginAnnotationEdit({ finishOnPointerUp: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setImageStampResizeHandle({
                    annotationId: annotation.id,
                    handle,
                    pointerId: event.pointerId
                  });
                }}
                onBeginMoveDrag={beginMoveAnnotation}
                onHoverChange={(hovered) =>
                  setHoveredAnnotationId(hovered ? annotation.id : null)
                }
                onBeginEdit={onBeginAnnotationEdit}
                onFocusEnd={onFocusAnnotationConsumed}
                onSelect={() => {
                  onActivate(pageIndex);
                  onSelectAnnotations([annotation.id]);
                }}
                onUpdate={(updater) =>
                  onUpdateAnnotation(annotation.id, updater, {
                    recordUndo: false
                  })
                }
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

function AnnotationShape({
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
    handle: 'left' | 'right'
  ) => void;
  onBeginImageStampResizeHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: ImageStampResizeHandle['handle']
  ) => void;
  onBeginHighlightHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: 'start' | 'end'
  ) => void;
  onBeginMoveDrag: (
    event: React.PointerEvent<SVGGElement>,
    annotationId: string
  ) => void;
  onFocusEnd: (annotationId: string) => void;
  onHoverChange: (hovered: boolean) => void;
  onSelect: () => void;
  onUpdate: (updater: (annotation: PdfAnnotation) => PdfAnnotation) => void;
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
          (annotation.kind === 'textHighlight' ||
            annotation.kind === 'freehandHighlight' ||
            annotation.kind === 'draw') &&
          !selected
        ) {
          onSelect();
        }
        return;
      }

      if (tool !== 'select') {
        return;
      }

      event.preventDefault();
      if (!selected) {
        onSelect();
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
    onPointerEnter: () => onHoverChange(true),
    onPointerLeave: () => onHoverChange(false),
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
                <rect
                  fill={rgbToCss(annotation.color)}
                  height={bounds.height}
                  opacity={annotation.opacity}
                  style={TEXT_HIGHLIGHT_STYLE}
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
              onBeginDrag={onBeginHighlightHandleDrag}
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
      const editable = selected || focused;
      return (
        <g {...commonProps}>
          <foreignObject
            height={rect.height}
            width={rect.width}
            x={rect.x}
            y={rect.y}
          >
            {editable ? (
              <AutoFocusTextarea
                autoFocus={focused}
                className="free-text-editor"
                ignoreInitialBlurMs={
                  focused && annotation.text.trim().length === 0 ? 750 : 0
                }
                onChange={(event) =>
                  onUpdate((current) =>
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
              onBeginDrag={onBeginFreeTextResizeHandleDrag}
              viewport={viewport}
            />
          ) : null}
        </g>
      );
    }

    case 'imageStamp': {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      return (
        <g {...commonProps}>
          <image
            height={rect.height}
            href={`data:${annotation.mimeType};base64,${annotation.imageData}`}
            preserveAspectRatio="xMidYMid meet"
            width={rect.width}
            x={rect.x}
            y={rect.y}
          />
          {selected ? (
            <>
              <rect
                fill="none"
                height={rect.height}
                stroke={SELECTION_ACCENT}
                strokeDasharray="4 3"
                strokeWidth="1.5"
                width={rect.width}
                x={rect.x}
                y={rect.y}
              />
              <ImageStampResizeHandles
                annotation={annotation}
                onBeginDrag={onBeginImageStampResizeHandleDrag}
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
                onUpdate((current) =>
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
}

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
  const centerY = bounds.y + bounds.height / 2;

  return (
    <g style={{ pointerEvents: 'auto' }}>
      <circle
        className="free-text-width-handle"
        cx={bounds.x}
        cy={centerY}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, 'left')}
        r="5"
        stroke="white"
        strokeWidth="2"
      />
      <circle
        className="free-text-width-handle"
        cx={bounds.x + bounds.width}
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
  return (
    <g style={{ pointerEvents: 'auto' }}>
      <rect
        fill="none"
        height={rect.height}
        stroke={SELECTION_ACCENT}
        strokeDasharray="4 3"
        strokeWidth="1.5"
        width={rect.width}
        x={rect.x}
        y={rect.y}
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
  const rect = annotation.rect;
  const handles: Array<{
    handle: ImageStampResizeHandle['handle'];
    point: [number, number];
  }> = [
    {
      handle: 'top-left',
      point: viewport.convertToViewportPoint(rect.x1, rect.y2) as [number, number]
    },
    {
      handle: 'top-right',
      point: viewport.convertToViewportPoint(rect.x2, rect.y2) as [number, number]
    },
    {
      handle: 'bottom-left',
      point: viewport.convertToViewportPoint(rect.x1, rect.y1) as [number, number]
    },
    {
      handle: 'bottom-right',
      point: viewport.convertToViewportPoint(rect.x2, rect.y1) as [number, number]
    }
  ];

  return (
    <g style={{ pointerEvents: 'auto' }}>
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
    previous.viewportHeight === viewport.height
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

function buildEraserAnnotationIndex(
  annotations: PdfAnnotation[],
  scale: number,
  eraserWidth: number
): EraserAnnotationIndex {
  const entries = annotations.map((annotation) => ({
    annotation,
    bounds: annotationBounds(annotation)
  }));
  const eraserRadius = Math.max(eraserWidth / 2 / scale, 1 / scale);
  const maxInkPadding = entries.reduce((maxPadding, { annotation }) => {
    if (annotation.kind !== 'draw' && annotation.kind !== 'freehandHighlight') {
      return maxPadding;
    }

    return Math.max(maxPadding, annotation.width * 1.4);
  }, 0);
  const queryPadding = Math.max(eraserRadius, maxInkPadding, 6 / scale);
  const cellSize = Math.max(32 / scale, queryPadding * 2, 16);
  const grid = new Map<string, EraserAnnotationIndexEntry[]>();

  for (const entry of entries) {
    if (!isFiniteRect(entry.bounds)) {
      continue;
    }

    forEachGridCell(entry.bounds, cellSize, queryPadding, (key) => {
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        grid.set(key, [entry]);
      }
    });
  }

  return { cellSize, grid, queryPadding };
}

function queryEraserAnnotationIndex(
  index: EraserAnnotationIndex,
  point: PdfPoint
) {
  const candidates = new Map<string, EraserAnnotationIndexEntry>();
  const queryBounds = {
    x1: point.x,
    y1: point.y,
    x2: point.x,
    y2: point.y
  };

  forEachGridCell(queryBounds, index.cellSize, index.queryPadding, (key) => {
    for (const entry of index.grid.get(key) ?? []) {
      candidates.set(entry.annotation.id, entry);
    }
  });

  return candidates.values();
}

function forEachGridCell(
  bounds: PdfRect,
  cellSize: number,
  padding: number,
  callback: (key: string) => void
) {
  const minX = Math.floor((Math.min(bounds.x1, bounds.x2) - padding) / cellSize);
  const maxX = Math.floor((Math.max(bounds.x1, bounds.x2) + padding) / cellSize);
  const minY = Math.floor((Math.min(bounds.y1, bounds.y2) - padding) / cellSize);
  const maxY = Math.floor((Math.max(bounds.y1, bounds.y2) + padding) / cellSize);

  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      callback(`${x}:${y}`);
    }
  }
}

function isFiniteRect(rect: PdfRect) {
  return (
    Number.isFinite(rect.x1) &&
    Number.isFinite(rect.y1) &&
    Number.isFinite(rect.x2) &&
    Number.isFinite(rect.y2)
  );
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

function clearDisplayCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) {
    return;
  }

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function renderInkCanvasLayer({
  annotations,
  canvas,
  displaySize,
  kind,
  scale,
  viewport
}: {
  annotations: PdfAnnotation[];
  canvas: HTMLCanvasElement | null;
  displaySize: PageDisplaySize;
  kind: 'draw' | 'freehandHighlight';
  scale: number;
  viewport: PageViewport;
}) {
  const context = prepareInkCanvasContext({
    canvas,
    clear: true,
    displaySize,
    viewport
  });
  if (!context) {
    return;
  }

  for (const annotation of annotations) {
    if (annotation.kind === kind) {
      drawInkAnnotationOnContext(context, annotation, scale, viewport);
    }
  }

  context.globalAlpha = 1;
}

function drawInkCanvasAnnotation({
  annotation,
  canvas,
  clear,
  displaySize,
  scale,
  viewport
}: {
  annotation: Extract<PdfAnnotation, { kind: 'draw' | 'freehandHighlight' }>;
  canvas: HTMLCanvasElement | null;
  clear: boolean;
  displaySize: PageDisplaySize;
  scale: number;
  viewport: PageViewport;
}) {
  const context = prepareInkCanvasContext({
    canvas,
    clear,
    displaySize,
    viewport
  });
  if (!context) {
    return;
  }

  drawInkAnnotationOnContext(context, annotation, scale, viewport);
  context.globalAlpha = 1;
}

function renderPdfPathCanvas({
  canvas,
  color,
  displaySize,
  opacity,
  path,
  viewport,
  width
}: {
  canvas: HTMLCanvasElement | null;
  color: string;
  displaySize: PageDisplaySize;
  opacity: number;
  path: PdfPoint[];
  viewport: PageViewport;
  width: number;
}) {
  const context = prepareInkCanvasContext({
    canvas,
    clear: true,
    displaySize,
    viewport
  });
  if (!context) {
    return;
  }

  context.globalAlpha = clamp(opacity, 0, 1);
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineWidth = Math.max(0.25, width);
  drawInkCanvasPath(context, path, viewport, false, width);
  context.globalAlpha = 1;
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

function eraseInkCanvasPaths({
  annotation,
  canvas,
  displaySize,
  paths,
  scale,
  viewport
}: {
  annotation: Extract<PdfAnnotation, { kind: 'draw' | 'freehandHighlight' }>;
  canvas: HTMLCanvasElement | null;
  displaySize: PageDisplaySize;
  paths: PdfPoint[][];
  scale: number;
  viewport: PageViewport;
}) {
  const context = prepareInkCanvasContext({
    canvas,
    clear: false,
    displaySize,
    viewport
  });
  if (!context) {
    return;
  }

  const previousComposite = context.globalCompositeOperation;
  context.globalCompositeOperation = 'destination-out';
  context.globalAlpha = 1;
  context.fillStyle = '#000';
  context.strokeStyle = '#000';
  context.lineWidth = Math.max(0.25, annotation.width * scale + 2);

  for (const path of paths) {
    drawInkCanvasPath(
      context,
      path,
      viewport,
      annotation.kind === 'freehandHighlight' && annotation.filled === true,
      annotation.width * scale + 2
    );
  }

  context.globalCompositeOperation = previousComposite;
  context.globalAlpha = 1;
}

function prepareInkCanvasContext({
  canvas,
  clear,
  displaySize,
  viewport
}: {
  canvas: HTMLCanvasElement | null;
  clear: boolean;
  displaySize: PageDisplaySize;
  viewport: PageViewport;
}) {
  return prepareInkCanvasContextState({
    canvas,
    clear,
    displaySize,
    viewport
  })?.context ?? null;
}

function prepareInkCanvasContextState({
  canvas,
  clear,
  displaySize,
  viewport
}: {
  canvas: HTMLCanvasElement | null;
  clear: boolean;
  displaySize: PageDisplaySize;
  viewport: PageViewport;
}) {
  if (!canvas) {
    return null;
  }

  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const pixelRatio = inkCanvasPixelRatio(displaySize);
  const pixelWidth = Math.max(1, Math.ceil(displaySize.width * pixelRatio));
  const pixelHeight = Math.max(1, Math.ceil(displaySize.height * pixelRatio));
  const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;

  if (canvas.width !== pixelWidth) {
    canvas.width = pixelWidth;
  }
  if (canvas.height !== pixelHeight) {
    canvas.height = pixelHeight;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  if (clear || resized) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  context.imageSmoothingEnabled = true;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.setTransform(
    (displaySize.width / Math.max(1, viewport.width)) * pixelRatio,
    0,
    0,
    (displaySize.height / Math.max(1, viewport.height)) * pixelRatio,
    0,
    0
  );

  return { context, resized };
}

function inkCanvasPixelRatio(displaySize: PageDisplaySize) {
  return safeCanvasPixelRatio(
    displaySize.width,
    displaySize.height,
    Math.min(window.devicePixelRatio || 1, 2)
  );
}

function drawInkAnnotationOnContext(
  context: CanvasRenderingContext2D,
  annotation: Extract<PdfAnnotation, { kind: 'draw' | 'freehandHighlight' }>,
  scale: number,
  viewport: PageViewport
) {
  context.globalAlpha = clamp(annotation.opacity, 0, 1);
  context.fillStyle = rgbToCss(annotation.color);
  context.strokeStyle = rgbToCss(annotation.color);
  context.lineWidth = Math.max(0.25, annotation.width * scale);

  for (const path of annotation.paths) {
    drawInkCanvasPath(
      context,
      path,
      viewport,
      annotation.kind === 'freehandHighlight' && annotation.filled === true,
      annotation.width * scale
    );
  }
}

function drawInkCanvasPath(
  context: CanvasRenderingContext2D,
  path: PdfPoint[],
  viewport: PageViewport,
  filled: boolean,
  width: number
) {
  const commands = inkPathCommands(path);
  if (commands.length === 0) {
    return;
  }

  if (commands.length === 1) {
    const [x, y] = viewport.convertToViewportPoint(
      commands[0].point.x,
      commands[0].point.y
    );
    context.beginPath();
    context.arc(x, y, Math.max(0.25, width / 2), 0, Math.PI * 2);
    context.fill();
    return;
  }

  context.beginPath();
  for (const command of commands) {
    const [x, y] = viewport.convertToViewportPoint(
      command.point.x,
      command.point.y
    );
    if (command.type === 'move') {
      context.moveTo(x, y);
      continue;
    }

    if (command.type === 'line') {
      context.lineTo(x, y);
      continue;
    }

    const [control1X, control1Y] = viewport.convertToViewportPoint(
      command.control1.x,
      command.control1.y
    );
    const [control2X, control2Y] = viewport.convertToViewportPoint(
      command.control2.x,
      command.control2.y
    );
    context.bezierCurveTo(control1X, control1Y, control2X, control2Y, x, y);
  }

  if (filled) {
    context.closePath();
    context.fill();
  } else {
    context.stroke();
  }
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
  const buttonSize = 30;
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

function resizeFreeTextWidth(
  annotation: Extract<PdfAnnotation, { kind: 'freeText' }>,
  point: PdfPoint,
  handle: 'left' | 'right'
) {
  const left = Math.min(annotation.rect.x1, annotation.rect.x2);
  const right = Math.max(annotation.rect.x1, annotation.rect.x2);
  const top = Math.max(annotation.rect.y1, annotation.rect.y2);
  const bottom = Math.min(annotation.rect.y1, annotation.rect.y2);

  if (handle === 'left') {
    const nextLeft = clamp(
      point.x,
      right - FREE_TEXT_MAX_WIDTH,
      right - FREE_TEXT_MIN_WIDTH
    );
    return {
      ...annotation,
      layoutWidth: right - nextLeft,
      rect: {
        x1: nextLeft,
        y1: bottom,
        x2: right,
        y2: top
      }
    };
  }

  const nextRight = clamp(
    point.x,
    left + FREE_TEXT_MIN_WIDTH,
    left + FREE_TEXT_MAX_WIDTH
  );
  return {
    ...annotation,
    layoutWidth: nextRight - left,
    rect: {
      x1: left,
      y1: bottom,
      x2: nextRight,
      y2: top
    }
  };
}

function resizeImageStampRect(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>,
  point: PdfPoint,
  handle: ImageStampResizeHandle['handle'],
  scale: number
) {
  const rect = annotation.rect;
  const aspectRatio = imageStampAspectRatio(annotation);
  const minSize = Math.max(4, 12 / scale);
  const anchors = {
    'top-left': { x: rect.x2, y: rect.y1 },
    'top-right': { x: rect.x1, y: rect.y1 },
    'bottom-left': { x: rect.x2, y: rect.y2 },
    'bottom-right': { x: rect.x1, y: rect.y2 }
  };
  const anchor = anchors[handle];
  const requestedWidth = Math.max(minSize, Math.abs(point.x - anchor.x));
  const requestedHeight = Math.max(minSize, Math.abs(point.y - anchor.y));
  const width = Math.max(requestedWidth, requestedHeight * aspectRatio);
  const height = width / aspectRatio;
  const right = handle.endsWith('right');
  const top = handle.startsWith('top');
  const x1 = right ? anchor.x : anchor.x - width;
  const x2 = right ? anchor.x + width : anchor.x;
  const y1 = top ? anchor.y : anchor.y - height;
  const y2 = top ? anchor.y + height : anchor.y;

  return {
    ...annotation,
    rect: normalizedRect({ x1, x2, y1, y2 })
  };
}

function resizeImageStampToWidth(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>,
  width: number
) {
  const rect = annotation.rect;
  const nextWidth = Math.max(1, width);
  const height = nextWidth / imageStampAspectRatio(annotation);
  return {
    ...annotation,
    rect: {
      ...rect,
      x2: rect.x1 + nextWidth,
      y1: rect.y2 - height
    }
  };
}

function resizeImageStampToHeight(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>,
  height: number
) {
  const rect = annotation.rect;
  const nextHeight = Math.max(1, height);
  const width = nextHeight * imageStampAspectRatio(annotation);
  return {
    ...annotation,
    rect: {
      ...rect,
      x2: rect.x1 + width,
      y1: rect.y2 - nextHeight
    }
  };
}

function imageStampAspectRatio(
  annotation: Extract<PdfAnnotation, { kind: 'imageStamp' }>
) {
  return Math.max(0.01, annotation.widthPx / Math.max(1, annotation.heightPx));
}

function normalizedRect(rect: PdfRect): PdfRect {
  return {
    x1: Math.min(rect.x1, rect.x2),
    y1: Math.min(rect.y1, rect.y2),
    x2: Math.max(rect.x1, rect.x2),
    y2: Math.max(rect.y1, rect.y2)
  };
}

function oppositeHighlightHandleAnchor(
  annotation: Extract<PdfAnnotation, { kind: 'textHighlight' }>,
  handle: 'start' | 'end',
  textRects: TextLayerRect[]
) {
  const coveredTextRects = textRects.filter((textRect) =>
    annotation.rects.some((highlightRect) =>
      textRectOverlapsHighlight(textRect.rect, highlightRect)
    )
  );
  const firstCoveredIndex = coveredTextRects[0]?.index;
  const lastCoveredIndex = coveredTextRects.at(-1)?.index;

  if (
    typeof firstCoveredIndex !== 'number' ||
    typeof lastCoveredIndex !== 'number'
  ) {
    return null;
  }

  return handle === 'start' ? lastCoveredIndex : firstCoveredIndex;
}

function moveTextHighlightHandle(
  annotation: Extract<PdfAnnotation, { kind: 'textHighlight' }>,
  handle: 'start' | 'end',
  point: PdfPoint,
  textRects: TextLayerRect[],
  anchorIndex: number | null
) {
  if (textRects.length > 0 && anchorIndex !== null) {
    const targetIndex = nearestTextRectIndex(textRects, point);
    const startIndex =
      handle === 'start'
        ? Math.min(targetIndex, anchorIndex)
        : Math.min(anchorIndex, targetIndex);
    const endIndex =
      handle === 'start'
        ? Math.max(targetIndex, anchorIndex)
        : Math.max(anchorIndex, targetIndex);
    const nextTextRects = textRects.filter(
      (textRect) => textRect.index >= startIndex && textRect.index <= endIndex
    );
    const nextRects = textLayerSegmentsToHighlightRects(nextTextRects);

    if (nextRects.length > 0) {
      return {
        ...annotation,
        rects: nextRects,
        quadPoints: nextRects.map(rectToQuadPoints),
        contents: joinTextLayerSegments(nextTextRects)
      };
    }
  }

  const rects = annotation.rects.map((rect) => ({ ...rect }));
  const targetIndex = nearestRectIndex(rects, point);

  if (handle === 'start') {
    const nextRects = rects.slice(targetIndex);
    const first = nextRects[0];
    if (first) {
      first.x1 = clamp(point.x, Math.min(first.x1, first.x2), first.x2 - 1);
    }
    return {
      ...annotation,
      rects: nextRects,
      quadPoints: nextRects.map(rectToQuadPoints)
    };
  } else {
    const nextRects = rects.slice(0, targetIndex + 1);
    const last = nextRects.at(-1);
    if (last) {
      last.x2 = clamp(point.x, last.x1 + 1, Math.max(last.x1, last.x2));
    }
    return {
      ...annotation,
      rects: nextRects,
      quadPoints: nextRects.map(rectToQuadPoints)
    };
  }
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
  _annotationIndex: number
) {
  if (
    annotation.annotationType === AnnotationType.LINK ||
    annotation.annotationType === AnnotationType.POPUP ||
    annotation.annotationType === AnnotationType.WIDGET ||
    isReadOnlyTextMarkupAnnotation(annotation)
  ) {
    return false;
  }

  return !isEditableExistingAnnotation(annotation);
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

function keepOnlyChangedPixelsInAnnotationRects(
  appearance: ImageData,
  base: ImageData,
  existingAnnotations: ExistingPdfAnnotation[],
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
    if (!shouldRenderExistingAnnotationInAppearanceOverlay(annotation, 0)) {
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
  viewport: PageViewport,
  scaleX: number,
  scaleY: number
) {
  const padding = 8;
  existingAnnotations.forEach((annotation) => {
    if (
      !isEditableExistingAnnotation(annotation) &&
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

const PDF_UNITS_PER_INCH = 72;
const MILLIMETRES_PER_INCH = 25.4;
const INK_CAPTURE_SPACING_MM = 0.05;
const INK_POINT_SPACING_MM = 0.15;
const INK_SIMPLIFICATION_TOLERANCE_MM = 0.05;
const INK_DOT_MAX_LENGTH_MM = 0.35;
const FREEHAND_HIGHLIGHT_MIN_LENGTH_MM = 1;
const TYPE_ERASER_MIN_DISTANCE_PX = 5;

function appendDraftInkPoints(
  path: PdfPoint[],
  points: PdfPoint[],
  viewport: PageViewport
) {
  const minDistance = inkCaptureSpacing(viewport);
  for (const point of points) {
    appendMutableInkPoint(path, point, minDistance);
  }
  return path;
}

function appendMutableInkPoint(
  path: PdfPoint[],
  point: PdfPoint,
  minDistance: number
) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return;
  }

  const previous = path[path.length - 1];
  if (
    previous &&
    Math.hypot(point.x - previous.x, point.y - previous.y) < minDistance
  ) {
    return;
  }

  path.push(point);
}

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

function normalizeDraftInkPath(path: PdfPoint[], viewport: PageViewport) {
  const resampled = resampleInkPath(path, inkPointSpacing(viewport));
  return simplifyInkPath(resampled, inkSimplificationTolerance(viewport));
}

function inkCaptureSpacing(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_CAPTURE_SPACING_MM, viewport);
}

function inkPointSpacing(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_POINT_SPACING_MM, viewport);
}

function inkSimplificationTolerance(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_SIMPLIFICATION_TOLERANCE_MM, viewport);
}

function inkDotMaxLength(viewport: PageViewport) {
  return millimetresToPdfUnits(INK_DOT_MAX_LENGTH_MM, viewport);
}

function freehandHighlightMinLength(viewport: PageViewport) {
  return millimetresToPdfUnits(FREEHAND_HIGHLIGHT_MIN_LENGTH_MM, viewport);
}

function typeEraserMinLength(viewport: PageViewport) {
  const start = viewportPointToPdfPoint(0, 0, viewport);
  const end = viewportPointToPdfPoint(TYPE_ERASER_MIN_DISTANCE_PX, 0, viewport);
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function millimetresToPdfUnits(millimetres: number, viewport: PageViewport) {
  const userUnit =
    Number.isFinite(viewport.userUnit) && viewport.userUnit > 0
      ? viewport.userUnit
      : 1;
  return (millimetres * PDF_UNITS_PER_INCH) / MILLIMETRES_PER_INCH / userUnit;
}

function pdfUnitsToMillimetres(pdfUnits: number, viewport: PageViewport) {
  const userUnit =
    Number.isFinite(viewport.userUnit) && viewport.userUnit > 0
      ? viewport.userUnit
      : 1;
  return (pdfUnits * MILLIMETRES_PER_INCH * userUnit) / PDF_UNITS_PER_INCH;
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

function annotationMatchesEraserScope(
  annotation: PdfAnnotation,
  scope: EraserScope
) {
  if (scope === 'all') {
    return true;
  }

  if (scope === 'draw') {
    return annotation.kind === 'draw';
  }

  return (
    annotation.kind === 'textHighlight' ||
    annotation.kind === 'freehandHighlight'
  );
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
