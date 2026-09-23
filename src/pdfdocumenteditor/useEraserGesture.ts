import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  annotationHitTest,
  boundsForPoints,
  pathHitTest,
  pathLength,
} from "./annotationGeometry";
import {
  annotationMatchesEraserScope,
  buildEraserAnnotationIndex,
  queryEraserAnnotationIndex,
  type EraserAnnotationIndex,
  type EraserScope,
} from "./eraserGeometry";
import { appendMutableInkPoint } from "./inkCapture";
import {
  clearDisplayCanvas,
  drawInkCanvasAnnotation,
  eraseInkCanvasPaths,
  renderPdfPathCanvas,
} from "./inkRendering";
import { viewportPointToPdfPoint } from "./pdfGeometry";
import { useRenderLatestRef } from "./useRenderLatestRef";
import type {
  PageDisplaySize,
  PageViewport,
  PdfAnnotation,
  PdfPoint,
  PdfRect,
  ToolSettings,
} from "./types";

export type AnnotationPathUpdate = {
  annotationId: string;
  paths: PdfPoint[][];
};

type EraserGesture = {
  pendingUntilDrag: boolean;
};

type PendingEraseChanges = {
  deleteIds: Set<string>;
  pathUpdates: Map<string, PdfPoint[][]>;
};

type EraserGestureParams = {
  annotations: PdfAnnotation[];
  // In stacking order; hit testing walks it backwards so the top stroke wins.
  canvasInkAnnotations: PdfAnnotation[];
  displaySize: PageDisplaySize;
  highlightInkCanvasRef: RefObject<HTMLCanvasElement | null>;
  inkCanvasRef: RefObject<HTMLCanvasElement | null>;
  onEraseAnnotations: (changes: {
    deleteIds: string[];
    pathUpdates: AnnotationPathUpdate[];
  }) => void;
  // Owned by the ink canvas render effect: a prepainted stroke tells it to
  // skip repainting that one.
  prepaintedInkAnnotationIdsRef: RefObject<Set<string>>;
  // "Resolves" is load-bearing: a theme token can hold a `light-dark(...)`
  // literal, which canvas cannot parse and drops silently.
  previewColor: () => string;
  readOnly: boolean;
  scale: number;
  showSynchronizedAnnotations: boolean;
  // Armed once a right-drag passes the minimum distance; read by the page's
  // own contextmenu handler.
  suppressNextContextMenuRef: RefObject<boolean>;
  toolSettings: ToolSettings;
  viewport: PageViewport;
};

type EraserGestureApi = {
  appendPoints: (points: PdfPoint[]) => void;
  begin: (
    point: PdfPoint,
    options: { requireMovement: boolean; scope: EraserScope },
  ) => void;
  end: () => void;
  eraserCanvasRef: RefObject<HTMLCanvasElement | null>;
  findCanvasBackedInkAnnotationAtPoint: (
    point: PdfPoint,
  ) => PdfAnnotation | null;
  isErasing: () => boolean;
  prepaintCommittedInkAnnotation: (annotation: PdfAnnotation) => void;
};

const TYPE_ERASER_MIN_DISTANCE_PX = 5;

/*
 * The functions are plain closures over the current render's props; only the
 * unmount cleanup needs a ref, because its effect never re-subscribes.
 */
