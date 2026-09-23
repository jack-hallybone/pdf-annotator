// Masking the appearance overlay to the pixels an annotation changed, the
// read-only text-markup decorations pdf.js does not draw, and the raster
// fallback for when the pdf.js page view cannot be used.
import { AnnotationType } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";
import { rgbToCss } from "./annotationColors";
import {
  isManagedExistingAnnotation,
  isReadOnlyTextMarkupAnnotation,
  shouldRenderExistingAnnotationInAppearanceOverlay,
} from "./annotationDisplayPolicy";
import type { ExistingPdfAnnotation } from "./annotationImport";
import type { ViewportRect } from "./pagePointerGeometry";
import { pdfArrayRectToViewportRect } from "./pdfGeometry";
import {
  canvasLooksEmpty,
  releaseCanvasBuffer,
  safeCanvasPixelRatio,
} from "./pdfRender";
import type { PageViewport, PdfAnnotation, Tool } from "./types";
import { clamp } from "./viewerConfig";

export function keepOnlyChangedPixelsInAnnotationRects(
  appearance: ImageData,
  base: ImageData,
  existingAnnotations: ExistingPdfAnnotation[],
  pageAnnotations: PdfAnnotation[],
  pageIndex: number,
  viewport: PageViewport,
  scaleX: number,
  scaleY: number,
) {
  const appearanceData = appearance.data;
  const baseData = base.data;
  const threshold = 8;
  const sourceAlphaByPixel = new Uint8ClampedArray(appearanceData.length / 4);
  for (
    let index = 3, pixelIndex = 0;
    index < appearanceData.length;
    index += 4
  ) {
    sourceAlphaByPixel[pixelIndex] = appearanceData[index];
    appearanceData[index] = 0;
    pixelIndex += 1;
  }

  for (const annotation of existingAnnotations) {
    if (
      !shouldRenderExistingAnnotationInAppearanceOverlay(
        annotation,
        pageAnnotations,
        pageIndex,
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
      scaleY,
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

      appearanceData[index + 3] = difference > threshold ? sourceAlpha : 0;
    }
  }
}

function* annotationPixelIndexes(
  rect: ViewportRect,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
) {
  const padding = 12;
  const left = clamp(
    Math.floor((rect.x - padding) * scaleX),
    0,
    Math.max(0, width - 1),
  );
  const right = clamp(
    Math.ceil((rect.x + rect.width + padding) * scaleX),
    left,
    width,
  );
  const top = clamp(
    Math.floor((rect.y - padding) * scaleY),
    0,
    Math.max(0, height - 1),
  );
  const bottom = clamp(
    Math.ceil((rect.y + rect.height + padding) * scaleY),
    top,
    height,
  );

  for (let y = top; y < bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x < right; x += 1) {
      yield rowOffset + x;
    }
  }
}

export function clearManagedAnnotationRectsFromAppearanceOverlay(
  context: CanvasRenderingContext2D,
  existingAnnotations: ExistingPdfAnnotation[],
  pageAnnotations: PdfAnnotation[],
  pageIndex: number,
  viewport: PageViewport,
  scaleX: number,
  scaleY: number,
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
      Math.ceil((rect.height + padding * 2) * scaleY),
    );
  });
}

function existingAnnotationViewportRect(
  annotation: ExistingPdfAnnotation,
  viewport: PageViewport,
) {
  if (
    !Array.isArray(annotation.rect) &&
    !(annotation.rect instanceof Float32Array)
  ) {
    return null;
  }

  const rect = Array.from(annotation.rect).map(Number);
  if (rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) {
    return null;
  }

  return pdfArrayRectToViewportRect(rect.slice(0, 4), viewport);
}

export function drawReadOnlyTextDecorations(
  context: CanvasRenderingContext2D,
  annotations: ExistingPdfAnnotation[],
  viewport: PageViewport,
  scaleX: number,
  scaleY: number,
  scale: number,
) {
  context.save();
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  context.lineCap = "round";
  context.lineJoin = "round";

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
            rect.y + rect.height * 0.9,
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
            rect.y + rect.height * 0.55,
          );
          break;
      }
    }
  }

  context.restore();
}

