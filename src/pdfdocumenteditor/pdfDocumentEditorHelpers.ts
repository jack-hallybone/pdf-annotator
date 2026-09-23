import type { PDFDocumentProxy } from "pdfjs-dist";
import { uint8ArrayToArrayBuffer } from "../bytes";
import { safePdfFileName } from "../fileNames";
import { annotationBounds } from "./annotationGeometry";
import { annotationFingerprint } from "./annotationState";
import { PdfSaveError } from "./host";
import { viewportPointToPdfPoint } from "./pdfGeometry";
import { PdfProtectionSanitizationError } from "./pdfPageOperations";
import {
  PdfAnnotationIntegrityError,
  UnsupportedAnnotationTextError,
} from "./pdfWriter";
import type {
  PageRenderPriority,
  PageViewport,
  PdfAnnotation,
  Tool,
  VisiblePageRange,
} from "./types";
import { LAZY_PAGE_BUFFER, MAX_BAND_LOAD_PAGES } from "./viewerConfig";

export function downloadPdf(bytes: Uint8Array, name: string) {
  const blob = new Blob([uint8ArrayToArrayBuffer(bytes)], {
    type: "application/pdf",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safePdfFileName(name);
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function destinationTargetToPageIndex(
  pdfDoc: PDFDocumentProxy,
  target: unknown,
) {
  if (typeof target === "number" && Number.isInteger(target)) {
    return target;
  }

  try {
    return await pdfDoc.getPageIndex(
      target as Parameters<PDFDocumentProxy["getPageIndex"]>[0],
    );
  } catch {
    return null;
  }
}

export function annotatedName(name: string) {
  return name.replace(/\.pdf$/i, "") + "-annotated.pdf";
}

export function copyName(name: string) {
  return name.replace(/\.pdf$/i, "") + " - copy.pdf";
}

export function printableName(name: string) {
  return name.replace(/\.pdf$/i, "") + "-print.pdf";
}

/* A content stream this build cannot read leaves it unsettled which page a
 * description belongs to, and both silent outcomes lose or leak text. */
export const UNPROVEN_PAGE_DELETE_NOTICE =
  "Part of this PDF could not be read. Descriptions of the deleted page may " +
  "remain in the file, and descriptions of pages you kept may have gone.";

export function preparationErrorNotice(error: unknown, fallback: string) {
  if (
    error instanceof UnsupportedAnnotationTextError ||
    error instanceof PdfAnnotationIntegrityError ||
    error instanceof PdfProtectionSanitizationError ||
    error instanceof PdfSaveError
  ) {
    return error.message;
  }
  return fallback;
}

// The save path's own errors are user-facing sentences and shown as-is;
// anything else falls back rather than leak a stack-shaped string.
export function inPlaceSaveFailureNotice(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : "";
  const safeMessage =
    message.length > 0 && message.length <= 200
      ? message
      : "Could not save to the original file.";
  return error instanceof PdfSaveError && error.mayHaveCommitted
    ? `${safeMessage} The original file may have changed and could not be verified.`
    : safeMessage;
}

export function originalFileStateAfterSaveFailure(error: unknown) {
  return error instanceof PdfSaveError && !error.mayHaveCommitted
    ? "The original file was left unchanged."
    : "The original file may have changed and should be checked before continuing.";
}

export function writableAnnotations(
  annotations: PdfAnnotation[],
  cleanAnnotations: PdfAnnotation[],
) {
  const cleanFingerprints = new Map(
    cleanAnnotations.map((annotation) => [
      annotation.id,
      annotationFingerprint(annotation),
    ]),
  );

  return annotations.filter((annotation) => {
    if (!annotation.sourceId) {
      return true;
    }

    return (
      cleanFingerprints.get(annotation.id) !== annotationFingerprint(annotation)
    );
  });
}

export function isZoomShortcut(event: KeyboardEvent) {
  return isZoomInShortcut(event) || isZoomOutShortcut(event);
}

export function isZoomInShortcut(event: KeyboardEvent) {
  return event.key === "+" || event.key === "=";
}

function isZoomOutShortcut(event: KeyboardEvent) {
  return event.key === "-" || event.key === "_";
}

export function usesAnnotationLayer(tool: Tool) {
  return tool !== "select";
}

export function isTextEntryTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
      ),
    )
  );
}

function bandEdges(visiblePageRange: VisiblePageRange) {
  return {
    first: Math.min(visiblePageRange.start, visiblePageRange.end),
    last: Math.max(visiblePageRange.start, visiblePageRange.end),
  };
}

/**
 * Ranked against the pages this view is displaying, never a scalar active
 * index: a band around one index ranks most of a zoomed-out viewport as idle
 * work, and those pages stay blank.
 */
