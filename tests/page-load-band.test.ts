import assert from "node:assert/strict";
import test from "node:test";
import {
  initialReloadPageIndexes,
  isPageWithinReach,
  pageRenderPriority,
  renderedPageReach,
  visibleLoadPageIndexes,
} from "../src/pdfdocumenteditor/pdfDocumentEditorHelpers";
import {
  LAZY_PAGE_BUFFER,
  MAX_BAND_LOAD_PAGES,
  RENDERED_PAGE_PIXEL_BUDGET,
} from "../src/pdfdocumenteditor/viewerConfig";

// The band is a function of the displayed range, so a wide range asks for a wide band and a test written against an active index could not tell the two apart.

test("the load band covers everything displayed plus the buffer", () => {
  assert.deepEqual(
    visibleLoadPageIndexes({ end: 12, start: 4 }, 60).sort((a, b) => a - b),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );

  const wide = visibleLoadPageIndexes({ end: 30, start: 20 }, 60);
  assert.equal(Math.min(...wide), 20 - LAZY_PAGE_BUFFER);
  assert.equal(Math.max(...wide), 30 + LAZY_PAGE_BUFFER);
});

test("a one-page range is the band the active page used to give", () => {
  assert.deepEqual(
    visibleLoadPageIndexes({ end: 7, start: 7 }, 60).sort((a, b) => a - b),
    [5, 6, 7, 8, 9],
  );
});

test("the band is clamped to the document at both ends", () => {
  assert.deepEqual(
    visibleLoadPageIndexes({ end: 2, start: 0 }, 5).sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    visibleLoadPageIndexes({ end: 4, start: 3 }, 5).sort((a, b) => a - b),
    [1, 2, 3, 4],
  );
  assert.deepEqual(visibleLoadPageIndexes({ end: 0, start: 0 }, 0), []);
  assert.deepEqual(
    visibleLoadPageIndexes({ end: 4, start: 9 }, 60).sort((a, b) => a - b),
    visibleLoadPageIndexes({ end: 9, start: 4 }, 60).sort((a, b) => a - b),
  );
});

test("the band loads outward from the centre of the viewport", () => {
  // Order is the promise the cap rests on: when it bites it takes the edges, so the pages the reader is looking at are the ones that arrive.
  assert.deepEqual(
    visibleLoadPageIndexes({ end: 22, start: 18 }, 60),
    [20, 19, 21, 18, 22, 17, 23, 16, 24],
  );
});

test("the cap bites at the edges and never in the middle", () => {
  const capped = visibleLoadPageIndexes({ end: 60, start: 10 }, 200, 9);
  assert.equal(capped.length, 9);
  assert.deepEqual(capped, [35, 34, 36, 33, 37, 32, 38, 31, 39]);

  const wide = visibleLoadPageIndexes({ end: 300, start: 0 }, 400);
  assert.equal(wide.length, MAX_BAND_LOAD_PAGES);

  assert.deepEqual(
    visibleLoadPageIndexes({ end: 7, start: 5 }, 60, 500).sort((a, b) => a - b),
    [3, 4, 5, 6, 7, 8, 9],
  );
});

test("render priority ranks against the range, not one index", () => {
  const range = { end: 14, start: 6 };
  // Ranked against a scalar active index these came out "idle", which is a requestIdleCallback with a 1200ms timeout: on screen and blank for a second.
  for (let pageIndex = 6; pageIndex <= 14; pageIndex += 1) {
    assert.equal(pageRenderPriority(pageIndex, range), "visible");
  }
  assert.equal(pageRenderPriority(5, range), "near");
  assert.equal(pageRenderPriority(4, range), "near");
  assert.equal(pageRenderPriority(3, range), "idle");
  assert.equal(pageRenderPriority(15, range), "near");
  assert.equal(pageRenderPriority(16, range), "near");
  assert.equal(pageRenderPriority(17, range), "idle");

  assert.equal(pageRenderPriority(9, { end: 9, start: 9 }), "visible");
  assert.equal(pageRenderPriority(10, { end: 9, start: 9 }), "near");
  assert.equal(pageRenderPriority(12, { end: 9, start: 9 }), "idle");
});

test("a reloaded document brings back what the view was displaying", () => {
  const indexes = initialReloadPageIndexes(60, 20, { end: 26, start: 16 });
  assert.ok(indexes.includes(20));
  assert.deepEqual(
    indexes.sort((a, b) => a - b),
    [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28],
  );

  assert.deepEqual(
    initialReloadPageIndexes(60, 20, null).sort((a, b) => a - b),
    [18, 19, 20, 21, 22],
  );

  const shrunk = initialReloadPageIndexes(4, 3, { end: 26, start: 16 });
  assert.ok(shrunk.includes(3));
  assert.deepEqual(
    shrunk.sort((a, b) => a - b),
    [1, 2, 3],
  );
});

test("the rendered reach spends the pixel budget and no more", () => {
  const pagePixels = RENDERED_PAGE_PIXEL_BUDGET / 20;
  const reach = renderedPageReach({ end: 11, start: 10 }, pagePixels);
  assert.equal(reach, 9);
  // Every page it keeps rendered, displayed ones included, fits in the budget; before it, reading on kept every visited page's canvases and the renderer grew until it crashed.
  const rendered = Array.from({ length: 100 }, (_, index) => index).filter(
    (index) => isPageWithinReach(index, { end: 11, start: 10 }, reach),
  );
  assert.deepEqual([rendered[0], rendered.at(-1)], [1, 20]);
  assert.ok(rendered.length * pagePixels <= RENDERED_PAGE_PIXEL_BUDGET);
});

test("the rendered reach never falls inside the load band", () => {
  // Pages in the band render as soon as they load, so a reach shorter than the band would unmount them the moment they painted.
  const hugePage = RENDERED_PAGE_PIXEL_BUDGET * 2;
  assert.equal(
    renderedPageReach({ end: 7, start: 5 }, hugePage),
    LAZY_PAGE_BUFFER,
  );
  assert.equal(
    renderedPageReach({ end: 30, start: 0 }, 1_000_000),
    LAZY_PAGE_BUFFER,
  );
  // Until a page has been measured there is no size to budget against, so nothing loaded is released.
  assert.ok(renderedPageReach({ end: 0, start: 0 }, 0) >= MAX_BAND_LOAD_PAGES);
  for (const index of visibleLoadPageIndexes({ end: 7, start: 5 }, 60)) {
    assert.ok(isPageWithinReach(index, { end: 7, start: 5 }, LAZY_PAGE_BUFFER));
  }
});

test("reach is measured from both ends of the displayed range", () => {
  assert.equal(isPageWithinReach(2, { end: 9, start: 5 }, 3), true);
  assert.equal(isPageWithinReach(1, { end: 9, start: 5 }, 3), false);
  assert.equal(isPageWithinReach(12, { end: 9, start: 5 }, 3), true);
  assert.equal(isPageWithinReach(13, { end: 9, start: 5 }, 3), false);
  assert.equal(isPageWithinReach(13, { end: 5, start: 9 }, 3), false);
  assert.equal(isPageWithinReach(12, { end: 5, start: 9 }, 3), true);
});
