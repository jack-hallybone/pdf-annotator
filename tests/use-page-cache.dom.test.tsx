import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { usePageCache } from '../src/workspace/usePageCache';
import type { LoadedPage } from '../src/workspace/types';

// EAGER_PAGE_LIMIT = 25, MAX_LOADED_MAIN_PAGES = 100, LAZY_PAGE_BUFFER = 2.
// Eviction only kicks in past both the array-length and loaded-count limits.

function fakePage(): LoadedPage {
  // Only cleanup() is exercised by the cache; cast through unknown for the rest.
  return { cleanup() {} } as unknown as LoadedPage;
}

function allLoaded(count: number): LoadedPage[] {
  return Array.from({ length: count }, fakePage);
}

function useCacheHarness(activePageIndex: number) {
  const activePageIndexRef = useRef(activePageIndex);
  return usePageCache(activePageIndexRef);
}

const loadedCount = (pages: LoadedPage[]) =>
  pages.filter(Boolean).length;

test('does not evict when under the eager page limit', () => {
  const { result } = renderHook(() => useCacheHarness(0));
  const pages = allLoaded(10);
  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(next, pages); // same reference, untouched
});

test('does not evict when loaded count is within the retention limit', () => {
  const { result } = renderHook(() => useCacheHarness(0));
  // 90 pages: over the array length limit but under MAX_LOADED_MAIN_PAGES.
  const pages = allLoaded(90);
  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(loadedCount(next), 90);
});

test('evicts down to the retention limit once exceeded', () => {
  const { result } = renderHook(() => useCacheHarness(0));
  const pages = allLoaded(130);
  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(loadedCount(next), 100);
});

test('never evicts the active page or its surrounding buffer', () => {
  const active = 60;
  const { result } = renderHook(() => useCacheHarness(active));
  const pages = allLoaded(130);
  const next = result.current.evictOldLoadedPages(pages, active);

  // active +/- LAZY_PAGE_BUFFER (2) stay resident.
  for (let index = active - 2; index <= active + 2; index += 1) {
    assert.ok(next[index], `page ${index} should be protected`);
  }
});

test('evicts least-recently-accessed pages first', () => {
  const { result } = renderHook(() => useCacheHarness(0));
  const pages = allLoaded(130);

  // Touch the mid-range pages so they rank as most-recently used; the
  // never-touched low pages should be the ones dropped.
  act(() => {
    for (let index = 40; index < 130; index += 1) {
      result.current.markPageAccess(index);
    }
  });

  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(loadedCount(next), 100);
  // A recently-accessed page survives; an untouched low page is gone.
  assert.ok(next[45], 'recently accessed page should be retained');
  assert.equal(next[10], null, 'stale page should be evicted');
});

test('resetPageCache clears access ordering', () => {
  const { result } = renderHook(() => useCacheHarness(0));
  // Mark then reset; with no ordering, eviction falls back to index order.
  act(() => {
    for (let index = 40; index < 130; index += 1) {
      result.current.markPageAccess(index);
    }
    result.current.resetPageCache();
  });

  const next = result.current.evictOldLoadedPages(allLoaded(130), 0);
  // With ordering cleared, the lowest non-protected indices are evicted again.
  assert.equal(next[3], null);
  assert.ok(next[45]);
});
