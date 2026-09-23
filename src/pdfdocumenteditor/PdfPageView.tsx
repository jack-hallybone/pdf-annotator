import { Highlighter } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnnotationLayer,
  AnnotationMode,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";
import {
  EventBus,
  PDFPageView as PdfJsPageView,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import type {
  PdfAnnotation,
  PageDisplaySize,
  PageRenderPriority,
  PageViewport,
  PdfPoint,
  PdfRect,
  Tool,
  ToolSettings,
} from "./types";
import { foregroundOn, rgbToCss } from "./annotationColors";
import {
  isReadOnlyTextMarkupAnnotation,
  shouldRenderExistingAnnotationInAppearanceOverlay,
  shouldRenderExistingAnnotationInPdfJsLayer,
} from "./annotationDisplayPolicy";
import { getDisplayAnnotations } from "./annotationImport";
import {
  promotePendingPageTasks,
  schedulePromotableTask,
  type PendingPageTask,
} from "./pageRenderScheduling";
import type { PdfDocumentEditorNoticeOptions } from "./notices";
import type { ExistingPdfAnnotation } from "./annotationImport";
import {
  annotationHitTest,
  annotationWhollyInsidePolygon,
  dotPath,
  isLassoSelectableAnnotation,
  pathLength,
  rectToQuadPoints,
  resizeFreeTextWidth,
  resizeImageStampRect,
} from "./annotationGeometry";
import {
  appendMutableInkPoint,
  freehandHighlightMinLength,
  inkDotMaxLength,
  normalizeDraftInkPath,
} from "./inkCapture";
import {
  clearDisplayCanvas,
  drawInkCanvasAnnotation,
  inkCanvasPixelRatio,
  renderInkCanvasLayer,
  renderTextHighlightCanvas,
} from "./inkRendering";
import { pdfRectToViewportRect, viewportRectToPdfRect } from "./pdfGeometry";
import {
  clientPointToViewportPoint,
  displaySizeFromElement,
  displaySizesMatch,
  eventToPdfPoint,
  eventToPdfPointFromElement,
  eventToPdfPoints,
  eventToPdfPointsFromElement,
  eventToViewportPoint,
  nearestTextHitRect,
  releasePointer,
  viewportDisplaySize,
} from "./pagePointerGeometry";
import type { TextHitRect } from "./pagePointerGeometry";
import {
  clearCanvas,
  clearManagedAnnotationRectsFromAppearanceOverlay,
  disposeCanvases,
  drawReadOnlyTextDecorations,
  isAnnotationCreationTool,
  isRenderCancellation,
  keepOnlyChangedPixelsInAnnotationRects,
  renderRasterFallback,
  shouldUseRasterFallback,
} from "./pageCanvasPainting";
import {
  PDFJS_MAX_CANVAS_PIXELS,
  PDFJS_TEXT_LAYER_ENABLE,
  PDF_TO_CSS_UNITS,
  cachePageBaseRenderMode,
  cachedPageBaseRenderMode,
  canvasLooksEmpty,
  pageHasRenderableContent,
} from "./pdfRender";
import { createPdfLinkService, downloadManager } from "./pdfLinks";
import {
  getSelectedTextRects,
  getTextForHighlights,
  getTextLayerRects,
  joinTextLayerSegments,
  moveTextHighlightHandle,
  oppositeHighlightHandleAnchor,
  type TextLayerRect,
  textLayerSegmentsInRange,
  textLayerSegmentsToHighlightRects,
} from "./textLayerGeometry";
import {
  DOCUMENT_EDITOR_ROOT_CLASS,
  clamp,
  SELECTION_BUTTON_PAGE_PADDING,
  SELECTION_BUTTON_SIZE,
} from "./viewerConfig";
import { LassoShape } from "./components/AnnotationPrimitives";
import {
  AnnotationShape,
  ImageStampSelectionOverlay,
  SelectionToolbar,
} from "./components/PageAnnotationOverlays";
import type { ImageStampResizeHandle } from "./components/PageAnnotationOverlays";
import { FREE_TEXT_LINE_HEIGHT } from "./freeTextLayout";
import { useDraftInk } from "./useDraftInk";
import { useEraserGesture } from "./useEraserGesture";
import type { AnnotationPathUpdate } from "./useEraserGesture";
import { useRenderLatestRef } from "./useRenderLatestRef";

type PdfJsAnnotationLayerOptions = Parameters<AnnotationLayer["render"]>[0];
type PdfJsAnnotationLinkService = PdfJsAnnotationLayerOptions["linkService"];
type PdfJsAnnotationDownloadManager = NonNullable<
  PdfJsAnnotationLayerOptions["downloadManager"]
>;

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
  handle: "left" | "right";
  pointerId: number;
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
  coveredText: string;
  quadPoints: number[][];
  rects: PdfRect[];
  x: number;
  y: number;
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
  onNotice?: (
    message: string,
    options?: PdfDocumentEditorNoticeOptions,
  ) => void;
  onPageReady?: (pageIndex: number) => void;
  onPruneOffPageAnnotations: (annotationIds: string[]) => void;
  onSelectAnnotations: (annotationIds: string[]) => void;
  onToolChange: (tool: Tool) => void;
  onUpdateAnnotation: (
    annotationId: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options?: { recordUndo?: boolean },
  ) => void;
  onUpdateAnnotations: (
    annotationIds: string[],
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
    options?: { recordUndo?: boolean },
  ) => void;
};

// Stable no-op for layers that render AnnotationShape without drag support;
// module-level so it never breaks AnnotationShape's memoization.
const noopAnnotationDragHandler = () => undefined;

/*
 * No PDF bytes, annotation contents or file names are passed - the page number
 * and the thrown error are all that is logged.
 */