export function useEraserGesture({
  annotations,
  canvasInkAnnotations,
  displaySize,
  highlightInkCanvasRef,
  inkCanvasRef,
  onEraseAnnotations,
  prepaintedInkAnnotationIdsRef,
  previewColor,
  readOnly,
  scale,
  showSynchronizedAnnotations,
  suppressNextContextMenuRef,
  toolSettings,
  viewport,
}: EraserGestureParams): EraserGestureApi {
  const eraserCanvasRef = useRef<HTMLCanvasElement>(null);
  const eraserScopeRef = useRef<EraserScope>("all");
  const eraserGestureRef = useRef<EraserGesture | null>(null);
  const eraserAnnotationIndexRef = useRef<EraserAnnotationIndex | null>(null);
  const eraserPathRef = useRef<PdfPoint[] | null>(null);
  const eraserPreviewFrameRef = useRef<number | null>(null);
  const eraserRemainingPathsRef = useRef<Map<string, PdfPoint[][]>>(new Map());
  const eraserDeletedIdsRef = useRef<Set<string>>(new Set());
  const pendingEraseChangesRef = useRef<PendingEraseChanges>({
    deleteIds: new Set(),
    pathUpdates: new Map(),
  });
  const pathBoundsCacheRef = useRef<WeakMap<PdfPoint[], PdfRect>>(
    new WeakMap(),
  );

  function findCanvasBackedInkAnnotationAtPoint(point: PdfPoint) {
    for (let index = canvasInkAnnotations.length - 1; index >= 0; index -= 1) {
      const annotation = canvasInkAnnotations[index];
      if (annotationHitTest(annotation, point, scale)) {
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
    // Ink edits are deferred to gesture-end: one stroke is hundreds of samples
    // and committing state on each forces expensive re-renders.
    const deleteIds: string[] = [];
    const pathUpdates: AnnotationPathUpdate[] = [];
    const immediateDeleteIds: string[] = [];

    for (const { annotation, bounds } of queryEraserAnnotationIndex(
      eraserAnnotationIndex,
      point,
    )) {
      if (eraserDeletedIdsRef.current.has(annotation.id)) {
        continue;
      }

      if (!annotationMatchesEraserScope(annotation, scope)) {
        continue;
      }

      if (
        annotation.kind === "draw" ||
        annotation.kind === "freehandHighlight"
      ) {
        const eraserRadius = Math.max(
          toolSettings.eraserWidth / 2 / scale,
          1 / scale,
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
            currentPaths.filter((path) => !remainingPathSet.has(path)),
          );
          pathUpdates.push({
            annotationId: annotation.id,
            paths: remainingPaths,
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
    pathUpdates: AnnotationPathUpdate[],
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

    // Once at gesture-end: state per eraser sample forces expensive redraws.
  }

  function flushPendingEraseChanges() {
    const pending = pendingEraseChangesRef.current;
    if (pending.deleteIds.size === 0 && pending.pathUpdates.size === 0) {
      return;
    }

    pendingEraseChangesRef.current = {
      deleteIds: new Set(),
      pathUpdates: new Map(),
    };
    onEraseAnnotations({
      deleteIds: Array.from(pending.deleteIds),
      pathUpdates: Array.from(pending.pathUpdates, ([annotationId, paths]) => ({
        annotationId,
        paths,
      })),
    });
  }

  function eraseCommittedInkPaths(
    annotation: Extract<PdfAnnotation, { kind: "draw" | "freehandHighlight" }>,
    paths: PdfPoint[][],
  ) {
    if (!showSynchronizedAnnotations || paths.length === 0) {
      return;
    }

    eraseInkCanvasPaths({
      annotation,
      canvas:
        annotation.kind === "draw"
          ? inkCanvasRef.current
          : highlightInkCanvasRef.current,
      displaySize,
      paths,
      scale,
      viewport,
    });
  }

  function prepaintCommittedInkAnnotation(annotation: PdfAnnotation) {
    if (
      !showSynchronizedAnnotations ||
      (annotation.kind !== "draw" && annotation.kind !== "freehandHighlight")
    ) {
      return;
    }

    drawInkCanvasAnnotation({
      annotation,
      canvas:
        annotation.kind === "draw"
          ? inkCanvasRef.current
          : highlightInkCanvasRef.current,
      clear: false,
      displaySize,
      scale,
      viewport,
    });
    prepaintedInkAnnotationIdsRef.current.add(annotation.id);
  }

  function beginEraserGesture(
    point: PdfPoint,
    {
      requireMovement,
      scope,
    }: {
      requireMovement: boolean;
      scope: EraserScope;
    },
  ) {
    flushPendingEraseChanges();
    eraserScopeRef.current = scope;
    eraserAnnotationIndexRef.current = buildEraserAnnotationIndex(
      annotations,
      scale,
      toolSettings.eraserWidth,
    );
    eraserPathRef.current = [point];
    eraserRemainingPathsRef.current = new Map();
    eraserDeletedIdsRef.current = new Set();
    eraserGestureRef.current = {
      pendingUntilDrag: requireMovement,
    };
    // Reset here rather than derived from `requireMovement`, which is also true
    // for the left-click eraser tool.
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

    const nextPath = appendMutableEraserPoints(currentPath, points);
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
    eraserScopeRef.current = "all";
    eraserRemainingPathsRef.current = new Map();
    eraserDeletedIdsRef.current = new Set();
    const frame = eraserPreviewFrameRef.current;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      eraserPreviewFrameRef.current = null;
    }
    clearDisplayCanvas(eraserCanvasRef.current);
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
      color: previewColor(),
      displaySize,
      opacity: 0.35,
      path,
      viewport,
      width: toolSettings.eraserWidth,
    });
  }

  // The unmount cleanup never re-subscribes, so it would otherwise hold the
  // first render's flush and drop erases queued later.
  const flushPendingEraseChangesRef = useRenderLatestRef(
    flushPendingEraseChanges,
  );

  useEffect(
    // Queued erases are already painted out of the ink canvases, so dropping
    // them would put the strokes back on the next render.
    () => () => {
      const frame = eraserPreviewFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        eraserPreviewFrameRef.current = null;
      }
      flushPendingEraseChangesRef.current();
      clearDisplayCanvas(eraserCanvasRef.current);
    },
    [flushPendingEraseChangesRef],
  );

  return {
    appendPoints: appendEraserPoints,
    begin: beginEraserGesture,
    end: endEraserGesture,
    eraserCanvasRef,
    findCanvasBackedInkAnnotationAtPoint,
    isErasing: () => eraserPathRef.current !== null,
    prepaintCommittedInkAnnotation,
  };
}

function appendMutableEraserPoints(path: PdfPoint[], points: PdfPoint[]) {
  for (const point of points) {
    appendMutableInkPoint(path, point, Number.EPSILON);
  }
  return path;
}

function cachedPathBounds(
  path: PdfPoint[],
  cache: WeakMap<PdfPoint[], PdfRect>,
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
  padding: number,
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
