import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { rgbToCss } from "./annotationColors";
import { dotPath, pathLength } from "./annotationGeometry";
import {
  appendDraftInkPoints,
  inkDotMaxLength,
  normalizeDraftInkPath,
} from "./inkCapture";
import {
  clearDisplayCanvas,
  drawInkCanvasPath,
  prepareInkCanvasContextState,
} from "./inkRendering";
import type {
  PageDisplaySize,
  PageViewport,
  PdfPoint,
  ToolSettings,
} from "./types";
import { clamp } from "./viewerConfig";

type DraftInkPath = {
  kind: "draw" | "freehandHighlight";
  // Finalize and cleanup must key off this fixed origin rather than the live
  // tool: pointer capture routes every later event through both surfaces, so a
  // mid-gesture tool switch otherwise leaves the draft stuck for ever.
  origin: "pageDiv" | "svg";
  path: PdfPoint[];
};

type DraftInkParams = {
  displaySize: PageDisplaySize;
  scale: number;
  toolSettings: ToolSettings;
  viewport: PageViewport;
};

type DraftInkApi = {
  // Returns the extended path, so pointerup commits the points this paints.
  append: (points: PdfPoint[]) => PdfPoint[];
  begin: (
    kind: DraftInkPath["kind"],
    origin: DraftInkPath["origin"],
    point: PdfPoint,
  ) => void;
  // For callers that must branch on the origin, not the current tool.
  current: () => DraftInkPath | null;
  draftHighlightInkCanvasRef: RefObject<HTMLCanvasElement | null>;
  draftInkCanvasRef: RefObject<HTMLCanvasElement | null>;
  end: () => void;
};

/*
 * The functions are plain closures over the current render's props; only the
 * unmount cleanup needs a ref, because its effect never re-subscribes.
 */
export function useDraftInk({
  displaySize,
  scale,
  toolSettings,
  viewport,
}: DraftInkParams): DraftInkApi {
  const draftInkCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftHighlightInkCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftInkPathRef = useRef<DraftInkPath | null>(null);
  const draftInkFrameRef = useRef<number | null>(null);

  function clearDraftInkCanvases() {
    clearDisplayCanvas(draftInkCanvasRef.current);
    clearDisplayCanvas(draftHighlightInkCanvasRef.current);
  }

  function beginDraftInkPath(
    kind: DraftInkPath["kind"],
    origin: DraftInkPath["origin"],
    point: PdfPoint,
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
        draft.kind === "draw"
          ? draftInkCanvasRef.current
          : draftHighlightInkCanvasRef.current,
      clear: true,
      displaySize,
      viewport,
    });
    if (!prepared) {
      return;
    }

    const color =
      draft.kind === "draw"
        ? toolSettings.drawColor
        : toolSettings.highlightColor;
    const opacity =
      draft.kind === "draw"
        ? toolSettings.drawOpacity
        : toolSettings.highlightOpacity;
    const width =
      draft.kind === "draw"
        ? toolSettings.drawWidth
        : toolSettings.highlightWidth;
    const displayPath =
      draft.kind === "draw" &&
      pathLength(draft.path) <= inkDotMaxLength(viewport)
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
      width * scale,
    );
    prepared.context.globalAlpha = 1;
  }

  useEffect(
    // The canvases outlive the frame callback, so unmounting mid-stroke must
    // not leave a scheduled repaint or painted pixels behind.
    () => () => {
      const frame = draftInkFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        draftInkFrameRef.current = null;
      }
      clearDraftInkCanvases();
    },
    [],
  );

  return {
    append: appendDraftInkPath,
    begin: beginDraftInkPath,
    current: () => draftInkPathRef.current,
    draftHighlightInkCanvasRef,
    draftInkCanvasRef,
    end: endDraftInkPath,
  };
}
