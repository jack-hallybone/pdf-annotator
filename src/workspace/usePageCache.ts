import { useCallback, useRef, type RefObject } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
  EAGER_PAGE_LIMIT,
  LAZY_PAGE_BUFFER,
  MAX_LOADED_MAIN_PAGES
} from './viewerConfig';
import type { LoadedPage } from './types';

export type PageCacheApi = {
  // Records that a page was just used, for LRU eviction ordering.
  markPageAccess: (pageIndex: number) => void;
  // Given the current page array, returns it with the least-recently-used
  // loaded pages beyond the retention limit dropped to null (and their
  // PDF.js resources scheduled for cleanup). Pure w.r.t. the array - callers
  // apply the result inside their own setPages updater.
  evictOldLoadedPages: (
    candidatePages: LoadedPage[],
    protectedPageIndex: number
  ) => LoadedPage[];
  // Schedules PDF.js resource cleanup for every loaded page (used on teardown).
  scheduleLoadedPagesCleanup: (loadedPages: LoadedPage[]) => void;
  // Clears the access-order bookkeeping when a new document loads.
  resetPageCache: () => void;
};

// Owns the loaded-page LRU: which main-view pages stay resident and which get
// evicted and have their PDF.js page resources released. The active page and a
// small buffer around it are always protected. Kept separate from the load
// pipeline - callers still own `setPages` and decide when to load - so this is
// pure bookkeeping over an access clock, testable in isolation.
export function usePageCache(
  activePageIndexRef: RefObject<number>
): PageCacheApi {
  const pageAccessClockRef = useRef(0);
  const pageAccessOrderRef = useRef<Map<number, number>>(new Map());

  const schedulePdfPageCleanup = useCallback(
    (page: PDFPageProxy, retries = 2) => {
      const cleanup = () => {
        try {
          page.cleanup();
        } catch {
          if (retries > 0) {
            window.setTimeout(
              () => schedulePdfPageCleanup(page, retries - 1),
              100
            );
            return;
          }

          // Internal resource bookkeeping only - nothing for the user to act on.
        }
      };

      if (window.requestIdleCallback) {
        window.requestIdleCallback(cleanup, { timeout: 1000 });
      } else {
        window.setTimeout(cleanup, 0);
      }
    },
    []
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
        .filter(
          (item): item is { page: PDFPageProxy; pageIndex: number } =>
            Boolean(item.page)
        );
      if (loaded.length <= MAX_LOADED_MAIN_PAGES) {
        return candidatePages;
      }

      const currentActivePageIndex = activePageIndexRef.current;
      const protectedIndexes = new Set<number>([
        protectedPageIndex,
        currentActivePageIndex
      ]);
      const start = Math.max(0, currentActivePageIndex - LAZY_PAGE_BUFFER);
      const end = Math.min(
        candidatePages.length - 1,
        currentActivePageIndex + LAZY_PAGE_BUFFER
      );
      for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
        protectedIndexes.add(pageIndex);
      }

      let next = candidatePages;
      let loadedCount = loaded.length;
      const evictionCandidates = loaded
        .filter(({ pageIndex }) => !protectedIndexes.has(pageIndex))
        .sort(
          (a, b) =>
            (pageAccessOrderRef.current.get(a.pageIndex) ?? 0) -
            (pageAccessOrderRef.current.get(b.pageIndex) ?? 0)
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
    [activePageIndexRef, schedulePdfPageCleanup]
  );

  const scheduleLoadedPagesCleanup = useCallback(
    (loadedPages: LoadedPage[]) => {
      const pagesToClean = new Set(
        loadedPages.filter((page): page is PDFPageProxy => Boolean(page))
      );
      for (const page of pagesToClean) {
        schedulePdfPageCleanup(page);
      }
    },
    [schedulePdfPageCleanup]
  );

  const resetPageCache = useCallback(() => {
    pageAccessClockRef.current = 0;
    pageAccessOrderRef.current.clear();
  }, []);

  return {
    markPageAccess,
    evictOldLoadedPages,
    scheduleLoadedPagesCleanup,
    resetPageCache
  };
}
