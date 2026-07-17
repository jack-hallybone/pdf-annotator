import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react';
import { ACTUAL_SIZE_ZOOM, MAX_ZOOM, MIN_ZOOM, clamp } from './viewerConfig';
import {
  pageElementForIndex,
  pageTopInContainer,
  scrollContainerPaddingTop
} from './scrollGeometry';
import type { LoadedPage, PageSize } from './types';

function clampZoom(value: number) {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}

type WorkspaceZoomParams = {
  scrollContainerRef: RefObject<HTMLElement | null>;
  pagesRef: RefObject<LoadedPage[]>;
  pages: LoadedPage[];
  pageSize: PageSize | null;
  activePageIndex: number;
};

export type WorkspaceZoomApi = {
  scale: number;
  // Sets the scale directly, without capturing/restoring a scroll anchor.
  // Used by session restore and document reset, which manage scroll separately.
  setScale: (nextScale: number) => void;
  updateZoom: (delta: number) => void;
  resetZoom: () => void;
  setZoom: (nextScale: number) => void;
  fitZoomToPageWidth: () => void;
  fitZoomToPageHeight: () => void;
};

// Owns the page zoom scale plus the scroll-anchoring that keeps the active
// page visually stable across a zoom change: on zoom, captureZoomAnchor records
// where the active page sits in the viewport, then a layout effect re-scrolls
// to that same relative position once the new scale has laid out. `setScale` is
// exposed separately for callers (restore/reset) that set scale without
// anchoring.
export function useWorkspaceZoom({
  scrollContainerRef,
  pagesRef,
  pages,
  pageSize,
  activePageIndex
}: WorkspaceZoomParams): WorkspaceZoomApi {
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
      pageIndex: activePageIndex
    };
  }, [scrollContainerRef, pages.length, activePageIndex]);

  const updateZoom = useCallback(
    (delta: number) => {
      captureZoomAnchor();
      setScale((value) => clampZoom(value + delta));
    },
    [captureZoomAnchor]
  );

  const setZoom = useCallback(
    (nextScale: number) => {
      captureZoomAnchor();
      setScale(clampZoom(nextScale));
    },
    [captureZoomAnchor]
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

    const availableWidth = container.clientWidth - 32;
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
      behavior: 'auto'
    });
  }, [pages.length, scale, scrollContainerRef]);

  return {
    scale,
    setScale,
    updateZoom,
    resetZoom,
    setZoom,
    fitZoomToPageWidth,
    fitZoomToPageHeight
  };
}
