import { Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  appendInkPoint,
  boundsForRects,
  dotPath,
  isLassoSelectableAnnotation,
  moveAnnotation,
  nearestRectIndex,
  pathHitTest,
  pathLength,
  rectToQuadPoints,
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
import { FREE_TEXT_LINE_HEIGHT } from './freeTextLayout';

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
  pointerId: number;
};

type PdfPageViewProps = {
  page: PDFPageProxy;
  pageIndex: number;
  pageCount: number;
  renderPriority: PageRenderPriority;
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
  onFocusAnnotationConsumed: (annotationId: string) => void;
  onEnsureAnnotationsVisible: () => void;
  onExternalLinkRequest: (url: string) => void;
  onNavigateDestination: (destination: string | unknown[]) => void;
  onNavigatePage: (pageIndex: number) => void;
  onPageReady?: (pageIndex: number) => void;
  onSelectAnnotations: (annotationIds: string[]) => void;
  onToolChange: (tool: Tool) => void;
  onUpdateAnnotation: (
    annotationId: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options?: { recordUndo?: boolean }
  ) => void;
};

export function PdfPageView({
  page,
  pageIndex,
  pageCount,
  renderPriority,
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
  onFocusAnnotationConsumed,
  onEnsureAnnotationsVisible,
  onExternalLinkRequest,
  onNavigateDestination,
  onNavigatePage,
  onPageReady,
  onSelectAnnotations,
  onToolChange,
  onUpdateAnnotation
}: PdfPageViewProps) {
  const baseLayerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const appearanceLayerRef = useRef<HTMLCanvasElement>(null);
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
  const [draftPath, setDraftPath] = useState<PdfPoint[] | null>(null);
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
  const [dragHandle, setDragHandle] = useState<{
    anchorIndex: number | null;
    annotationId: string;
    handle: 'start' | 'end';
    pointerId: number;
  } | null>(null);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [eraserPath, setEraserPath] = useState<PdfPoint[] | null>(null);
  const [lassoPath, setLassoPath] = useState<PdfPoint[] | null>(null);
  const [highlightContextMenu, setHighlightContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const navigateDestinationRef = useRef(onNavigateDestination);
  const externalLinkRequestRef = useRef(onExternalLinkRequest);
  const navigatePageRef = useRef(onNavigatePage);
  navigateDestinationRef.current = onNavigateDestination;
  externalLinkRequestRef.current = onExternalLinkRequest;
  navigatePageRef.current = onNavigatePage;
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const renderKey = `${page.pageNumber}:${scale}`;
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
  const selectedPageAnnotations = useMemo(
    () => {
      const selectedIds = new Set(selectedAnnotationIds);
      return annotations.filter((annotation) => selectedIds.has(annotation.id));
    },
    [annotations, selectedAnnotationIds]
  );
  const overlayCapturesPointer =
    tool === 'draw' ||
    tool === 'freehandHighlight' ||
    tool === 'freeText' ||
    tool === 'stickyNote' ||
    tool === 'eraser' ||
    tool === 'lasso';
  const shouldMountInteractionOverlay = showAnnotations || overlayCapturesPointer;
  const showSynchronizedAnnotations = showAnnotations && baseLayerReady;
  const pageStyle = {
    width: viewport.width,
    height: viewport.height,
    '--pdf-page-width': String(viewport.width / scale),
    '--pdf-page-height': String(viewport.height / scale),
    '--scale-factor': String(scale),
    '--user-unit': String(viewport.userUnit),
    '--total-scale-factor': String(scale * viewport.userUnit),
    '--scale-round-x': '1px',
    '--scale-round-y': '1px'
  } as React.CSSProperties;

  useEffect(() => {
    if (baseLayerReady) {
      onPageReady?.(pageIndex);
    }
  }, [baseLayerReady, onPageReady, pageIndex]);

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
      const cachedRenderMode = cachedPageBaseRenderMode(page);

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
          if (!hasPageContent) {
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
            hasPageContent ? AnnotationMode.ENABLE : AnnotationMode.DISABLE,
            (renderTask) => {
              fallbackRenderTask = renderTask;
            }
          );
          if (!hasPageContent) {
            cachePageBaseRenderMode(page, 'normal');
          }
        } else {
          const eventBus = new EventBus();
          eventBus.on('pagerendered', revealCanvasIfReady, { once: true });
          pageView = new PdfJsPageView({
            annotationMode: AnnotationMode.DISABLE,
            container,
            defaultViewport: page.getViewport({ scale }),
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

      clearCanvas(overlayCanvas);
      if (
        !showAnnotations ||
        !baseLayerReady ||
        !baseCanvas ||
        !existingAnnotations.some((annotation, index) =>
          shouldRenderExistingAnnotationInAppearanceOverlay(
            annotation,
            index
          )
        )
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

      overlayCanvas.width = width;
      overlayCanvas.height = height;
      overlayCanvas.style.width = `${viewport.width}px`;
      overlayCanvas.style.height = `${viewport.height}px`;

      const scaleX = width / Math.max(1, viewport.width);
      const scaleY = height / Math.max(1, viewport.height);
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      const renderTask = page.render({
        annotationMode: AnnotationMode.ENABLE,
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
      keepOnlyChangedPixels(appearancePixels, basePixels);
      context.putImageData(appearancePixels, 0, 0);
      clearEditableExistingAnnotationRects(
        context,
        existingAnnotations,
        viewport,
        scaleX,
        scaleY
      );
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

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    onActivate(pageIndex);

    const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
    if ((tool === 'draw' || tool === 'highlight') && isRightButton) {
      setHighlightContextMenu(null);
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      eraserScopeRef.current = tool === 'draw' ? 'draw' : 'highlight';
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      setEraserPath([point]);
      eraseAtPoint(point);
      return;
    }

    const isPrimaryButton = event.button === 0;
    if (isPrimaryButton && isAnnotationCreationTool(tool)) {
      onEnsureAnnotationsVisible();
    }

    if (
      isPrimaryButton &&
      event.target === event.currentTarget &&
      (selectedPageAnnotations.length > 0 || highlightContextMenu)
    ) {
      onSelectAnnotations([]);
      setHighlightContextMenu(null);
      dismissedSelectionPointerIdRef.current = event.pointerId;
      event.preventDefault();
      return;
    }

    setHighlightContextMenu(null);

    if (tool === 'select') {
      if (event.target === event.currentTarget) {
        onSelectAnnotations([]);
      }
      return;
    }

    if (tool === 'eraser') {
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      eraserScopeRef.current = 'all';
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      setEraserPath([point]);
      eraseAtPoint(point);
      return;
    }

    if (tool === 'lasso') {
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      setLassoPath([point]);
      return;
    }

    if (tool !== 'draw' && tool !== 'freehandHighlight') {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftPath([eventToPdfPoint(event, viewport)]);
  }

  function handlePagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (isPdfLinkTarget(event.target)) {
      return;
    }

    const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
    if (tool === 'highlight' && isRightButton) {
      setHighlightContextMenu(null);
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      eraserScopeRef.current = 'highlight';
      const point = eventToPdfPointFromElement(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      setEraserPath([point]);
      eraseAtPoint(point);
      return;
    }

    const isPrimaryButton = event.button === 0;
    if (
      isPrimaryButton &&
      (selectedPageAnnotations.length > 0 || highlightContextMenu)
    ) {
      onSelectAnnotations([]);
      setHighlightContextMenu(null);
      dismissedSelectionPointerIdRef.current = event.pointerId;
      event.preventDefault();
      return;
    }

    setHighlightContextMenu(null);

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
      setDraftPath([point]);
    }
  }

  function handlePagePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (eraserPath) {
      const point = eventToPdfPointFromElement(event, viewport);
      setEraserPath((current) => (current ? [...current, point] : current));
      eraseAtPoint(point);
      return;
    }

    if (tool === 'highlight' && draftTextHighlight) {
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

    if (tool !== 'highlight' || !draftPath) {
      return;
    }

    const point = eventToPdfPointFromElement(event, viewport);
    setDraftPath((current) =>
      current ? appendDraftInkPoint(current, point, viewport) : current
    );
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

  function nearestTextSegmentFromPointerEventWithGeometry(
    event: React.PointerEvent<Element>,
    geometry: ActiveTextGeometry,
    tolerance = { x: 36, y: 16 }
  ) {
    const pageElement = pageRef.current;
    if (!pageElement || geometry.hitRects.length === 0) {
      return null;
    }

    const bounds = pageElement.getBoundingClientRect();
    return nearestTextHitRect(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      geometry.hitRects,
      tolerance
    );
  }

  function handlePagePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dismissedSelectionPointerIdRef.current === event.pointerId) {
      dismissedSelectionPointerIdRef.current = null;
      return;
    }

    if (eraserPath) {
      releasePointer(event, event.pointerId);
      setEraserPath(null);
      eraserScopeRef.current = 'all';
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

    if (tool !== 'highlight' || !draftPath) {
      return;
    }

    releasePointer(event, event.pointerId);
    const path = appendDraftInkPoint(
      draftPath,
      eventToPdfPointFromElement(event, viewport),
      viewport
    );
    const normalizedPath = normalizeDraftInkPath(path, viewport);
    setDraftPath(null);

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
    const activeDragSelection = dragSelectionRef.current;
    if (activeDragSelection) {
      const point = eventToPdfPoint(event, viewport);
      const delta = {
        x: point.x - activeDragSelection.lastPoint.x,
        y: point.y - activeDragSelection.lastPoint.y
      };

      for (const annotationId of activeDragSelection.annotationIds) {
        onUpdateAnnotation(
          annotationId,
          (annotation) => moveAnnotation(annotation, delta),
          { recordUndo: false }
        );
      }

      dragSelectionRef.current = {
        ...activeDragSelection,
        lastPoint: point
      };
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

    if (eraserPath) {
      const point = eventToPdfPoint(event, viewport);
      setEraserPath((current) => (current ? [...current, point] : current));
      eraseAtPoint(point);
      return;
    }

    if (lassoPath) {
      const point = eventToPdfPoint(event, viewport);
      setLassoPath((current) => (current ? [...current, point] : current));
      return;
    }

    if (!draftPath || (tool !== 'draw' && tool !== 'freehandHighlight')) {
      return;
    }

    const point = eventToPdfPoint(event, viewport);
    setDraftPath((current) =>
      current ? appendDraftInkPoint(current, point, viewport) : current
    );
  }

  function handlePointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (dismissedSelectionPointerIdRef.current === event.pointerId) {
      dismissedSelectionPointerIdRef.current = null;
      return;
    }

    if (dragSelection) {
      releasePointer(event, dragSelection.pointerId);
      dragSelectionRef.current = null;
      setDragSelection(null);
      return;
    }

    if (dragHandle) {
      releasePointer(event, dragHandle.pointerId);
      setDragHandle(null);
      activeTextGeometryRef.current = null;
      return;
    }

    if (eraserPath) {
      releasePointer(event, event.pointerId);
      setEraserPath(null);
      eraserScopeRef.current = 'all';
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

    if (draftPath && (tool === 'draw' || tool === 'freehandHighlight')) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      const path = appendDraftInkPoint(
        draftPath,
        eventToPdfPoint(event, viewport),
        viewport
      );
      const normalizedPath =
        tool === 'draw' && pathLength(path) <= inkDotMaxLength(viewport)
          ? dotPath(path[0], toolSettings.drawWidth)
          : normalizeDraftInkPath(path, viewport);
      setDraftPath(null);

      if (
        (tool === 'draw'
          ? normalizedPath.length > 0
          : path.length > 2) &&
        (tool !== 'freehandHighlight' ||
          pathLength(path) > freehandHighlightMinLength(viewport))
      ) {
        onAddAnnotation({
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
        });
      }

      return;
    }

    if (event.target !== event.currentTarget) {
      return;
    }

    if (tool === 'freeText' || tool === 'stickyNote') {
      const origin = eventToViewportPoint(event);
      const rect =
        tool === 'freeText'
          ? viewportRectToPdfRect(
              origin.x,
              origin.y,
              260,
              Math.max(84, toolSettings.textFontSize * scale * 4),
              viewport
            )
          : viewportRectToPdfRect(origin.x, origin.y, 28, 28, viewport);

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
  }

  function beginMoveAnnotation(
    event: React.PointerEvent<SVGGElement>,
    annotationId: string
  ) {
    if (tool !== 'select') {
      return;
    }

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
    event.currentTarget.setPointerCapture(event.pointerId);
    const nextDragSelection = {
      annotationIds,
      lastPoint: eventToPdfPointFromElement(event, viewport),
      pointerId: event.pointerId
    };
    dragSelectionRef.current = nextDragSelection;
    setDragSelection(nextDragSelection);
  }

  function eraseAtPoint(point: PdfPoint) {
    const scope = eraserScopeRef.current;
    const deleteIds: string[] = [];

    for (const annotation of annotations) {
      if (!annotationMatchesEraserScope(annotation, scope)) {
        continue;
      }

      if (annotation.kind === 'draw' || annotation.kind === 'freehandHighlight') {
        const eraserRadius = Math.max(toolSettings.eraserWidth / 2 / scale, 1 / scale);
        const threshold = Math.max(annotation.width * 1.4, eraserRadius);
        const remainingPaths = annotation.paths.filter(
          (path) => !pathHitTest(path, point, threshold)
        );

        if (remainingPaths.length === 0 && annotation.paths.length > 0) {
          deleteIds.push(annotation.id);
        } else if (remainingPaths.length !== annotation.paths.length) {
          onUpdateAnnotation(
            annotation.id,
            (current) =>
              current.kind === 'draw' || current.kind === 'freehandHighlight'
                ? { ...current, paths: remainingPaths }
                : current,
            { recordUndo: false }
          );
        }

        continue;
      }

      if (annotationHitTest(annotation, point, scale)) {
        deleteIds.push(annotation.id);
      }
    }

    onDeleteAnnotations(deleteIds);
  }

  function handleMouseUp() {
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
  const previewDraftPath = useMemo(
    () => (draftPath ? normalizeDraftInkPath(draftPath, viewport) : null),
    [draftPath, viewport]
  );
  return (
    <article
      aria-current={active ? 'page' : undefined}
      className="pdf-page-frame"
      data-page-ready={baseLayerReady ? 'true' : 'false'}
      onClick={() => onActivate(pageIndex)}
    >
      <div
        className="pdf-page"
        ref={pageRef}
        style={pageStyle}
        onPointerDown={handlePagePointerDown}
        onPointerMove={handlePagePointerMove}
        onPointerUp={handlePagePointerUp}
        onMouseUp={handleMouseUp}
        onContextMenu={(event) => {
          if (tool === 'draw' || tool === 'highlight' || tool === 'eraser') {
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
          {shouldMountInteractionOverlay ? (
            <svg
              className="pdfa-fill"
              height={viewport.height}
              style={{
                pointerEvents:
                  overlayCapturesPointer ||
                  (selectedPageAnnotations.length > 0 && tool !== 'highlight')
                    ? 'auto'
                    : 'none'
              }}
              viewBox={`0 0 ${viewport.width} ${viewport.height}`}
              width={viewport.width}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            >
            {showSynchronizedAnnotations ? annotations.map((annotation) => (
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
                onBeginMoveDrag={beginMoveAnnotation}
                onHoverChange={(hovered) =>
                  setHoveredAnnotationId(hovered ? annotation.id : null)
                }
                onContextMenu={(event) => {
                  if (annotation.kind !== 'textHighlight') {
                    return;
                  }

                  event.preventDefault();
                  event.stopPropagation();
                  onActivate(pageIndex);
                  onSelectAnnotations([annotation.id]);
                  const pageBounds = pageRef.current?.getBoundingClientRect();
                  const text = getTextForHighlights(
                    [annotation],
                    textLayerRef.current,
                    pageRef.current,
                    viewport
                  );
                  setHighlightContextMenu({
                    x: pageBounds ? event.clientX - pageBounds.left : 0,
                    y: pageBounds ? event.clientY - pageBounds.top : 0,
                    text
                  });
                }}
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
            {showSynchronizedAnnotations && selectedPageAnnotations.length > 0 ? (
              <SelectionToolbar
                annotations={selectedPageAnnotations}
                onBeginEdit={onBeginAnnotationEdit}
                onDelete={() =>
                  onDeleteAnnotations(
                    selectedPageAnnotations.map((annotation) => annotation.id)
                  )
                }
                onClose={() => onSelectAnnotations([])}
                onUpdate={(updater) => {
                  for (const annotation of selectedPageAnnotations) {
                    onUpdateAnnotation(annotation.id, updater, {
                      recordUndo: false
                    });
                  }
                }}
                viewport={viewport}
              />
            ) : null}
            {previewDraftPath ? (
              <PathShape
                color={
                  tool === 'draw'
                    ? rgbToCss(toolSettings.drawColor)
                    : rgbToCss(toolSettings.highlightColor)
                }
                opacity={
                  tool === 'draw'
                    ? toolSettings.drawOpacity
                    : toolSettings.highlightOpacity
                }
                points={previewDraftPath}
                viewport={viewport}
                width={
                  (tool === 'draw'
                    ? toolSettings.drawWidth
                    : toolSettings.highlightWidth) * scale
                }
              />
            ) : null}
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
            {eraserPath ? (
              <PathShape
                color={SELECTION_ACCENT}
                opacity={0.35}
                points={eraserPath}
                viewport={viewport}
                width={toolSettings.eraserWidth}
              />
            ) : null}
            {lassoPath ? (
              <LassoShape points={lassoPath} viewport={viewport} />
            ) : null}
            </svg>
          ) : null}
        </div>
        {highlightContextMenu ? (
          <div
            className="highlight-context-menu"
            style={{
              left: highlightContextMenu.x,
              top: highlightContextMenu.y
            }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              className="highlight-context-menu-button"
              onClick={() => {
                if (highlightContextMenu.text && navigator.clipboard) {
                  void navigator.clipboard
                    .writeText(highlightContextMenu.text)
                    .catch(console.error);
                }
                setHighlightContextMenu(null);
              }}
              type="button"
            >
              Copy
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AnnotationShape({
  annotation,
  focused,
  onBeginEdit,
  onBeginHighlightHandleDrag,
  onBeginMoveDrag,
  onContextMenu,
  onFocusEnd,
  onHoverChange,
  onSelect,
  onUpdate,
  scale,
  selected,
  showPopover,
  tool,
  viewport
}: {
  annotation: PdfAnnotation;
  focused: boolean;
  onBeginEdit: () => void;
  onBeginHighlightHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: 'start' | 'end'
  ) => void;
  onBeginMoveDrag: (
    event: React.PointerEvent<SVGGElement>,
    annotationId: string
  ) => void;
  onContextMenu: (event: React.MouseEvent<SVGGElement>) => void;
  onFocusEnd: (annotationId: string) => void;
  onHoverChange: (hovered: boolean) => void;
  onSelect: () => void;
  onUpdate: (updater: (annotation: PdfAnnotation) => PdfAnnotation) => void;
  scale: number;
  selected: boolean;
  showPopover: boolean;
  tool: Tool;
  viewport: PageViewport;
}) {
  const commonProps = {
    onPointerDown: (event: React.PointerEvent<SVGGElement>) => {
      if (tool === 'eraser') {
        return;
      }

      if (
        (tool === 'draw' || tool === 'highlight') &&
        (event.button === 2 || (event.buttons & 2) === 2)
      ) {
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

      if (!selected) {
        onSelect();
      }
      onBeginMoveDrag(event, annotation.id);
    },
    onPointerUp: (event: React.PointerEvent<SVGGElement>) => {
      if (tool === 'freeText' || tool === 'stickyNote') {
        event.stopPropagation();
      }
    },
    onPointerEnter: () => onHoverChange(true),
    onPointerLeave: () => onHoverChange(false),
    onContextMenu,
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
                    stroke="#047857"
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
                    color="#047857"
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
                onChange={(event) =>
                  onUpdate((current) =>
                    current.kind === 'freeText'
                      ? { ...current, text: event.target.value }
                      : current
                  )
                }
                onBlur={focused ? () => onFocusEnd(annotation.id) : undefined}
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
        </g>
      );
    }

    case 'stickyNote': {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      return (
        <g {...commonProps} transform={`translate(${rect.x} ${rect.y})`}>
          <rect
            fill={rgbToCss(annotation.color)}
            height={Math.max(rect.height, 22)}
            rx="3"
            stroke={selected ? '#047857' : '#ca8a04'}
            strokeWidth={selected ? 2 : 1}
            width={Math.max(rect.width, 22)}
          />
          <path
            d="M6 7h12M6 12h10M6 17h8"
            fill="none"
            stroke="#854d0e"
            strokeLinecap="round"
            strokeWidth="1.5"
          />
          {showPopover ? (
            <NotePopover
              autoFocus={focused}
              color={annotation.color}
              editable={selected || focused}
              onBlur={focused ? () => onFocusEnd(annotation.id) : undefined}
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
        fill="#047857"
        onPointerDown={(event) => onBeginDrag(event, 'start')}
        r="6"
        stroke="white"
        strokeWidth="2"
      />
      <circle
        className="highlight-handle"
        cx={end[0]}
        cy={end[1]}
        fill="#047857"
        onPointerDown={(event) => onBeginDrag(event, 'end')}
        r="6"
        stroke="white"
        strokeWidth="2"
      />
    </g>
  );
}

function SelectionToolbar({
  annotations,
  onClose,
  onBeginEdit,
  onDelete,
  onUpdate,
  viewport
}: {
  annotations: PdfAnnotation[];
  onClose: () => void;
  onBeginEdit: () => void;
  onDelete: () => void;
  onUpdate: (updater: (annotation: PdfAnnotation) => PdfAnnotation) => void;
  viewport: PageViewport;
}) {
  const bounds = pdfRectToViewportRect(
    boundsForRects(annotations.map(annotationBounds)),
    viewport
  );
  const first = annotations[0];
  const showsFontSize = annotations.length === 1 && first?.kind === 'freeText';
  const showsStroke = annotations.some(hasStroke);
  const showsOpacity = annotations.some(hasOpacity);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const rowHeights = [
    first ? 22 : 0,
    showsOpacity ? 30 : 0,
    showsStroke ? 30 : 0,
    showsFontSize ? 30 : 0,
    30
  ].filter((height) => height > 0);
  const toolbarHeight =
    22 +
    rowHeights.reduce((total, height) => total + height, 0) +
    Math.max(0, rowHeights.length - 1) * 8;
  const [measuredToolbarHeight, setMeasuredToolbarHeight] =
    useState(toolbarHeight);
  const activeToolbarHeight = measuredToolbarHeight || toolbarHeight;
  const toolbarWidth = 216;
  const toolbarX = clamp(
    bounds.x + bounds.width / 2 - toolbarWidth / 2,
    0,
    Math.max(0, viewport.width - toolbarWidth)
  );
  const aboveY = bounds.y - activeToolbarHeight - 4;
  const belowY = bounds.y + bounds.height + 4;
  const toolbarY =
    aboveY >= 0
      ? aboveY
      : clamp(belowY, 0, Math.max(0, viewport.height - activeToolbarHeight));

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return;
    }

    const updateHeight = () => {
      setMeasuredToolbarHeight(
        Math.ceil(toolbar.getBoundingClientRect().height)
      );
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  return (
    <foreignObject
      height={activeToolbarHeight}
      style={{ pointerEvents: 'auto' }}
      width={toolbarWidth}
      x={toolbarX}
      y={toolbarY}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div
        className="selection-toolbar"
        ref={toolbarRef}
        style={{ width: toolbarWidth }}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <SettingsPanelShell>
          {first ? (
            <div onPointerDownCapture={onBeginEdit}>
              <ColorPalette
                color={first.color}
                label={null}
                onChange={(color) =>
                  onUpdate((current) => ({ ...current, color }))
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
          <button
            className="selection-delete-button"
            onClick={onDelete}
            title="Delete"
            type="button"
          >
            <Trash2 size={15} />
          </button>
        </SettingsPanelShell>
      </div>
    </foreignObject>
  );
}

function eventToPdfPoint(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: PageViewport
) {
  const point = eventToViewportPoint(event);
  return viewportPointToPdfPoint(point.x, point.y, viewport);
}

function eventToPdfPointFromElement(
  event: React.PointerEvent<Element>,
  viewport: PageViewport
) {
  const pageElement = (event.currentTarget as Element).closest('.pdf-page');
  const bounds = pageElement?.getBoundingClientRect();

  if (!bounds) {
    return { x: 0, y: 0 };
  }

  return viewportPointToPdfPoint(
    event.clientX - bounds.left,
    event.clientY - bounds.top,
    viewport
  );
}

function eventToViewportPoint(event: React.PointerEvent<SVGSVGElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top
  };
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
    annotation.annotationType === AnnotationType.WIDGET
  ) {
    return false;
  }

  return !isEditableExistingAnnotation(annotation);
}

function keepOnlyChangedPixels(appearance: ImageData, base: ImageData) {
  const appearanceData = appearance.data;
  const baseData = base.data;
  const threshold = 8;
  for (let index = 0; index < appearanceData.length; index += 4) {
    const difference =
      Math.abs(appearanceData[index] - baseData[index]) +
      Math.abs(appearanceData[index + 1] - baseData[index + 1]) +
      Math.abs(appearanceData[index + 2] - baseData[index + 2]) +
      Math.abs(appearanceData[index + 3] - baseData[index + 3]);

    if (difference <= threshold) {
      appearanceData[index + 3] = 0;
    } else {
      appearanceData[index + 3] = 255;
    }
  }
}

function clearEditableExistingAnnotationRects(
  context: CanvasRenderingContext2D,
  existingAnnotations: ExistingPdfAnnotation[],
  viewport: PageViewport,
  scaleX: number,
  scaleY: number
) {
  const padding = 8;
  existingAnnotations.forEach((annotation) => {
    if (!isEditableExistingAnnotation(annotation)) {
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
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
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
const INK_POINT_SPACING_MM = 0.15;
const INK_SIMPLIFICATION_TOLERANCE_MM = 0.08;
const INK_DOT_MAX_LENGTH_MM = 0.35;
const FREEHAND_HIGHLIGHT_MIN_LENGTH_MM = 1;

function appendDraftInkPoint(
  path: PdfPoint[],
  point: PdfPoint,
  viewport: PageViewport
) {
  return appendInkPoint(path, point, inkPointSpacing(viewport));
}

function normalizeDraftInkPath(path: PdfPoint[], viewport: PageViewport) {
  return simplifyInkPath(path, inkSimplificationTolerance(viewport));
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

function millimetresToPdfUnits(millimetres: number, viewport: PageViewport) {
  const userUnit =
    Number.isFinite(viewport.userUnit) && viewport.userUnit > 0
      ? viewport.userUnit
      : 1;
  return (millimetres * PDF_UNITS_PER_INCH) / MILLIMETRES_PER_INCH / userUnit;
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

function isEditingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'TEXTAREA' ||
      target.tagName === 'INPUT' ||
      target.isContentEditable)
  );
}
