import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PageViewport,
  PdfAnnotation,
} from "../src/pdfdocumenteditor/types";
import "./rendererAssetStubs";

// Every page on or near the screen carries a text-highlight, a freehand-highlight and an ink layer, each as large as the page at up to twice its resolution; sizing all three on pages with nothing to show made each page's first paint allocate and clear them for nothing.

// inkRendering reaches pdf.js through pdfRender, so this import has to run after the stubs the side-effect import above registers.
const { renderInkCanvasLayer, renderTextHighlightCanvas } =
  await import("../src/pdfdocumenteditor/inkRendering");

const displaySize = { height: 800, width: 600 };
const viewport = {
  convertToViewportPoint: (x: number, y: number) => [x, y],
  height: 800,
  width: 600,
} as unknown as PageViewport;

// jsdom has no 2D rasteriser; a context that takes every drawing call leaves the canvas's own size as the thing under test.
const anyDrawingCall = new Proxy(
  {},
  { get: () => () => undefined, set: () => true },
) as CanvasRenderingContext2D;

HTMLCanvasElement.prototype.getContext = (() =>
  anyDrawingCall) as unknown as HTMLCanvasElement["getContext"];

const highlight = {
  color: [1, 1, 0],
  id: "highlight-1",
  kind: "textHighlight",
  opacity: 0.4,
  pageIndex: 0,
  rects: [{ x1: 10, x2: 110, y1: 20, y2: 34 }],
} as unknown as PdfAnnotation;

test("an ink or highlight layer with nothing to draw keeps no pixels", () => {
  for (const kind of ["draw", "freehandHighlight"] as const) {
    const canvas = document.createElement("canvas");
    renderInkCanvasLayer({
      annotations: [highlight],
      canvas,
      displaySize,
      kind,
      scale: 1,
      viewport,
    });
    assert.deepEqual([canvas.width, canvas.height], [0, 0], kind);
  }

  const highlights = document.createElement("canvas");
  renderTextHighlightCanvas({
    annotations: [],
    canvas: highlights,
    displaySize,
    viewport,
  });
  assert.deepEqual([highlights.width, highlights.height], [0, 0]);
});

test("an emptied layer is sized to the page again once it has something to draw", () => {
  const canvas = document.createElement("canvas");
  renderTextHighlightCanvas({
    annotations: [],
    canvas,
    displaySize,
    viewport,
  });
  renderTextHighlightCanvas({
    annotations: [highlight],
    canvas,
    displaySize,
    viewport,
  });
  assert.deepEqual([canvas.width, canvas.height], [600, 800]);

  renderTextHighlightCanvas({
    annotations: [],
    canvas,
    displaySize,
    draftHighlight: {
      color: [1, 1, 0],
      opacity: 0.4,
      rects: highlight.kind === "textHighlight" ? highlight.rects : [],
    },
    viewport,
  });
  assert.deepEqual([canvas.width, canvas.height], [600, 800]);
});
