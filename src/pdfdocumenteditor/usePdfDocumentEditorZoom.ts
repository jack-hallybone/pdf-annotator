import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ACTUAL_SIZE_ZOOM, clampZoom } from "./viewerConfig";
import {
  pageElementForIndex,
  pageTopInContainer,
  scrollContainerPaddingTop,
} from "./scrollGeometry";
import type { LoadedPage, PageSize } from "./types";

type PdfDocumentEditorZoomParams = {
  scrollContainerRef: RefObject<HTMLElement | null>;
  pagesRef: RefObject<LoadedPage[]>;
  pages: LoadedPage[];
  pageSize: PageSize | null;
  activePageIndex: number;
};

type PdfDocumentEditorZoomApi = {
  scale: number;
  // No scroll anchor: session restore and document reset manage scroll
  // themselves.
  setScale: (nextScale: number) => void;
  updateZoom: (delta: number) => void;
  resetZoom: () => void;
  setZoom: (nextScale: number) => void;
  fitZoomToPageWidth: () => void;
  fitZoomToPageHeight: () => void;
};

// The zoom scale, plus the anchoring that keeps the active page visually
// stable across a zoom change: the anchor is captured on zoom and re-applied
// by a layout effect once the new scale has laid out.
export function usePdfDocumentEditorZoom({
  scrollContainerRef,
  pagesRef,
  pages,
  pageSize,
  activePageIndex,
}: PdfDocumentEditorZoomParams): PdfDocumentEditorZoomApi {
  const [scale, setScale] = useState(ACTUAL_SIZE_ZOOM);
  const pendingZoomAnchorRef = useRef<{
    offsetRatio: number;
    pageIndex: number;
  } | null>(null);

  const captureZoomAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || pages.length === 0) {
      return;
    }

    const anchorPage = pageElementForIndex(container, activePageIndex);
    if (!anchorPage) {
      return;
    }

    const pageTop = pageTopInContainer(container, anchorPage);
    pendingZoomAnchorRef.current = {
      offsetRatio:
        (container.scrollTop + scrollContainerPaddingTop(container) - pageTop) /
        Math.max(1, anchorPage.offsetHeight),
      pageIndex: activePageIndex,
    };
  }, [scrollContainerRef, pages.length, activePageIndex]);

  const updateZoom = useCallback(
    (delta: number) => {
      captureZoomAnchor();
      setScale((value) => clampZoom(value + delta));
    },
    [captureZoomAnchor],
  );

  const setZoom = useCallback(
    (nextScale: number) => {
      captureZoomAnchor();
      setScale(clampZoom(nextScale));
    },
    [captureZoomAnchor],
  );

  const resetZoom = useCallback(() => {
    setZoom(ACTUAL_SIZE_ZOOM);
  }, [setZoom]);

  const activePageBaseSize = useCallback(() => {
    const activePage = pagesRef.current[activePageIndex];
    if (activePage) {
      const viewport = activePage.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    }

    return pageSize;
  }, [pagesRef, activePageIndex, pageSize]);

  const fitZoomToPageWidth = useCallback(() => {
    const container = scrollContainerRef.current;
    const page = activePageBaseSize();
    if (!container || !page) {
      return;
    }

    // Read the real padding rather than a flat guess, so a page fit to width
    // never renders wider than the box the dock's clearance keeps clear of.
    const style = getComputedStyle(container);
    const horizontalPadding =
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const availableWidth = container.clientWidth - horizontalPadding;
    setZoom(Math.max(120, availableWidth) / page.width);
  }, [scrollContainerRef, activePageBaseSize, setZoom]);

  const fitZoomToPageHeight = useCallback(() => {
    const container = scrollContainerRef.current;
    const page = activePageBaseSize();
    if (!container || !page) {
      return;
    }

    setZoom(Math.max(160, container.clientHeight - 40) / page.height);
  }, [scrollContainerRef, activePageBaseSize, setZoom]);

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container) {
      return;
    }

    const anchorPage = pageElementForIndex(container, anchor.pageIndex);
    if (!anchorPage) {
      return;
    }

    pendingZoomAnchorRef.current = null;
    const pageTop = pageTopInContainer(container, anchorPage);
    container.scrollTo({
      top:
        pageTop +
        anchor.offsetRatio * anchorPage.offsetHeight -
        scrollContainerPaddingTop(container),
      behavior: "auto",
    });
  }, [pages.length, scale, scrollContainerRef]);

  return {
    scale,
    setScale,
    updateZoom,
    resetZoom,
    setZoom,
    fitZoomToPageWidth,
    fitZoomToPageHeight,
  };
}