function textMarkupViewportRects(
  annotation: ExistingPdfAnnotation,
  viewport: PageViewport,
) {
  const quadPoints = flatNumberArray(annotation.quadPoints);
  const rects: ViewportRect[] = [];

  for (let index = 0; index + 7 < quadPoints.length; index += 8) {
    const xs = [
      quadPoints[index],
      quadPoints[index + 2],
      quadPoints[index + 4],
      quadPoints[index + 6],
    ];
    const ys = [
      quadPoints[index + 1],
      quadPoints[index + 3],
      quadPoints[index + 5],
      quadPoints[index + 7],
    ];
    if (![...xs, ...ys].every(Number.isFinite)) {
      continue;
    }

    rects.push(
      pdfArrayRectToViewportRect(
        [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        viewport,
      ),
    );
  }

  const fallbackRect = existingAnnotationViewportRect(annotation, viewport);
  return rects.length > 0 ? rects : fallbackRect ? [fallbackRect] : [];
}

function strokeSquigglyRect(
  context: CanvasRenderingContext2D,
  rect: ViewportRect,
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
      baseline +
      (Math.floor((x - rect.x) / (wavelength / 2)) % 2 === 0
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
  y2: number,
) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function flatNumberArray(value: unknown) {
  if (!value || typeof value === "string") {
    return [];
  }

  if (
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !==
    "function"
  ) {
    return [];
  }

  return Array.from(value as Iterable<unknown>)
    .map(Number)
    .filter(Number.isFinite);
}

function existingAnnotationColor(
  annotation: ExistingPdfAnnotation,
): [number, number, number] {
  const color = annotation.color;
  if (!color || typeof color === "string") {
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
    clamp(channels[2] / divisor, 0, 1),
  ];
}

function existingAnnotationOpacity(annotation: ExistingPdfAnnotation) {
  const opacity = annotation.opacity ?? annotation.ca;
  return typeof opacity === "number" && Number.isFinite(opacity)
    ? clamp(opacity, 0, 1)
    : 1;
}

function existingAnnotationStrokeWidth(
  annotation: ExistingPdfAnnotation,
  scale: number,
) {
  const rawWidth =
    typeof annotation.borderStyle?.rawWidth === "number"
      ? annotation.borderStyle.rawWidth
      : typeof annotation.borderStyle?.width === "number"
        ? annotation.borderStyle.width
        : 1;
  return Math.max(1, rawWidth * scale);
}

export function clearCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

export function shouldUseRasterFallback(container: HTMLDivElement) {
  const canvas = container.querySelector<HTMLCanvasElement>(
    ".canvasWrapper canvas",
  );
  return !canvas || canvasLooksEmpty(canvas);
}

export async function renderRasterFallback(
  page: PDFPageProxy,
  viewport: PageViewport,
  container: HTMLDivElement,
  annotationMode: number,
  onRenderTask: (renderTask: ReturnType<PDFPageProxy["render"]>) => void,
) {
  const pdfPage =
    container.querySelector<HTMLDivElement>(".page") ??
    createFallbackPdfPage(container, viewport);
  pdfPage.style.width = `${viewport.width}px`;
  pdfPage.style.height = `${viewport.height}px`;

  const canvasWrapper =
    pdfPage.querySelector<HTMLDivElement>(".canvasWrapper") ??
    createFallbackCanvasWrapper(pdfPage);
  canvasWrapper.replaceChildren();

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const pixelRatio = safeCanvasPixelRatio(
    viewport.width,
    viewport.height,
    Math.max(2, window.devicePixelRatio || 1),
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
    viewport,
  });
  onRenderTask(renderTask);
  await renderTask.promise;
  return canvas;
}

function createFallbackPdfPage(
  container: HTMLDivElement,
  viewport: PageViewport,
) {
  const pdfPage = document.createElement("div");
  pdfPage.className = "page";
  pdfPage.setAttribute("data-page-number", String(viewport.viewBox[3] || 1));
  container.append(pdfPage);
  return pdfPage;
}

function createFallbackCanvasWrapper(pdfPage: HTMLDivElement) {
  const canvasWrapper = document.createElement("div");
  canvasWrapper.className = "canvasWrapper";
  pdfPage.prepend(canvasWrapper);
  return canvasWrapper;
}

export function isRenderCancellation(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "RenderingCancelledException" ||
      error.message.includes("cancelled"))
  );
}

export function disposeCanvases(container: Element) {
  for (const canvas of container.querySelectorAll("canvas")) {
    releaseCanvasBuffer(canvas);
  }
}

export function isAnnotationCreationTool(tool: Tool) {
  return (
    tool === "draw" ||
    tool === "highlight" ||
    tool === "textHighlight" ||
    tool === "freehandHighlight" ||
    tool === "freeText" ||
    tool === "stickyNote"
  );
}
