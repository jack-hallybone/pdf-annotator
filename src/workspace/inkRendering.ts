// Canvas rendering for ink annotations (freehand draw + highlighter),
// extracted from PdfPageView. These functions draw PdfAnnotation ink strokes
// onto 2D canvases, size those canvases for the device pixel ratio, and
// erase strokes via destination-out compositing. They are the counterpart to
// the SVG-based rendering of other annotation kinds - ink is canvas-backed
// because a page can hold thousands of stroke points. Nothing here touches
// React; callers pass in the target canvas and viewport.
import { rgbToCss } from './annotationColors';
import { inkPathCommands } from './annotationGeometry';
import { safeCanvasPixelRatio } from './pdfRender';
import { clamp } from './viewerConfig';
import type {
  PageDisplaySize,
  PageViewport,
  PdfAnnotation,
  PdfPoint,
  PdfRect
} from './types';

export function clearDisplayCanvas(canvas: HTMLCanvasElement | null) {
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

export function renderInkCanvasLayer({
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

// Text highlights are painted here rather than as SVG rects for the same
// reason ink is canvas-backed, plus one more: the CSS Compositing spec forces
// isolation on every outermost <svg>, so a mix-blend-mode on a shape inside an
// SVG can never blend with page content outside that SVG - only an actual
// canvas element (blended via CSS on the element itself) can multiply against
// the real page raster underneath.
export function renderTextHighlightCanvas({
  annotations,
  canvas,
  displaySize,
  draftHighlight,
  viewport
}: {
  annotations: PdfAnnotation[];
  canvas: HTMLCanvasElement | null;
  displaySize: PageDisplaySize;
  draftHighlight?: {
    color: [number, number, number];
    opacity: number;
    rects: PdfRect[];
  };
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
    if (annotation.kind !== 'textHighlight') {
      continue;
    }

    context.fillStyle = rgbToCss(annotation.color);
    context.globalAlpha = clamp(annotation.opacity, 0, 1);
    for (const rect of annotation.rects) {
      fillHighlightRect(context, rect, viewport);
    }
  }

  if (draftHighlight) {
    context.fillStyle = rgbToCss(draftHighlight.color);
    context.globalAlpha = clamp(draftHighlight.opacity, 0, 1);
    for (const rect of draftHighlight.rects) {
      fillHighlightRect(context, rect, viewport);
    }
  }

  context.globalAlpha = 1;
}

function fillHighlightRect(
  context: CanvasRenderingContext2D,
  rect: PdfRect,
  viewport: PageViewport
) {
  const [x1, y1] = viewport.convertToViewportPoint(rect.x1, rect.y1);
  const [x2, y2] = viewport.convertToViewportPoint(rect.x2, rect.y2);
  context.fillRect(
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.abs(x2 - x1),
    Math.abs(y2 - y1)
  );
}

export function drawInkCanvasAnnotation({
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

export function renderPdfPathCanvas({
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

export function eraseInkCanvasPaths({
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

export function prepareInkCanvasContextState({
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

export function inkCanvasPixelRatio(displaySize: PageDisplaySize) {
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

export function drawInkCanvasPath(
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
