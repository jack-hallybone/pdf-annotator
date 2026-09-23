import assert from "node:assert/strict";
import { test } from "node:test";
import { act, renderHook } from "@testing-library/react";
import { usePageCache } from "../src/pdfdocumenteditor/usePageCache";
import type { LoadedPage } from "../src/pdfdocumenteditor/types";

// With EAGER_PAGE_LIMIT = 25, MAX_LOADED_MAIN_PAGES = 100 and LAZY_PAGE_BUFFER =
// 2, eviction only kicks in past both the array-length and loaded-count limits.

function fakePage(): LoadedPage {
  // Only cleanup() is exercised by the cache; cast through unknown for the rest.
  return { cleanup() {} } as unknown as LoadedPage;
}

function allLoaded(count: number): LoadedPage[] {
  return Array.from({ length: count }, fakePage);
}

// One viewport's hold on the cache, as the document model registers it: a range
// per view rather than an index, because a claim that could only ever describe
// five pages said nothing about the sixth a taller pane was showing.
function useCacheHarness(...visiblePageRanges: Array<[number, number]>) {
  const cache = usePageCache();
  for (const [start, end] of visiblePageRanges) {
    cache.claimPageResidency(() => ({ end, start }));
  }
  return cache;
}

function onePage(pageIndex: number): [number, number] {
  return [pageIndex, pageIndex];
}

const loadedCount = (pages: LoadedPage[]) => pages.filter(Boolean).length;

test("does not evict when under the eager page limit", () => {
  const { result } = renderHook(() => useCacheHarness(onePage(0)));
  const pages = allLoaded(10);
  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(next, pages); // same reference, untouched
});

test("does not evict when loaded count is within the retention limit", () => {
  const { result } = renderHook(() => useCacheHarness(onePage(0)));
  // 90 pages: over the array length limit but under MAX_LOADED_MAIN_PAGES.
  const pages = allLoaded(90);
  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(loadedCount(next), 90);
});

test("evicts down to the retention limit once exceeded", () => {
  const { result } = renderHook(() => useCacheHarness(onePage(0)));
  const pages = allLoaded(130);
  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(loadedCount(next), 100);
});

test("never evicts the active page or its surrounding buffer", () => {
  const active = 60;
  const { result } = renderHook(() => useCacheHarness(onePage(active)));
  const pages = allLoaded(130);
  const next = result.current.evictOldLoadedPages(pages, active);

  // active +/- LAZY_PAGE_BUFFER (2) stay resident.
  for (let index = active - 2; index <= active + 2; index += 1) {
    assert.ok(next[index], `page ${index} should be protected`);
  }
});

test("evicts least-recently-accessed pages first", () => {
  const { result } = renderHook(() => useCacheHarness(onePage(0)));
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
  assert.ok(next[45], "recently accessed page should be retained");
  assert.equal(next[10], null, "stale page should be evicted");
});

test("resetPageCache clears access ordering", () => {
  const { result } = renderHook(() => useCacheHarness(onePage(0)));
  act(() => {
    for (let index = 40; index < 130; index += 1) {
      result.current.markPageAccess(index);
    }
    result.current.resetPageCache();
  });

  const next = result.current.evictOldLoadedPages(allLoaded(130), 0);
  assert.equal(next[3], null);
  assert.ok(next[45]);
});

// The defect these four exist for: a proxy belongs to the document, so a second
// viewport scrolled elsewhere lost the page it was displaying the moment the
// first one's eviction ran.
test("a second viewport's page is protected from the first one's eviction", () => {
  const { result } = renderHook(() => useCacheHarness(onePage(0), onePage(90)));
  const pages = allLoaded(130);

  act(() => {
    result.current.markPageAccess(90);
    for (let index = 0; index < 130; index += 1) {
      if (index !== 90) {
        result.current.markPageAccess(index);
      }
    }
  });

  const next = result.current.evictOldLoadedPages(pages, 0);
  assert.equal(loadedCount(next), 100);
  for (let index = 88; index <= 92; index += 1) {
    assert.ok(
      next[index],
      `page ${index} is inside the second viewport's band and was evicted`,
    );
  }
});

// The half a one-page-per-view test cannot see: a view's claim covers what that
// view displays, and protection built from an active page and LAZY_PAGE_BUFFER
// either side describes five pages while a tall pane shows a dozen.
test("a viewport displaying a dozen pages keeps every one of them", () => {
  const { result } = renderHook(() =>
    useCacheHarness(onePage(0), [40, 51] as [number, number]),
  );

  // Make view B's pages the least recently used in the document, so only the claim
  // stands between them and eviction.
  act(() => {
    for (let index = 40; index <= 51; index += 1) {
      result.current.markPageAccess(index);
    }
    for (let index = 0; index < 130; index += 1) {
      if (index < 40 || index > 51) {
        result.current.markPageAccess(index);
      }
    }
  });

  const next = result.current.evictOldLoadedPages(allLoaded(130), 0);
  assert.equal(loadedCount(next), 100);
  for (let index = 40; index <= 51; index += 1) {
    assert.ok(
      next[index],
      `page ${index} is on screen in the second viewport and was evicted`,
    );
  }

  // A claim that protected the whole document would pass the loop above and
  // protect nothing in particular; the buffer either side is deliberate.
  assert.ok(next[38], "the buffer either side of the visible range is kept");
  assert.equal(
    next[10],
    null,
    "pages no view is displaying must stay evictable",
  );
});

test("releasing a viewport's claim gives its pages back to the LRU", () => {
  const claims: Array<{ release: () => void }> = [];
  const { result } = renderHook(() => {
    const cache = usePageCache();
    if (claims.length === 0) {
      claims.push(cache.claimPageResidency(() => ({ end: 0, start: 0 })));
      claims.push(cache.claimPageResidency(() => ({ end: 90, start: 90 })));
    }
    return cache;
  });

  act(() => {
    result.current.markPageAccess(90);
    for (let index = 0; index < 130; index += 1) {
      if (index !== 90) {
        result.current.markPageAccess(index);
      }
    }
  });

  // Page 90 is the least-recently-used page here and the test above says the claim
  // protects it; an eviction pass rewrites the access order it reads, so looking
  // again here would change the answer. The second viewport now unmounts.
  claims[1].release();
  const next = result.current.evictOldLoadedPages(allLoaded(130), 0);
  assert.equal(
    next[90],
    null,
    "a released claim must stop protecting its band, or a closed viewport " +
      "pins pages for ever",
  );
});

test("with no viewport attached only the page being loaded is protected", () => {
  const { result } = renderHook(() => usePageCache());
  const next = result.current.evictOldLoadedPages(allLoaded(130), 7);
  assert.equal(loadedCount(next), 100);
  assert.ok(next[7], "the page just loaded must survive its own eviction pass");
});