function logPageDisplayFailure(
  what: string,
  pageIndex: number,
  error: unknown,
) {
  console.error(`PdfPageView: ${what} failed on page ${pageIndex + 1}`, error);
}

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
  onUpdateAnnotations,
}: PdfPageViewProps) {
  const baseLayerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const appearanceLayerRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const highlightInkCanvasRef = useRef<HTMLCanvasElement>(null);
  const textHighlightCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const existingAnnotationsPageRef = useRef<PDFPageProxy | null>(null);
  // A page promoted to "visible" mid-scroll starts its queued work early
  // through these handles, rather than the priority sitting in an effect
  // dependency array.
  const pendingPageTasksRef = useRef<Set<PendingPageTask>>(new Set());
  const suppressNextTextHighlightRef = useRef(false);
  const dismissedSelectionPointerIdRef = useRef<number | null>(null);
  const suppressNextContextMenuRef = useRef(false);
  const inkCanvasRenderStateRef = useRef<InkCanvasRenderState | null>(null);
  const prepaintedInkAnnotationIdsRef = useRef<Set<string>>(new Set());
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
    null,
  );
  const [freeTextResizeHandle, setFreeTextResizeHandle] =
    useState<FreeTextResizeHandle | null>(null);
  const [imageStampResizeHandle, setImageStampResizeHandle] =
    useState<ImageStampResizeHandle | null>(null);
  const [dragHandle, setDragHandle] = useState<{
    anchorIndex: number | null;
    annotationId: string;
    handle: "start" | "end";
    pointerId: number;
  } | null>(null);
  const [lassoPath, setLassoPath] = useState<PdfPoint[] | null>(null);
  const [textSelectionHighlightAction, setTextSelectionHighlightAction] =
    useState<TextSelectionHighlightAction | null>(null);
  // Mirrors (named `<mirrored name>Ref`, written during render - see
  // useRenderLatestRef) so the stable pointer handlers and the window listeners
  // registered once read current values through .current instead of closing
  // over them.
  const onNavigateDestinationRef = useRenderLatestRef(onNavigateDestination);
  const onExternalLinkRequestRef = useRenderLatestRef(onExternalLinkRequest);
  const onNavigatePageRef = useRenderLatestRef(onNavigatePage);
  const onNoticeRef = useRenderLatestRef(onNotice);
  const annotationsRef = useRenderLatestRef(annotations);
  const selectedAnnotationIdsRef = useRenderLatestRef(selectedAnnotationIds);
  const toolRef = useRenderLatestRef(tool);
  const readOnlyRef = useRenderLatestRef(readOnly);
  const onUpdateAnnotationRef = useRenderLatestRef(onUpdateAnnotation);
  const onSelectAnnotationsRef = useRenderLatestRef(onSelectAnnotations);
  const onBeginAnnotationEditRef = useRenderLatestRef(onBeginAnnotationEdit);
  const onActivateRef = useRenderLatestRef(onActivate);
  const onFocusAnnotationConsumedRef = useRenderLatestRef(
    onFocusAnnotationConsumed,
  );
  const getActiveTextGeometryRef = useRenderLatestRef(getActiveTextGeometry);
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const viewportRef = useRenderLatestRef(viewport);
  // Escape generates no pointerup or pointercancel, so nothing in the pointer
  // gesture tracking below sees it.
  const cancelActiveGestureRef = useRenderLatestRef(cancelActiveGesture);
  const renderPriorityRef = useRenderLatestRef(renderPriority);
  const renderKey = `${page.pageNumber}:${scale}`;
  const [displaySize, setDisplaySize] = useState(() =>
    viewportDisplaySize(viewport),
  );
  const linkService = useMemo(
    () =>
      createPdfLinkService({
        onExternalLinkRequest: (url) => onExternalLinkRequestRef.current(url),
        onNavigateDestination: (destination) =>
          onNavigateDestinationRef.current(destination),
        onNavigatePage: (targetPageIndex) =>
          onNavigatePageRef.current(targetPageIndex),
        pageCount,
        pageIndex,
      }),
    [
      onExternalLinkRequestRef,
      onNavigateDestinationRef,
      onNavigatePageRef,
      pageCount,
      pageIndex,
    ],
  );
  const selectedAnnotationIdSet = useMemo(
    () => new Set(selectedAnnotationIds),
    [selectedAnnotationIds],
  );
  const selectedPageAnnotations = useMemo(() => {
    if (readOnly) {
      return [];
    }

    return annotations.filter((annotation) =>
      selectedAnnotationIdSet.has(annotation.id),
    );
  }, [annotations, readOnly, selectedAnnotationIdSet]);
  // This page's annotations, sorted into stacking order for rendering.
  const displayAnnotations = useMemo(
    () =>
      [...annotations].sort(
        (left, right) =>
          annotationRenderRank(left) - annotationRenderRank(right),
      ),
    [annotations],
  );
  const canvasInkAnnotations = useMemo(
    () =>
      displayAnnotations.filter((annotation) =>
        isCanvasBackedInkAnnotation(annotation, selectedAnnotationIdSet),
      ),
    [displayAnnotations, selectedAnnotationIdSet],
  );
  const imageDisplayAnnotations = useMemo(
    () =>
      displayAnnotations.filter(
        (annotation) => annotation.kind === "imageStamp",
      ),
    [displayAnnotations],
  );
  const vectorDisplayAnnotations = useMemo(
    () =>
      displayAnnotations.filter(
        (annotation) =>
          annotation.kind !== "imageStamp" &&
          !isCanvasBackedInkAnnotation(annotation, selectedAnnotationIdSet),
      ),
    [displayAnnotations, selectedAnnotationIdSet],
  );
  const overlayCapturesPointer =
    !readOnly &&
    (tool === "draw" ||
      tool === "freehandHighlight" ||
      tool === "freeText" ||
      tool === "stickyNote" ||
      tool === "eraser" ||
      tool === "lasso");
  const shouldMountInteractionOverlay =
    showAnnotations || overlayCapturesPointer;
  const showSynchronizedAnnotations = showAnnotations && baseLayerReady;
  const pageStyle = {
    width: displaySize.width,
    height: displaySize.height,
    "--pdf-page-width": String(viewport.width / scale),
    "--pdf-page-height": String(viewport.height / scale),
    "--scale-factor": String(scale),
    "--user-unit": String(viewport.userUnit),
    "--total-scale-factor": String(scale * viewport.userUnit),
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  } as React.CSSProperties;
  const draftInk = useDraftInk({
    displaySize,
    scale,
    toolSettings,
    viewport,
  });
  const eraser = useEraserGesture({
    annotations,
    canvasInkAnnotations,
    displaySize,
    highlightInkCanvasRef,
    inkCanvasRef,
    onEraseAnnotations,
    prepaintedInkAnnotationIdsRef,
    previewColor: () => resolvedSelectionColor(pageRef.current),
    readOnly,
    scale,
    showSynchronizedAnnotations,
    suppressNextContextMenuRef,
    toolSettings,
    viewport,
  });

  function setPageDisplaySize(nextSize: PageDisplaySize) {
    setDisplaySize((currentSize) =>
      displaySizesMatch(currentSize, nextSize) ? currentSize : nextSize,
    );
  }

  useEffect(() => {
    if (baseLayerReady) {
      onPageReady?.(pageIndex);
    }
  }, [baseLayerReady, onPageReady, pageIndex]);

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        cancelActiveGestureRef.current();
      }
    }

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [cancelActiveGestureRef]);

  useEffect(() => {
    let cancelled = false;
    let pageView: PdfJsPageView | null = null;
    let fallbackRenderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    let spinnerTimer: number | null = null;
    let canvasRevealed = false;
    let started = false;
    const pageElement = pageRef.current;
    const baseLayer = baseLayerRef.current;

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

      pageRef.current?.classList.remove("show-delayed-spinner");
      spinnerTimer = window.setTimeout(() => {
        pageRef.current?.classList.add("show-delayed-spinner");
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
            renderContainer.querySelector<HTMLDivElement>(".page"),
          ) ?? viewportDisplaySize(viewport),
        );
      }

      function revealCanvasIfReady() {
        if (cancelled || canvasRevealed) {
          return;
        }

        const canvas = renderContainer.querySelector<HTMLCanvasElement>(
          ".canvasWrapper canvas",
        );
        if (!canvas || canvasLooksEmpty(canvas)) {
          return;
        }

        canvasRevealed = true;
        if (cachedRenderMode !== "annotationAppearance") {
          cachePageBaseRenderMode(page, "normal");
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
          },
        );
        if (!cancelled && fallbackCanvas && canvasLooksEmpty(fallbackCanvas)) {
          const hasPageContent = await pageHasRenderableContent(page);
          if (hasPageContent) {
            cachePageBaseRenderMode(page, "normal");
            return;
          }

          const recoveredCanvas = await renderRasterFallback(
            page,
            viewport,
            renderContainer,
            AnnotationMode.ENABLE,
            (renderTask) => {
              fallbackRenderTask = renderTask;
            },
          );
          if (recoveredCanvas && !canvasLooksEmpty(recoveredCanvas)) {
            cachePageBaseRenderMode(page, "annotationAppearance");
          }
          return;
        }

        if (fallbackCanvas) {
          cachePageBaseRenderMode(page, "normal");
        }
      }

      try {
        if (cachedRenderMode === "annotationAppearance") {
          const hasPageContent = await pageHasRenderableContent(page);
          await renderRasterFallback(
            page,
            viewport,
            renderContainer,
            hasPageContent ? AnnotationMode.DISABLE : AnnotationMode.ENABLE,
            (renderTask) => {
              fallbackRenderTask = renderTask;
            },
          );
          if (hasPageContent) {
            cachePageBaseRenderMode(page, "normal");
          }
        } else {
          const eventBus = new EventBus();
          eventBus.on("pagerendered", revealCanvasIfReady, { once: true });
          pageView = new PdfJsPageView({
            annotationMode: AnnotationMode.DISABLE,
            container,
            defaultViewport: page.getViewport({ scale }),
            enableSelectionRendering: true,
            eventBus,
            id: pageIndex + 1,
            maxCanvasPixels: PDFJS_MAX_CANVAS_PIXELS,
            scale: scale / PDF_TO_CSS_UNITS,
            textLayerMode: PDFJS_TEXT_LAYER_ENABLE,
          });
          pageView.setPdfPage(page);

          await pageView.draw();
          if (
            !cancelled &&
            cachedRenderMode !== "normal" &&
            shouldUseRasterFallback(container)
          ) {
            await renderRasterFallbackWithRecovery();
          } else if (!cancelled) {
            cachePageBaseRenderMode(page, "normal");
          }
        }
      } catch (error) {
        if (!cancelled && !isRenderCancellation(error)) {
          try {
            await renderRasterFallbackWithRecovery();
          } catch (fallbackError) {
            if (!isRenderCancellation(fallbackError)) {
              // Both, and the primary one first: the fallback usually
              // fails for the same reason the page view did.
              logPageDisplayFailure("page render", pageIndex, error);
              logPageDisplayFailure(
                "raster fallback",
                pageIndex,
                fallbackError,
              );
              onNoticeRef.current?.(
                `Could not display page ${pageIndex + 1}.`,
                { tone: "danger" },
              );
            }
          }
        }
      } finally {
        if (spinnerTimer !== null) {
          window.clearTimeout(spinnerTimer);
          spinnerTimer = null;
        }
        pageRef.current?.classList.remove("show-delayed-spinner");
      }

      if (cancelled) {
        return;
      }

      textLayerRef.current =
        pageView?.textLayer?.div ??
        container.querySelector<HTMLDivElement>(".textLayer");
      activeTextGeometryRef.current = null;
      if (!canvasRevealed) {
        syncDisplaySizeFromRenderedPage();
        setBaseLayerReady(true);
      }
    }

    const cancelScheduledRender = schedulePromotableTask(
      pendingPageTasksRef.current,
      renderPriorityRef.current,
      renderPdfPageView,
    );

    return () => {
      cancelled = true;
      if (spinnerTimer !== null) {
        window.clearTimeout(spinnerTimer);
      }
      pageElement?.classList.remove("show-delayed-spinner");
      cancelScheduledRender();
      pageView?.destroy();
      fallbackRenderTask?.cancel();
      if (baseLayer) {
        disposeCanvases(baseLayer);
        baseLayer.replaceChildren();
      }
      textLayerRef.current = null;
      activeTextGeometryRef.current = null;
    };
  }, [
    onNoticeRef,
    page,
    pageIndex,
    renderKey,
    renderPriorityRef,
    scale,
    viewport,
  ]);

  /*
   * The only thing a priority change is allowed to do: start work this page has
   * queued but not begun.
   */
  useEffect(() => {
    if (renderPriority === "idle") {
      return;
    }

    promotePendingPageTasks(pendingPageTasksRef.current);
  }, [renderPriority]);

  useEffect(() => {
    setExistingAnnotations([]);
    existingAnnotationsPageRef.current = null;
  }, [page]);

  useEffect(() => {
    if (!baseLayerReady || existingAnnotationsPageRef.current === page) {
      return;
    }

    let cancelled = false;
    const cancelScheduledRead = schedulePromotableTask(
      pendingPageTasksRef.current,
      renderPriorityRef.current,
      () => {
        void getDisplayAnnotations(page)
          .then((annotationsForDisplay) => {
            if (!cancelled) {
              existingAnnotationsPageRef.current = page;
              setExistingAnnotations(annotationsForDisplay);
            }
          })
          .catch((error: unknown) => {
            if (!cancelled) {
              logPageDisplayFailure("annotation read", pageIndex, error);
              onNoticeRef.current?.(
                `Could not load annotations on page ${pageIndex + 1}.`,
                {
                  tone: "danger",
                },
              );
            }
          });
      },
    );

    return () => {
      cancelled = true;
      cancelScheduledRead();
    };
  }, [baseLayerReady, onNoticeRef, page, pageIndex, renderPriorityRef]);

  // Only the set of imported image-stamp ids decides whether to hide a
  // native-rendered stamp below, so this narrow key keeps the overlay from
  // re-rendering on every unrelated annotation edit.
  const importedImageStampIdsKey = annotations
    .filter((annotation) => annotation.kind === "imageStamp")
    .map((annotation) => annotation.id)
    .sort()
    .join("|");

  useEffect(() => {
    const appearanceLayer = appearanceLayerRef.current;

    async function renderAnnotationAppearanceOverlay() {
      const overlayCanvas = appearanceLayerRef.current;
      const baseCanvas = baseLayerRef.current?.querySelector<HTMLCanvasElement>(
        ".canvasWrapper canvas",
      );
      if (!overlayCanvas) {
        return;
      }

      const hasAppearanceOverlayAnnotations = existingAnnotations.some(
        (annotation) =>
          shouldRenderExistingAnnotationInAppearanceOverlay(
            annotation,
            annotationsRef.current,
            pageIndex,
          ),
      );
      const hasReadOnlyTextMarkups = existingAnnotations.some(
        isReadOnlyTextMarkupAnnotation,
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

      const context = overlayCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      const baseContext = baseCanvas.getContext("2d", {
        willReadFrequently: true,
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
      overlayCanvas.style.width = `${baseCanvasBounds.width || viewport.width}px`;
      overlayCanvas.style.height = `${baseCanvasBounds.height || viewport.height}px`;

      const scaleX = width / Math.max(1, viewport.width);
      const scaleY = height / Math.max(1, viewport.height);
      if (hasAppearanceOverlayAnnotations) {
        context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
        const renderTask = page.render({
          annotationMode: AnnotationMode.ENABLE,
          background: pageBackgroundColor(pageRef.current),
          canvas: overlayCanvas,
          canvasContext: context,
          viewport,
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
          scaleY,
        );
        context.putImageData(appearancePixels, 0, 0);
        clearManagedAnnotationRectsFromAppearanceOverlay(
          context,
          existingAnnotations,
          annotationsRef.current,
          pageIndex,
          viewport,
          scaleX,
          scaleY,
        );
      }

      if (hasReadOnlyTextMarkups && !cancelled) {
        drawReadOnlyTextDecorations(
          context,
          existingAnnotations,
          viewport,
          scaleX,
          scaleY,
          scale,
        );
      }
    }

    let cancelled = false;
    let appearanceRenderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    const cancelScheduledRender = schedulePromotableTask(
      pendingPageTasksRef.current,
      renderPriorityRef.current,
      () => {
        void renderAnnotationAppearanceOverlay().catch((error: unknown) => {
          if (!cancelled && !isRenderCancellation(error)) {
            logPageDisplayFailure(
              "annotation appearance overlay",
              pageIndex,
              error,
            );
            onNoticeRef.current?.(
              `Could not display some annotations on page ${pageIndex + 1}.`,
              {
                tone: "danger",
              },
            );
          }
        });
      },
    );

    return () => {
      cancelled = true;
      cancelScheduledRender();
      appearanceRenderTask?.cancel();
      if (appearanceLayer) {
        clearCanvas(appearanceLayer);
      }
    };
  }, [
    annotationsRef,
    baseLayerReady,
    existingAnnotations,
    importedImageStampIdsKey,
    onNoticeRef,
    page,
    pageIndex,
    renderPriorityRef,
    scale,
    showAnnotations,
    viewport,
  ]);

  useEffect(() => {
    const annotationLayer = annotationLayerRef.current;

    // pdf.js populates `div` asynchronously inside layer.render() below, so
    // without this guard an invocation superseded by a newer one would still
    // write its nodes into the div once it resolves, landing on top of what the
    // newer render already put there.
    let cancelled = false;

    async function renderAnnotationLayer() {
      const div = annotationLayer;
      if (!div) {
        return;
      }

      div.replaceChildren();
      if (!showAnnotations || !baseLayerReady) {
        return;
      }

      const annotationViewport = viewport.clone({ dontFlip: true });
      const htmlAnnotations = existingAnnotations.filter(
        shouldRenderExistingAnnotationInPdfJsLayer,
      );
      if (htmlAnnotations.length === 0) {
        return;
      }

      const layer = new AnnotationLayer({
        div,
        page,
        viewport: annotationViewport,
        linkService,
        annotationStorage: null,
        annotationCanvasMap: new Map(),
        accessibilityManager: null,
        annotationEditorUIManager: null,
        structTreeLayer: null,
        commentManager: null,
      });

      await layer.render({
        div,
        page,
        viewport: annotationViewport,
        annotations: htmlAnnotations,
        linkService: linkService as unknown as PdfJsAnnotationLinkService,
        downloadManager:
          downloadManager as unknown as PdfJsAnnotationDownloadManager,
        // No embedded PDF script execution and no interactive form widgets:
        // this app only displays existing annotations, never runs their scripts.
        enableScripting: false,
        renderForms: false,
      });

      if (cancelled) {
        div.replaceChildren();
      }
    }

    renderAnnotationLayer().catch((error: unknown) => {
      if (!cancelled) {
        logPageDisplayFailure("annotation layer", pageIndex, error);
        onNoticeRef.current?.(
          `Could not display some annotations on page ${pageIndex + 1}.`,
          {
            tone: "danger",
          },
        );
      }
    });

    return () => {
      cancelled = true;
      annotationLayer?.replaceChildren();
    };
  }, [
    existingAnnotations,
    baseLayerReady,
    linkService,
    onNoticeRef,
    page,
    pageIndex,
    showAnnotations,
    viewport,
  ]);

  useEffect(() => {
    function handleCopy(event: ClipboardEvent) {
      if (
        isEditingTarget(event.target) ||
        !selectedPageAnnotations.some(
          (annotation) => annotation.kind === "textHighlight",
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
        viewport,
      );

      if (!text) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData("text/plain", text);
    }

    window.addEventListener("copy", handleCopy);
    return () => window.removeEventListener("copy", handleCopy);
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
            canvasInkAnnotations,
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
              addedAnnotation.kind === "draw"
                ? inkCanvasRef.current
                : highlightInkCanvasRef.current,
            clear: false,
            displaySize,
            scale,
            viewport,
          });
        }
      } else {
        prepaintedInkAnnotationIdsRef.current.clear();
        renderInkCanvasLayer({
          annotations: canvasInkAnnotations,
          canvas: highlightInkCanvasRef.current,
          displaySize,
          kind: "freehandHighlight",
          scale,
          viewport,
        });
        renderInkCanvasLayer({
          annotations: canvasInkAnnotations,
          canvas: inkCanvasRef.current,
          displaySize,
          kind: "draw",
          scale,
          viewport,
        });
      }

      inkCanvasRenderStateRef.current = {
        annotations: canvasInkAnnotations,
        displaySize,
        pixelRatio: inkCanvasPixelRatio(displaySize),
        scale,
        viewportHeight: viewport.height,
        viewportRotation: viewport.rotation,
        viewportWidth: viewport.width,
      };
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canvasInkAnnotations,
    displaySize,
    scale,
    showSynchronizedAnnotations,
    viewport,
  ]);

  useEffect(() => {
    if (readOnly || tool !== "select") {
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
            viewport,
          ),
        );
      });
    }

    document.addEventListener("selectionchange", updateSelectionAction);
    window.addEventListener("keyup", updateSelectionAction);
    window.addEventListener("mouseup", updateSelectionAction);
    updateSelectionAction();

    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener("selectionchange", updateSelectionAction);
      window.removeEventListener("keyup", updateSelectionAction);
      window.removeEventListener("mouseup", updateSelectionAction);
    };
  }, [readOnly, tool, viewport]);

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    onActivate(pageIndex);
    if (readOnly) {
      return;
    }

    const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
    if ((tool === "draw" || tool === "highlight") && isRightButton) {
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      eraser.begin(point, {
        requireMovement: true,
        scope: tool === "draw" ? "draw" : "highlight",
      });
      return;
    }

    const isPrimaryButton = event.button === 0;
    if (isPrimaryButton && isAnnotationCreationTool(tool)) {
      onEnsureAnnotationsVisible();
    }

    if (isPrimaryButton && (tool === "freeText" || tool === "stickyNote")) {
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
      // layer, so a click that visually lands on a stamp still hits this
      // layer's own empty background.
      if (tool === "select") {
        const point = eventToPdfPoint(event, viewport);
        const hitStamp = [...imageDisplayAnnotations]
          .reverse()
          .find((candidate) => annotationHitTest(candidate, point, scale));
        if (hitStamp) {
          event.preventDefault();
          if (!selectedAnnotationIdSet.has(hitStamp.id)) {
            onSelectAnnotations([hitStamp.id]);
          }
          beginMoveAnnotationAtPoint({
            annotationId: hitStamp.id,
            captureTarget: event.currentTarget,
            point,
            pointerId: event.pointerId,
          });
          return;
        }
      }

      onSelectAnnotations([]);
      dismissedSelectionPointerIdRef.current = event.pointerId;
      event.preventDefault();
      return;
    }

    if (tool === "select") {
      if (event.target === event.currentTarget) {
        onSelectAnnotations([]);
      }
      return;
    }

    if (tool === "eraser") {
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      eraser.begin(point, {
        requireMovement: false,
        scope: "all",
      });
      return;
    }

    if (tool === "lasso") {
      event.preventDefault();
      const point = eventToPdfPoint(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      setLassoPath([point]);
      return;
    }

    if (tool !== "draw" && tool !== "freehandHighlight") {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draftInk.begin(
      tool === "draw" ? "draw" : "freehandHighlight",
      "svg",
      eventToPdfPoint(event, viewport),
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
    if (tool === "highlight" && isRightButton) {
      event.preventDefault();
      onBeginAnnotationEdit({ finishOnPointerUp: true });
      const point = eventToPdfPointFromElement(event, viewport);
      event.currentTarget.setPointerCapture(event.pointerId);
      eraser.begin(point, {
        requireMovement: true,
        scope: "highlight",
      });
      return;
    }

    const isPrimaryButton = event.button === 0;
    if (isPrimaryButton && (tool === "freeText" || tool === "stickyNote")) {
      event.preventDefault();
      onEnsureAnnotationsVisible();
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (
      isPrimaryButton &&
      tool === "select" &&
      isTextLayerTarget(event.target)
    ) {
      return;
    }

    if (
      isPrimaryButton &&
      (tool === "select" || tool === "highlight") &&
      !isTextLayerTarget(event.target)
    ) {
      const point = eventToPdfPointFromElement(event, viewport);
      const hitAnnotation = eraser.findCanvasBackedInkAnnotationAtPoint(point);
      if (hitAnnotation) {
        event.preventDefault();
        onActivate(pageIndex);
        if (!selectedAnnotationIdSet.has(hitAnnotation.id)) {
          onSelectAnnotations([hitAnnotation.id]);
        }
        // The highlight tool shares this select-and-drag affordance with the
        // select tool; the draw tool deliberately does not, since ink strokes
        // are too thin to click precisely while trying to draw nearby.
        if (tool === "select" || tool === "highlight") {
          beginMoveAnnotationAtPoint({
            annotationId: hitAnnotation.id,
            captureTarget: event.currentTarget,
            point,
            pointerId: event.pointerId,
          });
        }
        return;
      }
    }

    if (isPrimaryButton && selectedPageAnnotations.length > 0) {
      onSelectAnnotations([]);
      dismissedSelectionPointerIdRef.current = event.pointerId;
      event.preventDefault();
      return;
    }

    if (tool === "select") {
      onSelectAnnotations([]);
      return;
    }

    if (tool === "highlight") {
      onEnsureAnnotationsVisible();
      const geometry = getActiveTextGeometry();
      const startSegment = nearestTextSegmentFromPointerEventWithGeometry(
        event,
        geometry,
      );
      if (startSegment) {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraftTextHighlight({
          startIndex: startSegment.index,
          currentIndex: startSegment.index,
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
      draftInk.begin("freehandHighlight", "pageDiv", point);
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

    if (eraser.isErasing()) {
      const points = eventToPdfPointsFromElement(event, viewport);
      event.preventDefault();
      eraser.appendPoints(points);
      return;
    }

    // Gated on the draft state itself, not the live `tool`: once a pointer is
    // captured this handler keeps receiving its move and up events even if the
    // tool changes mid-gesture.
    if (draftTextHighlight) {
      event.preventDefault();
      const segment = nearestTextSegmentFromPointerEventWithGeometry(
        event,
        getActiveTextGeometry(),
        { x: 60, y: 24 },
      );
      if (segment) {
        setDraftTextHighlight((current) =>
          current && current.currentIndex !== segment.index
            ? { ...current, currentIndex: segment.index }
            : current,
        );
      }
      return;
    }

    if (draftInk.current()?.origin !== "pageDiv") {
      return;
    }

    const points = eventToPdfPointsFromElement(event, viewport);
    event.preventDefault();
    draftInk.append(points);
  }

  function getActiveTextGeometry() {
    if (!activeTextGeometryRef.current) {
      const textRects = getTextLayerRects(
        textLayerRef.current,
        pageRef.current,
        viewport,
      );
      activeTextGeometryRef.current = {
        hitRects: textRects.map((textRect) => ({
          ...textRect,
          viewportRect: pdfRectToViewportRect(textRect.rect, viewport),
        })),
        textRects,
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
      sourcePoint: activeDragSelection.lastPoint,
    });

    if (nextPosition) {
      dragSelectionRef.current = {
        ...activeDragSelection,
        lastPoint: nextPosition.point,
        pageIndex: nextPosition.pageIndex,
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
    tolerance = { x: 36, y: 16 },
  ) {
    const pageElement = pageRef.current;
    if (!pageElement || geometry.hitRects.length === 0) {
      return null;
    }

    const origin = clientPointToViewportPoint(
      event.clientX,
      event.clientY,
      pageElement.getBoundingClientRect(),
      viewport,
    );
    return nearestTextHitRect(origin, geometry.hitRects, tolerance);
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

    if (eraser.isErasing()) {
      releasePointer(event, event.pointerId);
      eraser.end();
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
        {
          x: 60,
          y: 24,
        },
      );
      const endIndex = endSegment?.index ?? draftTextHighlight.currentIndex;
      const selectedTextRects = textLayerSegmentsInRange(
        geometry.textRects,
        draftTextHighlight.startIndex,
        endIndex,
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
          kind: "textHighlight",
          pageIndex,
          rects,
          quadPoints: rects.map(rectToQuadPoints),
          color: toolSettings.highlightColor,
          opacity: toolSettings.highlightOpacity,
          comment: "",
          coveredText: joinTextLayerSegments(selectedTextRects),
        });
      }
      return;
    }

    if (tool === "freeText" || tool === "stickyNote") {
      releasePointer(event, event.pointerId);
      const origin = clientPointToViewportPoint(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        viewport,
      );
      addTextOrNoteAnnotationAtViewportPoint(origin);
      return;
    }

    if (draftInk.current()?.origin !== "pageDiv") {
      return;
    }

    const path = draftInk.append(eventToPdfPointsFromElement(event, viewport));
    const normalizedPath = normalizeDraftInkPath(path, viewport);
    draftInk.end();
    releasePointer(event, event.pointerId);

    if (
      path.length > 2 &&
      pathLength(path) > freehandHighlightMinLength(viewport)
    ) {
      onAddAnnotation({
        id: crypto.randomUUID(),
        kind: "freehandHighlight",
        pageIndex,
        paths: [normalizedPath],
        color: toolSettings.highlightColor,
        opacity: toolSettings.highlightOpacity,
        width: toolSettings.highlightWidth,
        comment: "",
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
          annotation.kind === "textHighlight"
            ? moveTextHighlightHandle(
                annotation,
                dragHandle.handle,
                point,
                geometry.textRects,
                dragHandle.anchorIndex,
              )
            : annotation,
        { recordUndo: false },
      );
      return;
    }

    if (freeTextResizeHandle) {
      const point = eventToPdfPoint(event, viewport);
      onUpdateAnnotation(
        freeTextResizeHandle.annotationId,
        (annotation) =>
          annotation.kind === "freeText"
            ? resizeFreeTextWidth(
                annotation,
                point,
                freeTextResizeHandle.handle,
              )
            : annotation,
        { recordUndo: false },
      );
      return;
    }

    if (imageStampResizeHandle) {
      const point = eventToPdfPoint(event, viewport);
      onUpdateAnnotation(
        imageStampResizeHandle.annotationId,
        (annotation) =>
          annotation.kind === "imageStamp"
            ? resizeImageStampRect(
                annotation,
                point,
                imageStampResizeHandle.handle,
                scale,
              )
            : annotation,
        { recordUndo: false },
      );
      return;
    }

    if (eraser.isErasing()) {
      const points = eventToPdfPoints(event, viewport);
      event.preventDefault();
      eraser.appendPoints(points);
      return;
    }

    if (lassoPath) {
      const points = eventToPdfPoints(event, viewport);
      event.preventDefault();
      setLassoPath((current) =>
        current ? appendPdfPoints(current, points) : current,
      );
      return;
    }

    // Gated on the draft's own origin, not the live `tool` - see the matching
    // comment in handlePagePointerMove.
    if (draftInk.current()?.origin !== "svg") {
      return;
    }

    const points = eventToPdfPoints(event, viewport);
    event.preventDefault();
    draftInk.append(points);
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

    if (eraser.isErasing()) {
      eraser.end();
    }

    if (lassoPath) {
      setLassoPath(null);
    }

    if (draftTextHighlight) {
      setDraftTextHighlight(null);
      activeTextGeometryRef.current = null;
    }

    if (draftInk.current()) {
      draftInk.end();
    }
  }

  // Escape-key counterpart to handlePointerCancel above: the same cleanup, but
  // unconditional (Escape carries no pointerId) and treating an in-progress
  // annotation move as finished in place rather than abandoned.
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

    if (eraser.isErasing()) {
      eraser.end();
    }

    if (lassoPath) {
      setLassoPath(null);
    }

    if (draftTextHighlight) {
      setDraftTextHighlight(null);
      activeTextGeometryRef.current = null;
    }

    if (draftInk.current()) {
      draftInk.end();
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

    if (eraser.isErasing()) {
      releasePointer(event, event.pointerId);
      eraser.end();
      return;
    }

    if (lassoPath) {
      releasePointer(event, event.pointerId);
      const selectedIds = annotations
        .filter(
          (annotation) =>
            isLassoSelectableAnnotation(annotation) &&
            annotationWhollyInsidePolygon(annotation, lassoPath),
        )
        .map((annotation) => annotation.id);
      onSelectAnnotations(selectedIds);
      onToolChange("select");
      setLassoPath(null);
      return;
    }

    // Gated on the draft's own origin and kind, not the live `tool`: the
    // gesture may have started under a different tool, so every style and shape
    // decision below uses the kind captured at pointerdown.
    const svgDraft = draftInk.current();
    if (svgDraft?.origin === "svg") {
      const draftKind = svgDraft.kind;
      const path = draftInk.append(eventToPdfPoints(event, viewport));
      const normalizedPath =
        draftKind === "draw" && pathLength(path) <= inkDotMaxLength(viewport)
          ? dotPath(path[0], toolSettings.drawWidth)
          : normalizeDraftInkPath(path, viewport);
      let annotation: PdfAnnotation | null = null;
      if (
        (draftKind === "draw" ? normalizedPath.length > 0 : path.length > 2) &&
        (draftKind !== "freehandHighlight" ||
          pathLength(path) > freehandHighlightMinLength(viewport))
      ) {
        annotation = {
          id: crypto.randomUUID(),
          kind: draftKind,
          pageIndex,
          paths: [normalizedPath],
          color:
            draftKind === "draw"
              ? toolSettings.drawColor
              : toolSettings.highlightColor,
          opacity:
            draftKind === "draw"
              ? toolSettings.drawOpacity
              : toolSettings.highlightOpacity,
          width:
            draftKind === "draw"
              ? toolSettings.drawWidth
              : toolSettings.highlightWidth,
          // What kind of ink this is travels in /IT (Ink vs InkHighlight);
          // /Contents is the reader's own note.
          comment: "",
        };
        // Paint the finalized, smoothed stroke before clearing the raw draft
        // layer so pen-up does not leave a visible gap on dense pages.
        eraser.prepaintCommittedInkAnnotation(annotation);
      }

      draftInk.end();
      releasePointer(event, event.pointerId);

      if (annotation) {
        onAddAnnotation(annotation);
      }

      return;
    }

    if (event.target !== event.currentTarget) {
      return;
    }

    if (tool === "freeText" || tool === "stickyNote") {
      addTextOrNoteAnnotationAtViewportPoint(
        eventToViewportPoint(event, viewport),
      );
    }
  }

  function addTextOrNoteAnnotationAtViewportPoint(origin: PdfPoint) {
    if (tool !== "freeText" && tool !== "stickyNote") {
      return;
    }

    const textHeight = Math.max(84, toolSettings.textFontSize * scale * 4);
    const textLineHeight =
      toolSettings.textFontSize * scale * FREE_TEXT_LINE_HEIGHT;
    const noteSize = 28;
    const rect =
      tool === "freeText"
        ? viewportRectToPdfRect(
            origin.x,
            origin.y - textLineHeight / 2,
            260,
            textHeight,
            viewport,
          )
        : viewportRectToPdfRect(
            origin.x - noteSize / 2,
            origin.y - noteSize / 2,
            noteSize,
            noteSize,
            viewport,
          );

    const annotation: PdfAnnotation =
      tool === "freeText"
        ? {
            id: crypto.randomUUID(),
            kind: "freeText",
            pageIndex,
            rect,
            text: "",
            fontSize: toolSettings.textFontSize,
            color: toolSettings.textColor,
            opacity: toolSettings.textOpacity,
          }
        : {
            id: crypto.randomUUID(),
            kind: "stickyNote",
            pageIndex,
            rect,
            text: "",
            color: toolSettings.noteColor,
          };

    onAddAnnotation(annotation);
    onToolChange("select");
  }

  // Stable (its deps are pageIndex plus stable ref objects) so it can be passed
  // to AnnotationShape without re-rendering every annotation on the page; reads
  // current values through refs instead of closing over them.
  const beginMoveAnnotationAtPoint = useCallback(
    ({
      annotationId,
      captureTarget,
      point,
      pointerId,
    }: {
      annotationId: string;
      captureTarget: Element;
      point: PdfPoint;
      pointerId: number;
    }) => {
      const targetAnnotation = annotationsRef.current.find(
        (annotation) => annotation.id === annotationId,
      );
      if (targetAnnotation?.kind === "textHighlight") {
        return;
      }

      const pageAnnotationIds = new Set(
        annotationsRef.current.map((annotation) => annotation.id),
      );
      const selectedOnPage = selectedAnnotationIdsRef.current.filter((id) =>
        pageAnnotationIds.has(id),
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
        pointerId,
      };
      dragSelectionRef.current = nextDragSelection;
    },
    [
      annotationsRef,
      onBeginAnnotationEditRef,
      pageIndex,
      selectedAnnotationIdsRef,
    ],
  );

  const beginMoveAnnotation = useCallback(
    (event: React.PointerEvent<SVGGElement>, annotationId: string) => {
      if (
        readOnlyRef.current ||
        (toolRef.current !== "select" && toolRef.current !== "highlight")
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
        pointerId: event.pointerId,
      });
    },
    [beginMoveAnnotationAtPoint, readOnlyRef, toolRef, viewportRef],
  );

  // AnnotationShape's callback props must all be stable, or the memoized shapes
  // re-render on every unrelated entry of the annotation array.
  const handleAnnotationSelect = useCallback(
    (annotationId: string) => {
      onActivateRef.current(pageIndex);
      onSelectAnnotationsRef.current([annotationId]);
    },
    [onActivateRef, onSelectAnnotationsRef, pageIndex],
  );

  const handleAnnotationHoverChange = useCallback(
    (hovered: boolean, annotationId: string) => {
      setHoveredAnnotationId(hovered ? annotationId : null);
    },
    [],
  );

  const handleAnnotationUpdate = useCallback(
    (
      annotationId: string,
      updater: (annotation: PdfAnnotation) => PdfAnnotation,
    ) => {
      onUpdateAnnotationRef.current(annotationId, updater, {
        recordUndo: false,
      });
    },
    [onUpdateAnnotationRef],
  );

  const handleAnnotationFocusEnd = useCallback(
    (annotationId: string) => {
      onFocusAnnotationConsumedRef.current(annotationId);
    },
    [onFocusAnnotationConsumedRef],
  );

  const handleAnnotationBeginEdit = useCallback(() => {
    onBeginAnnotationEditRef.current();
  }, [onBeginAnnotationEditRef]);

  const handleBeginHighlightHandleDrag = useCallback(
    (
      event: React.PointerEvent<SVGCircleElement>,
      handle: "start" | "end",
      annotationId: string,
    ) => {
      event.stopPropagation();
      onBeginAnnotationEditRef.current({ finishOnPointerUp: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const annotation = annotationsRef.current.find(
        (candidate) => candidate.id === annotationId,
      );
      const geometry = getActiveTextGeometryRef.current();
      setDragHandle({
        anchorIndex:
          annotation?.kind === "textHighlight"
            ? oppositeHighlightHandleAnchor(
                annotation,
                handle,
                geometry.textRects,
              )
            : null,
        annotationId,
        handle,
        pointerId: event.pointerId,
      });
    },
    [annotationsRef, getActiveTextGeometryRef, onBeginAnnotationEditRef],
  );

  const handleBeginFreeTextResizeHandleDrag = useCallback(
    (
      event: React.PointerEvent<SVGCircleElement>,
      handle: "left" | "right",
      annotationId: string,
    ) => {
      event.stopPropagation();
      onBeginAnnotationEditRef.current({ finishOnPointerUp: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      setFreeTextResizeHandle({
        annotationId,
        handle,
        pointerId: event.pointerId,
      });
    },
    [onBeginAnnotationEditRef],
  );

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

    const isHighlightTool = tool === "highlight" || tool === "textHighlight";
    if (
      !isHighlightTool ||
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
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
      viewport,
    );

    if (rects.length > 0) {
      onAddAnnotation({
        id: crypto.randomUUID(),
        kind: "textHighlight",
        pageIndex,
        rects,
        quadPoints,
        color: toolSettings.highlightColor,
        opacity: toolSettings.highlightOpacity,
        comment: "",
        coveredText: selection.toString(),
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
              draftTextHighlight.currentIndex,
            ),
          )
        : [],
    [draftTextHighlight],
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
              rects: draftTextHighlightRects,
            }
          : undefined,
      viewport,
    });
  }, [
    annotations,
    displaySize,
    draftTextHighlightRects,
    showSynchronizedAnnotations,
    toolSettings.highlightColor,
    toolSettings.highlightOpacity,
    viewport,
  ]);

  function copySelectedHighlightText() {
    const text = getTextForHighlights(
      selectedPageAnnotations,
      textLayerRef.current,
      pageRef.current,
      viewport,
    );
    if (!text || !navigator.clipboard) {
      return;
    }

    void navigator.clipboard.writeText(text).catch(() => {
      onNotice?.("Could not copy text.");
    });
  }

  function createHighlightFromTextSelection(
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();

    if (!textSelectionHighlightAction) {
      return;
    }

    onEnsureAnnotationsVisible();
    onAddAnnotation({
      id: crypto.randomUUID(),
      kind: "textHighlight",
      pageIndex,
      rects: textSelectionHighlightAction.rects,
      quadPoints: textSelectionHighlightAction.quadPoints,
      color: toolSettings.highlightColor,
      opacity: toolSettings.highlightOpacity,
      comment: "",
      coveredText: textSelectionHighlightAction.coveredText,
    });
    window.getSelection()?.removeAllRanges();
    setTextSelectionHighlightAction(null);
  }

  return (
    <article
      aria-current={active ? "page" : undefined}
      className="pdfdocumenteditor-page-frame"
      data-page-ready={baseLayerReady ? "true" : "false"}
      onClick={() => onActivate(pageIndex)}
    >
      <div
        className="pdfdocumenteditor-page"
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
        <div className="pdfdocumenteditor-fill">
          <div
            className="pdfViewer pdfdocumenteditor-fill"
            ref={baseLayerRef}
            style={
              {
                "--page-border": "0 solid transparent",
                "--page-margin": "0",
                "--scale-factor": String(scale),
              } as React.CSSProperties
            }
          />
          <canvas
            className="pdfdocumenteditor-annotation-appearance-layer pdfdocumenteditor-fill"
            ref={appearanceLayerRef}
          />
          <div
            className="annotationLayer pdfdocumenteditor-fill"
            ref={annotationLayerRef}
            style={{ pointerEvents: "none" }}
          />
          {showSynchronizedAnnotations && imageDisplayAnnotations.length > 0 ? (
            <svg
              className="pdfdocumenteditor-image-stamp-layer pdfdocumenteditor-fill"
              height={displaySize.height}
              style={{ pointerEvents: readOnly ? "none" : "auto" }}
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
                  onBeginMoveDrag={beginMoveAnnotation}
                  onHoverChange={handleAnnotationHoverChange}
                  onBeginEdit={handleAnnotationBeginEdit}
                  onFocusEnd={handleAnnotationFocusEnd}
                  onSelect={handleAnnotationSelect}
                  onUpdate={handleAnnotationUpdate}
                  partOfSelection={selectedAnnotationIdSet.has(annotation.id)}
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
            className="pdfdocumenteditor-ink-canvas-layer pdfdocumenteditor-highlight-canvas-layer pdfdocumenteditor-fill"
            ref={textHighlightCanvasRef}
          />
          <canvas
            className="pdfdocumenteditor-ink-canvas-layer pdfdocumenteditor-highlight-canvas-layer pdfdocumenteditor-fill"
            ref={highlightInkCanvasRef}
          />
          <canvas
            className="pdfdocumenteditor-ink-canvas-layer pdfdocumenteditor-fill"
            ref={inkCanvasRef}
          />
          <canvas
            className="pdfdocumenteditor-ink-canvas-layer pdfdocumenteditor-highlight-canvas-layer pdfdocumenteditor-fill"
            ref={draftInk.draftHighlightInkCanvasRef}
          />
          <canvas
            className="pdfdocumenteditor-ink-canvas-layer pdfdocumenteditor-fill"
            ref={draftInk.draftInkCanvasRef}
          />
          <canvas
            className="pdfdocumenteditor-ink-canvas-layer pdfdocumenteditor-fill"
            ref={eraser.eraserCanvasRef}
          />
          {shouldMountInteractionOverlay ? (
            <svg
              className="pdfdocumenteditor-interaction-layer pdfdocumenteditor-fill"
              height={displaySize.height}
              style={{
                pointerEvents:
                  overlayCapturesPointer ||
                  (selectedPageAnnotations.length > 0 && tool !== "highlight")
                    ? "auto"
                    : "none",
              }}
              viewBox={`0 0 ${viewport.width} ${viewport.height}`}
              width={displaySize.width}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
            >
              {showSynchronizedAnnotations
                ? vectorDisplayAnnotations.map((annotation) => (
                    <AnnotationShape
                      annotation={annotation}
                      focused={focusedAnnotationId === annotation.id}
                      key={annotation.id}
                      onBeginHighlightHandleDrag={
                        handleBeginHighlightHandleDrag
                      }
                      onBeginFreeTextResizeHandleDrag={
                        handleBeginFreeTextResizeHandleDrag
                      }
                      onBeginMoveDrag={beginMoveAnnotation}
                      onHoverChange={handleAnnotationHoverChange}
                      onBeginEdit={handleAnnotationBeginEdit}
                      onFocusEnd={handleAnnotationFocusEnd}
                      onSelect={handleAnnotationSelect}
                      onUpdate={handleAnnotationUpdate}
                      partOfSelection={selectedAnnotationIdSet.has(
                        annotation.id,
                      )}
                      readOnly={readOnly}
                      scale={scale}
                      selected={selectedAnnotationIdSet.has(annotation.id)}
                      showPopover={
                        annotation.kind === "stickyNote"
                          ? focusedAnnotationId === annotation.id ||
                            selectedAnnotationIdSet.has(annotation.id)
                          : focusedAnnotationId === annotation.id ||
                            (selectedPageAnnotations.length <= 1 &&
                              selectedAnnotationIdSet.has(annotation.id)) ||
                            hoveredAnnotationId === annotation.id
                      }
                      tool={tool}
                      viewport={viewport}
                    />
                  ))
                : null}
              {showSynchronizedAnnotations
                ? selectedPageAnnotations
                    .filter((annotation) => annotation.kind === "imageStamp")
                    .map((annotation) => (
                      <ImageStampSelectionOverlay
                        annotation={annotation}
                        key={`image-selection-${annotation.id}`}
                        onBeginDrag={(event, handle) => {
                          event.stopPropagation();
                          onBeginAnnotationEdit({ finishOnPointerUp: true });
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                          setImageStampResizeHandle({
                            annotationId: annotation.id,
                            handle,
                            pointerId: event.pointerId,
                          });
                        }}
                        viewport={viewport}
                      />
                    ))
                : null}
              {!readOnly &&
              showSynchronizedAnnotations &&
              selectedPageAnnotations.length > 0 ? (
                <SelectionToolbar
                  annotations={selectedPageAnnotations}
                  onBeginEdit={onBeginAnnotationEdit}
                  onDelete={() =>
                    onDeleteAnnotations(
                      selectedPageAnnotations.map(
                        (annotation) => annotation.id,
                      ),
                    )
                  }
                  onClose={() => onSelectAnnotations([])}
                  onCopyText={copySelectedHighlightText}
                  onUpdate={(updater) => {
                    onUpdateAnnotations(
                      selectedPageAnnotations.map(
                        (annotation) => annotation.id,
                      ),
                      updater,
                      { recordUndo: false },
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
              aria-label="Highlight selection"
              className="text-selection-highlight-button"
              onClick={createHighlightFromTextSelection}
              onPointerDown={(event) => event.stopPropagation()}
              // The button previews the highlight it will create, so it
              // wears the highlighter's own colour rather than the app
              // accent.
              style={
                {
                  left: textSelectionHighlightAction.x,
                  top: textSelectionHighlightAction.y,
                  "--app-selection-button-color": rgbToCss(
                    toolSettings.highlightColor,
                  ),
                  "--app-selection-button-ink": foregroundOn(
                    toolSettings.highlightColor,
                  ),
                } as React.CSSProperties
              }
              title="Highlight selection"
              type="button"
            >
              <Highlighter size={16} />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export const PdfPageView = memo(PdfPageViewComponent, arePdfPageViewPropsEqual);

/*
 * The memo contract, in one rule: every data prop must be compared here, and
 * every callback prop must not be.
 */
function arePdfPageViewPropsEqual(
  previous: PdfPageViewProps,
  next: PdfPageViewProps,
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
      next.selectedAnnotationIds,
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

function annotationRenderRank(annotation: PdfAnnotation) {
  switch (annotation.kind) {
    case "textHighlight":
    case "freehandHighlight":
      return 0;
    case "imageStamp":
      return 1;
    case "draw":
      return 2;
    case "freeText":
      return 3;
    case "stickyNote":
      return 4;
  }
}

function sameInkCanvasRenderFrame(
  previous: InkCanvasRenderState,
  displaySize: PageDisplaySize,
  scale: number,
  viewport: PageViewport,
) {
  return (
    displaySizesMatch(previous.displaySize, displaySize) &&
    previous.pixelRatio === inkCanvasPixelRatio(displaySize) &&
    previous.scale === scale &&
    previous.viewportWidth === viewport.width &&
    previous.viewportHeight === viewport.height &&
    // Width and height alone cannot distinguish a rotation on a square page,
    // which would let the single-added-stroke fast path paint just the new
    // stroke onto a stale, pre-rotation canvas.
    previous.viewportRotation === viewport.rotation
  );
}

function findSingleAddedInkAnnotation(
  previousAnnotations: PdfAnnotation[],
  nextAnnotations: PdfAnnotation[],
) {
  if (nextAnnotations.length !== previousAnnotations.length + 1) {
    return null;
  }

  const previousById = new Map(
    previousAnnotations.map((annotation) => [annotation.id, annotation]),
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

  return addedAnnotation?.kind === "draw" ||
    addedAnnotation?.kind === "freehandHighlight"
    ? addedAnnotation
    : null;
}

function isCanvasBackedInkAnnotation(
  annotation: PdfAnnotation,
  selectedAnnotationIds: Set<string>,
) {
  return (
    !selectedAnnotationIds.has(annotation.id) &&
    (annotation.kind === "draw" || annotation.kind === "freehandHighlight")
  );
}

/*
 * Reading --app-selection back as a property value can return a raw hex
 * string directly, but a hidden probe keeps this working regardless of how
 * a project defines the token (e.g. light-dark(), which a canvas 2D context
 * ignores).
 */
function resolvedSelectionColor(element: Element | null) {
  const scope =
    element?.closest(`.${DOCUMENT_EDITOR_ROOT_CLASS}`) ??
    element ??
    document.documentElement;
  const probe = document.createElement("span");
  probe.style.cssText = "display: none; color: var(--app-selection)";
  scope.append(probe);
  const resolved = getComputedStyle(probe).color.trim();
  probe.remove();

  // For the case where the probe returns nothing at all (a detached tree, a
  // document with no stylesheet).
  return resolved || "#1a56b0";
}

function getTextSelectionHighlightAction(
  selection: Selection | null,
  pageElement: HTMLDivElement | null,
  textLayerElement: HTMLDivElement | null,
  viewport: PageViewport,
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

  const coveredText = selection.toString();
  if (coveredText.trim().length === 0) {
    return null;
  }

  const { rects, quadPoints } = getSelectedTextRects(
    selection,
    pageElement,
    textLayerElement,
    viewport,
  );
  const firstRect = rects[0];
  if (!firstRect) {
    return null;
  }

  const pageBounds = pageElement.getBoundingClientRect();
  const viewportBounds = pdfRectToViewportRect(firstRect, viewport);
  const xScale = pageBounds.width / Math.max(1, viewport.width);
  const yScale = pageBounds.height / Math.max(1, viewport.height);
  const buttonSize = SELECTION_BUTTON_SIZE;
  const pagePadding = SELECTION_BUTTON_PAGE_PADDING;

  return {
    coveredText,
    quadPoints,
    rects,
    x: clamp(
      viewportBounds.x * xScale - buttonSize - pagePadding,
      pagePadding,
      Math.max(pagePadding, pageBounds.width - buttonSize - pagePadding),
    ),
    y: clamp(
      viewportBounds.y * yScale - buttonSize - pagePadding,
      pagePadding,
      Math.max(pagePadding, pageBounds.height - buttonSize - pagePadding),
    ),
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

function appendPdfPoints(path: PdfPoint[], points: PdfPoint[]) {
  const next = [...path];
  for (const point of points) {
    appendMutableInkPoint(next, point, Number.EPSILON);
  }
  return next;
}

function isTextLayerTarget(target: EventTarget) {
  return (
    target instanceof Element && Boolean(target.closest(".textLayer span"))
  );
}

function isPdfLinkTarget(target: EventTarget) {
  return (
    target instanceof Element && Boolean(target.closest(".annotationLayer a"))
  );
}

/*
 * The used background of the page element, not the token behind it: a custom
 * property carries a host's `light-dark(#a, #b)` through verbatim, and an
 * invalid fillStyle is silently ignored.
 */
function pageBackgroundColor(element: HTMLElement | null) {
  const value = element ? getComputedStyle(element).backgroundColor : "";
  return value && value !== "transparent" && value !== "rgba(0, 0, 0, 0)"
    ? value
    : "white";
}

function isEditingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT" ||
      target.isContentEditable)
  );
}
