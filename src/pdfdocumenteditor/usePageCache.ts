import { useCallback, useRef } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import {
  EAGER_PAGE_LIMIT,
  LAZY_PAGE_BUFFER,
  MAX_LOADED_MAIN_PAGES,
} from "./viewerConfig";
import type { LoadedPage, VisiblePageRange } from "./types";

/**
 * pdf.js hands every caller of `getPage(n)` the same proxy, so `cleanup()`
 * releases the resources of every view showing that page: residency is
 * refcounted, not owned.
 */
type PageResidencyClaim = {
  release: () => void;
};

type PageCacheApi = {
  /**
   * A range, not an active page: a band around one index under-claims any
   * taller or zoomed-out pane, whose surplus pages another view then evicts
   * and blanks.
   */
  claimPageResidency: (
    visiblePageRange: () => VisiblePageRange,
  ) => PageResidencyClaim;
  markPageAccess: (pageIndex: number) => void;
  // Pure: callers apply the result inside their own setPages updater.
  evictOldLoadedPages: (
    candidatePages: LoadedPage[],
    protectedPageIndex: number,
  ) => LoadedPage[];
  scheduleLoadedPagesCleanup: (loadedPages: LoadedPage[]) => void;
  resetPageCache: () => void;
};

// The union of every attached viewport's claims is protected, not one view's
// range: the proxy underneath is shared, so evicting it takes the page away
// from every view at once.
export function usePageCache(): PageCacheApi {
  const pageAccessClockRef = useRef(0);
  const pageAccessOrderRef = useRef<Map<number, number>>(new Map());
  const claimsRef = useRef<Set<() => VisiblePageRange>>(new Set());

  const schedulePdfPageCleanup = useCallback(
    (page: PDFPageProxy, retries = 2) => {
      const cleanup = () => {
        try {
          page.cleanup();
        } catch {
          if (retries > 0) {
            window.setTimeout(
              () => schedulePdfPageCleanup(page, retries - 1),
              100,
            );
            return;
          }

          // Internal resource bookkeeping; nothing for the user to act on.
        }
      };

      if (window.requestIdleCallback) {
        window.requestIdleCallback(cleanup, { timeout: 1000 });
      } else {
        window.setTimeout(cleanup, 0);
      }
    },
    [],
  );

  const claimPageResidency = useCallback(
    (visiblePageRange: () => VisiblePageRange) => {
      claimsRef.current.add(visiblePageRange);
      return {
        release: () => {
          claimsRef.current.delete(visiblePageRange);
        },
      };
    },
    [],
  );

  const markPageAccess = useCallback((pageIndex: number) => {
    pageAccessClockRef.current += 1;
    pageAccessOrderRef.current.set(pageIndex, pageAccessClockRef.current);
  }, []);

  const evictOldLoadedPages = useCallback(
    (candidatePages: LoadedPage[], protectedPageIndex: number) => {
      if (candidatePages.length <= EAGER_PAGE_LIMIT) {
        return candidatePages;
      }

      const loaded = candidatePages
        .map((page, pageIndex) => ({ page, pageIndex }))
        .filter((item): item is { page: PDFPageProxy; pageIndex: number } =>
          Boolean(item.page),
        );
      if (loaded.length <= MAX_LOADED_MAIN_PAGES) {
        return candidatePages;
      }

      /* Every page any attached view displays, plus LAZY_PAGE_BUFFER either
       * side, and never a band around one index inside that range. */
      const lastPageIndex = candidatePages.length - 1;
      const protectedIndexes = new Set<number>([protectedPageIndex]);
      for (const visiblePageRange of claimsRef.current) {
        const visible = visiblePageRange();
        const start = Math.max(
          0,
          Math.min(visible.start, visible.end) - LAZY_PAGE_BUFFER,
        );
        const end = Math.min(
          lastPageIndex,
          Math.max(visible.start, visible.end) + LAZY_PAGE_BUFFER,
        );
        for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
          protectedIndexes.add(pageIndex);
        }
      }

      let next = candidatePages;
      let loadedCount = loaded.length;
      const evictionCandidates = loaded
        .filter(({ pageIndex }) => !protectedIndexes.has(pageIndex))
        .sort(
          (a, b) =>
            (pageAccessOrderRef.current.get(a.pageIndex) ?? 0) -
            (pageAccessOrderRef.current.get(b.pageIndex) ?? 0),
        );

      for (const { page, pageIndex } of evictionCandidates) {
        if (loadedCount <= MAX_LOADED_MAIN_PAGES) {
          break;
        }

        if (next === candidatePages) {
          next = [...candidatePages];
        }
        next[pageIndex] = null;
        loadedCount -= 1;
        pageAccessOrderRef.current.delete(pageIndex);
        schedulePdfPageCleanup(page);
      }

      return next;
    },
    [schedulePdfPageCleanup],
  );

  const scheduleLoadedPagesCleanup = useCallback(
    (loadedPages: LoadedPage[]) => {
      const pagesToClean = new Set(
        loadedPages.filter((page): page is PDFPageProxy => Boolean(page)),
      );
      for (const page of pagesToClean) {
        schedulePdfPageCleanup(page);
      }
    },
    [schedulePdfPageCleanup],
  );

  const resetPageCache = useCallback(() => {
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
  }, []);

  return {
    claimPageResidency,
    markPageAccess,
    evictOldLoadedPages,
    scheduleLoadedPagesCleanup,
    resetPageCache,
  };
}
