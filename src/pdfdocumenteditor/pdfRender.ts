/*
 * Every PDF.js value in this app comes from `pdfjs-dist/legacy/...`, never the
 * package root or `pdfjs-dist/build|web/...`; eslint.config.js enforces it.
 */
import {
  AnnotationMode,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import { pdfWorkerUrl, pdfjsAssetBase } from "../pdfRuntime";
import { clamp } from "./viewerConfig";

// Whatever calls getDocument must import this module, or pdf.js looks for its
// worker in the wrong place and every page comes up blank.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const pdfjsAssetBaseUrl = pdfjsAssetBase();

export const PDFJS_DOCUMENT_OPTIONS = {
  cMapPacked: true,
  cMapUrl: `${pdfjsAssetBaseUrl}cmaps/`,
  enableXfa: false,
  iccUrl: `${pdfjsAssetBaseUrl}iccs/`,
  isImageDecoderSupported: false,
  // Inert on PDF.js 6, but kept as a no-cost opt-out should an eval path
  // return under this name.
  isEvalSupported: false,
  standardFontDataUrl: `${pdfjsAssetBaseUrl}standard_fonts/`,
  useWasm: true,
  useWorkerFetch: true,
  wasmUrl: `${pdfjsAssetBaseUrl}wasm/`,
};

export const PDF_TO_CSS_UNITS = 96 / 72;
export const PDFJS_TEXT_LAYER_ENABLE = 1;
export const PDFJS_MAX_CANVAS_PIXELS = 16_777_216;
type PdfBaseRenderMode = "normal" | "annotationAppearance";

const EMPTY_CANVAS_SAMPLE_SIZE = 32;
const pageBaseRenderModeCache = new WeakMap<PDFPageProxy, PdfBaseRenderMode>();
let emptyCanvasSampleContext: CanvasRenderingContext2D | null | undefined;

export function cachedPageBaseRenderMode(page: PDFPageProxy) {
  return pageBaseRenderModeCache.get(page) ?? null;
}

export function cachePageBaseRenderMode(
  page: PDFPageProxy,
  mode: PdfBaseRenderMode,
) {
  pageBaseRenderModeCache.set(page, mode);
}

export function safeCanvasPixelRatio(
  cssWidth: number,
  cssHeight: number,
  preferredRatio: number,
) {
  const cssPixels = Math.max(cssWidth * cssHeight, 1);
  const maxRatio = Math.sqrt(PDFJS_MAX_CANVAS_PIXELS / cssPixels);
  return clamp(Math.min(preferredRatio, maxRatio), 0.25, preferredRatio);
}

export function releaseCanvasBuffer(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

export function canvasLooksEmpty(canvas: HTMLCanvasElement) {
  if (canvas.width === 0 || canvas.height === 0) {
    return true;
  }

  const context = emptyCanvasContext();
  if (!context) {
    return false;
  }

  try {
    const size = EMPTY_CANVAS_SAMPLE_SIZE;
    context.clearRect(0, 0, size, size);
    context.drawImage(canvas, 0, 0, size, size);
    const pixels = context.getImageData(0, 0, size, size).data;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3];
      if (
        alpha > 16 &&
        (pixels[index] < 245 ||
          pixels[index + 1] < 245 ||
          pixels[index + 2] < 245)
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

export async function pageHasRenderableContent(page: PDFPageProxy) {
  try {
    const operatorList = await page.getOperatorList({
      annotationMode: AnnotationMode.DISABLE,
    });
    return (
      Array.isArray(operatorList?.fnArray) && operatorList.fnArray.length > 0
    );
  } catch {
    return true;
  }
}

function emptyCanvasContext() {
  if (emptyCanvasSampleContext !== undefined) {
    return emptyCanvasSampleContext;
  }

  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = EMPTY_CANVAS_SAMPLE_SIZE;
  sampleCanvas.height = EMPTY_CANVAS_SAMPLE_SIZE;
  emptyCanvasSampleContext = sampleCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  return emptyCanvasSampleContext;
}