export function pageRenderPriority(
  pageIndex: number,
  visiblePageRange: VisiblePageRange,
): PageRenderPriority {
  const { first, last } = bandEdges(visiblePageRange);
  if (pageIndex >= first && pageIndex <= last) {
    return "visible";
  }

  const distance = pageIndex < first ? first - pageIndex : pageIndex - last;
  return distance <= LAZY_PAGE_BUFFER ? "near" : "idle";
}

/**
 * Residency, loading and render ranking all read `visiblePageRangeRef`;
 * deriving any of them from the active page leaves displayed pages blank.
 */
export function visibleLoadPageIndexes(
  visiblePageRange: VisiblePageRange,
  pageCount: number,
  cap: number = MAX_BAND_LOAD_PAGES,
): number[] {
  const lastPageIndex = pageCount - 1;
  if (lastPageIndex < 0 || cap < 1) {
    return [];
  }

  const { first, last } = bandEdges(visiblePageRange);
  const start = Math.max(0, Math.min(first, lastPageIndex) - LAZY_PAGE_BUFFER);
  const end = Math.min(lastPageIndex, Math.max(last, 0) + LAZY_PAGE_BUFFER);
  const centre = Math.min(Math.max(Math.round((first + last) / 2), start), end);

  const indexes = [centre];
  for (
    let offset = 1;
    indexes.length < cap &&
    (centre - offset >= start || centre + offset <= end);
    offset += 1
  ) {
    if (centre - offset >= start && indexes.length < cap) {
      indexes.push(centre - offset);
    }
    if (centre + offset <= end && indexes.length < cap) {
      indexes.push(centre + offset);
    }
  }

  return indexes;
}

/**
 * The same band as `visibleLoadPageIndexes`, plus the active page, whose proxy
 * a reload's caller needs in hand.
 */
export function initialReloadPageIndexes(
  pageCount: number,
  activePageIndex: number,
  visiblePageRange: VisiblePageRange | null,
) {
  if (pageCount < 1) {
    return [];
  }

  const active = Math.min(Math.max(activePageIndex, 0), pageCount - 1);
  const range = visiblePageRange ?? { end: active, start: active };
  const clamped = {
    end: Math.min(Math.max(range.end, 0), Math.max(pageCount - 1, 0)),
    start: Math.min(Math.max(range.start, 0), Math.max(pageCount - 1, 0)),
  };
  const indexes = visibleLoadPageIndexes(clamped, pageCount);
  return indexes.includes(active) ? indexes : [active, ...indexes];
}

export function scheduleAfterVisiblePaint(callback: () => void) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (window.requestIdleCallback) {
        window.requestIdleCallback(callback, { timeout: 600 });
      } else {
        window.setTimeout(callback, 100);
      }
    });
  });
}

export function pageIndexFromElement(element: Element | null) {
  const pageSlot = element?.closest<HTMLElement>("[data-page-index]");
  if (!pageSlot) {
    return null;
  }

  const pageIndex = Number(pageSlot.dataset.pageIndex);
  return Number.isInteger(pageIndex) ? pageIndex : null;
}

export function pagePdfBounds(viewport: PageViewport) {
  const topLeft = viewportPointToPdfPoint(0, 0, viewport);
  const bottomRight = viewportPointToPdfPoint(
    viewport.width,
    viewport.height,
    viewport,
  );

  return {
    x1: Math.min(topLeft.x, bottomRight.x),
    y1: Math.min(topLeft.y, bottomRight.y),
    x2: Math.max(topLeft.x, bottomRight.x),
    y2: Math.max(topLeft.y, bottomRight.y),
  };
}

export function annotationIntersectsPage(
  annotation: PdfAnnotation,
  pageBounds: ReturnType<typeof pagePdfBounds>,
) {
  const bounds = annotationBounds(annotation);
  return (
    Number.isFinite(bounds.x1) &&
    Number.isFinite(bounds.y1) &&
    Number.isFinite(bounds.x2) &&
    Number.isFinite(bounds.y2) &&
    bounds.x2 > pageBounds.x1 &&
    bounds.x1 < pageBounds.x2 &&
    bounds.y2 > pageBounds.y1 &&
    bounds.y1 < pageBounds.y2
  );
}

export function measureScrollbarGutter(container: HTMLElement) {
  const hasHorizontalScrollbar = container.scrollWidth > container.clientWidth;

  return {
    block: hasHorizontalScrollbar
      ? Math.max(0, container.offsetHeight - container.clientHeight)
      : 0,
    // `.pdfdocumenteditor-scroll-root` reserves this via `scrollbar-gutter: stable` whether
    // or not content overflows, so it is read unconditionally.
    inline: Math.max(0, container.offsetWidth - container.clientWidth),
  };
}
