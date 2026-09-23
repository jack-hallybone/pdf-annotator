import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";

// Two viewports over one document: src/tabbedapp renders one, so without this
// the capability is "the types permit it and nothing throws".

const HARNESS_URL = "/tests-e2e/split-view/index.html";

// Big enough that page residency is lazy and eviction can happen at all:
// viewerConfig keeps every page of a document of EAGER_PAGE_LIMIT (25) pages or
// fewer, and only evicts past MAX_LOADED_MAIN_PAGES (100) loaded proxies.
const EVICTION_PAGE_COUNT = 130;
const RETENTION_LIMIT = 100;

const SMALL_PAGE_COUNT = 4;

type ViewId = "a" | "b";

type BothViews<T> = { a: T; b: T };

// Each page is a solid block over most of its area, so "painted" and "blank"
// are never a judgement call at any sample point.
async function fixture(pageCount: number) {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({
      color: rgb(0.1, 0.1 + (index % 8) * 0.1, 0.6),
      height: 762,
      width: 515,
      x: 40,
      y: 40,
    });
  }

  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-split-"));
  const path = join(directory, `split-${pageCount}-pages.pdf`);
  await writeFile(path, await doc.save());
  return path;
}

async function openSplitHarness(page: Page, fixturePath: string) {
  await page.goto(HARNESS_URL);
  await page.locator(".split-harness-input").setInputFiles(fixturePath);
  await page.waitForFunction(
    () => window.splitViewHarness?.ready() === true,
    undefined,
    { timeout: 90_000 },
  );

  // Both panes have painted, not merely laid a canvas out: a blank second
  // viewport would satisfy every assertion below about "the same".
  for (const view of ["a", "b"] as const) {
    await expect(
      page.locator(`[data-view="${view}"] .canvasWrapper canvas`).first(),
    ).toBeVisible({ timeout: 60_000 });
  }
}

// A switch over a name rather than a callback: the dev server's CSP has no
// 'unsafe-eval', so a helper compiled inside the page would throw there only.
function bothViews(
  page: Page,
  reading:
    "activePageIndex" | "annotationCount" | "canUndo" | "pageCount" | "scale",
) {
  return page.evaluate((key) => {
    const harness = window.splitViewHarness!;
    const read = (view: "a" | "b") => {
      switch (key) {
        case "activePageIndex":
          return harness.activePageIndex(view);
        case "annotationCount":
          return harness.annotationCount(view);
        case "canUndo":
          return harness.canUndo(view);
        case "pageCount":
          return harness.pageCount(view);
        case "scale":
          return harness.scale(view);
      }
    };

    return { a: read("a"), b: read("b") };
  }, reading) as Promise<BothViews<number | boolean>>;
}

// Inside the page surface and inside the pane that holds it: at the default zoom
// a page's box reaches outside its pane.
async function visiblePagePoint(
  page: Page,
  view: ViewId,
  pageIndex: number,
  atY = 0.3,
) {
  return page.evaluate(
    ({ atY, pageIndex, view }) => {
      const pane = document.querySelector(`[data-view="${view}"]`);
      const surface = pane?.querySelector(
        `.pdfdocumenteditor-page-slot[data-page-index="${pageIndex}"] .pdfdocumenteditor-page`,
      );
      const root = pane?.querySelector(".pdfdocumenteditor-scroll-root");
      if (!(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) {
        throw new Error(`view ${view} is not showing page ${pageIndex + 1}`);
      }

      const surfaceBox = surface.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      const left = Math.max(surfaceBox.left, rootBox.left);
      const right = Math.min(surfaceBox.right, rootBox.right);
      const top = Math.max(surfaceBox.top, rootBox.top);
      const bottom = Math.min(surfaceBox.bottom, rootBox.bottom);
      if (right - left < 40 || bottom - top < 40) {
        throw new Error(
          `page ${pageIndex + 1} is not on screen in view ${view}`,
        );
      }

      return {
        height: bottom - top,
        width: right - left,
        x: left + (right - left) * 0.2,
        y: top + (bottom - top) * atY,
      };
    },
    { atY, pageIndex, view },
  );
}

// A real gesture rather than a command on the handle, which would prove only
// that the document mutates.
async function drawStroke(page: Page, view: ViewId, atY = 0.3) {
  await page.evaluate(() => window.splitViewHarness!.setTool("draw"));
  await page
    .locator(`[data-view="${view}"] .pdfdocumenteditor-page[data-tool="draw"]`)
    .first()
    .waitFor();

  const origin = await visiblePagePoint(page, view, 0, atY);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(
      origin.x + (origin.width * 0.4 * step) / 10,
      origin.y + (origin.height * 0.1 * step) / 10,
    );
  }
  await page.mouse.up();
  await page.evaluate(() => window.splitViewHarness!.setTool("select"));
}

// The page raster, not the overlays: a slot also holds ink, appearance and
// annotation canvases. Composited onto white, so an unpainted page is one colour.
// The eviction test carries its own copy: a page function cannot close over this.
async function paintedInk(page: Page, view: ViewId, pageIndex: number) {
  return page.evaluate(
    ({ pageIndex, view }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        `[data-view="${view}"] .pdfdocumenteditor-page-slot[data-page-index="${pageIndex}"] .canvasWrapper canvas`,
      );
      if (!canvas?.width || !canvas.height) {
        return 0;
      }

      const sample = document.createElement("canvas");
      sample.width = 48;
      sample.height = 48;
      const context = sample.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return 0;
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, 48, 48);
      context.drawImage(canvas, 0, 0, 48, 48);
      const pixels = context.getImageData(0, 0, 48, 48).data;
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          pixels[index] < 224 ||
          pixels[index + 1] < 224 ||
          pixels[index + 2] < 224
        ) {
          ink += 1;
        }
      }

      return ink;
    },
    { pageIndex, view },
  );
}

test.describe.configure({ timeout: 240_000 });

test.describe("two viewports over one document", () => {
  test.beforeEach(async ({ page }) => {
    await openSplitHarness(page, await fixture(SMALL_PAGE_COUNT));
  });

  test("an annotation drawn in one view appears in the other", async ({
    page,
  }) => {
    expect(await bothViews(page, "annotationCount")).toEqual({ a: 0, b: 0 });

    await drawStroke(page, "a");
    await expect
      .poll(() => bothViews(page, "annotationCount"))
      .toEqual({ a: 1, b: 1 });

    await drawStroke(page, "b", 0.6);
    await expect
      .poll(() => bothViews(page, "annotationCount"))
      .toEqual({ a: 2, b: 2 });
  });

  test("undo in either view is one shared history", async ({ page }) => {
    await drawStroke(page, "a");
    await drawStroke(page, "b", 0.6);
    await expect
      .poll(() => bothViews(page, "annotationCount"))
      .toEqual({ a: 2, b: 2 });

    await page.evaluate(() => window.splitViewHarness!.handle("b")!.undo());
    await expect
      .poll(() => bothViews(page, "annotationCount"))
      .toEqual({ a: 1, b: 1 });

    await page.evaluate(() => window.splitViewHarness!.handle("a")!.undo());
    await expect
      .poll(() => bothViews(page, "annotationCount"))
      .toEqual({ a: 0, b: 0 });

    expect(await bothViews(page, "canUndo")).toEqual({ a: false, b: false });
  });

  test("the two views scroll and zoom independently", async ({ page }) => {
    const initial = await bothViews(page, "scale");
    expect(initial.a).toEqual(initial.b);

    await page.evaluate(() =>
      window.splitViewHarness!.handle("a")!.setZoom(2.5),
    );
    await expect
      .poll(() => bothViews(page, "scale"))
      .toEqual({ a: 2.5, b: initial.b });

    const overB = await visiblePagePoint(page, "b", 0);
    await page.mouse.move(overB.x, overB.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");

    await expect
      .poll(async () => (await bothViews(page, "scale")).b)
      .toBeGreaterThan(initial.b as number);
    expect((await bothViews(page, "scale")).a).toEqual(2.5);

    const scrollTops = () =>
      page.evaluate(() =>
        (["a", "b"] as const).map(
          (view) =>
            document.querySelector(
              `[data-view="${view}"] .pdfdocumenteditor-scroll-root`,
            )?.scrollTop ?? -1,
        ),
      );

    const before = await scrollTops();
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-view="a"] .pdfdocumenteditor-scroll-root',
      );
      if (root) {
        root.scrollTop += 900;
      }
    });

    const after = await scrollTops();
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[1]).toEqual(before[1]);
  });

  test("a page deleted in one view and undone in the other leaves both consistent", async ({
    page,
  }) => {
    await page.evaluate(() =>
      window.splitViewHarness!.handle("b")!.goToPage(2),
    );
    await expect
      .poll(() => bothViews(page, "activePageIndex"))
      .toEqual({ a: 0, b: 2 });
    expect(await bothViews(page, "pageCount")).toEqual({
      a: SMALL_PAGE_COUNT,
      b: SMALL_PAGE_COUNT,
    });

    await page.evaluate(() =>
      window.splitViewHarness!.handle("a")!.deletePage(0),
    );
    await expect
      .poll(() => bothViews(page, "pageCount"), { timeout: 90_000 })
      .toEqual({ a: SMALL_PAGE_COUNT - 1, b: SMALL_PAGE_COUNT - 1 });

    await page.evaluate(() => window.splitViewHarness!.handle("b")!.undo());
    await expect
      .poll(() => bothViews(page, "pageCount"), { timeout: 90_000 })
      .toEqual({ a: SMALL_PAGE_COUNT, b: SMALL_PAGE_COUNT });

    for (const view of ["a", "b"] as const) {
      await expect
        .poll(() => paintedInk(page, view, 0), { timeout: 90_000 })
        .toBeGreaterThan(0);
    }
  });

  test("saving from either view produces the same bytes", async ({ page }) => {
    await drawStroke(page, "a");
    await drawStroke(page, "b", 0.6);
    await expect
      .poll(() => bothViews(page, "annotationCount"))
      .toEqual({ a: 2, b: 2 });

    const fromA = await page.evaluate(() =>
      window.splitViewHarness!.saveFrom("a"),
    );
    const fromB = await page.evaluate(() =>
      window.splitViewHarness!.saveFrom("b"),
    );

    // Two saves that produced nothing are trivially equal.
    expect(fromA.length).toBeGreaterThan(1_000);
    expect(fromA.digest).not.toEqual("");
    expect(fromB).toEqual(fromA);
  });
});

// The watch list is taken from the slots the DOM says overlap B's scroll box - a
// pane only five pages tall would agree with the defect. "B did not move" is B's
// scrollTop, because an active page is itself a reading off page geometry.

// A window tall enough that half of it holds well over five pages at MIN_ZOOM.
// The panes are `height: 100vh`, so this is the pane height.
const EVICTION_VIEWPORT = { height: 1800, width: 1280 };

// viewerConfig's MIN_ZOOM: the most pages a pane can be made to show.
const WIDE_VIEW_ZOOM = 0.2;

// Far enough that B's screen is full and the page table warm, and short enough
// of MAX_LOADED_MAIN_PAGES that no eviction has run yet. This walk ages B's
// pages in the one shared LRU while A moves, which is the state eviction gets
// wrong.
const WARM_UP_PAGE = 20;

// Well over the five pages an active-page band could ever cover.
const MIN_VISIBLE_PAGES = 7;

test.describe("page residency across two viewports", () => {
  test.use({ viewport: EVICTION_VIEWPORT });

  test("scrolling one view does not evict the pages the other is displaying", async ({
    page,
  }) => {
    await openSplitHarness(page, await fixture(EVICTION_PAGE_COUNT));

    await page.evaluate(
      (zoom) => window.splitViewHarness!.handle("b")!.setZoom(zoom),
      WIDE_VIEW_ZOOM,
    );
    await expect
      .poll(() => paintedInk(page, "b", 2), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const measurement = await page.evaluate(
      async ({ minVisiblePages, pageCount, warmUpPage }) => {
        const harness = window.splitViewHarness!;
        const settle = () =>
          new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

        const baseCanvas = (pageIndex: number) =>
          document.querySelector<HTMLCanvasElement>(
            `[data-view="b"] .pdfdocumenteditor-page-slot[data-page-index="${pageIndex}"] .canvasWrapper canvas`,
          );
        const canvasInk = (canvas: HTMLCanvasElement) => {
          if (!canvas.width || !canvas.height) {
            return 0;
          }

          const sample = document.createElement("canvas");
          sample.width = 48;
          sample.height = 48;
          const context = sample.getContext("2d", { willReadFrequently: true });
          if (!context) {
            return 0;
          }

          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, 48, 48);
          context.drawImage(canvas, 0, 0, 48, 48);
          const pixels = context.getImageData(0, 0, 48, 48).data;
          let ink = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if (
              pixels[index] < 224 ||
              pixels[index + 1] < 224 ||
              pixels[index + 2] < 224
            ) {
              ink += 1;
            }
          }
          return ink;
        };

        // Read off the DOM rather than derived from B's active page, which would make the
        // residency claim and the assertion the same guess.
        const paneB = document.querySelector<HTMLElement>('[data-view="b"]')!;
        const rootB = paneB.querySelector<HTMLElement>(
          ".pdfdocumenteditor-scroll-root",
        )!;
        const onScreen = (pageIndex: number) => {
          const slot = paneB.querySelector<HTMLElement>(
            `.pdfdocumenteditor-page-slot[data-page-index="${pageIndex}"]`,
          );
          if (!slot) {
            return false;
          }

          const slotBox = slot.getBoundingClientRect();
          const rootBox = rootB.getBoundingClientRect();
          return (
            slotBox.bottom > rootBox.top + 4 && slotBox.top < rootBox.bottom - 4
          );
        };
        const displayedPages = () => {
          const displayed: number[] = [];
          for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            if (onScreen(pageIndex)) {
              displayed.push(pageIndex);
            }
          }
          return displayed;
        };
        const paintedOnScreen = () =>
          displayedPages().filter((pageIndex) => {
            const canvas = baseCanvas(pageIndex);
            return canvas ? canvasInk(canvas) > 0 : false;
          });

        const handleA = harness.handle("a")!;
        const walkViewA = async (from: number, to: number) => {
          for (let pageIndex = from; pageIndex <= to; pageIndex += 1) {
            handleA.goToPage(pageIndex);
            const deadline = performance.now() + 5_000;
            while (
              !harness.pageLoaded("a", pageIndex) &&
              performance.now() < deadline
            ) {
              await settle();
            }
          }
        };

        const scrollTopBefore = rootB.scrollTop;
        await walkViewA(0, warmUpPage);
        const paintDeadline = performance.now() + 30_000;
        while (
          paintedOnScreen().length < minVisiblePages &&
          performance.now() < paintDeadline
        ) {
          await settle();
        }

        const visiblePages = displayedPages();
        const watched: {
          canvas: HTMLCanvasElement;
          ink: number;
          pageIndex: number;
        }[] = [];
        for (const pageIndex of visiblePages) {
          const canvas = baseCanvas(pageIndex);
          const ink = canvas ? canvasInk(canvas) : 0;
          if (canvas && ink > 0) {
            watched.push({ canvas, ink, pageIndex });
          }
        }

        const loadedAtSnapshot = harness.loadedPageIndexes("b").length;

        await walkViewA(warmUpPage + 1, pageCount - 1);

        // goToPage awaits the page's proxy before it scrolls, so under load a navigate
        // can resolve after the walk has moved on and scroll A backwards.
        const parkDeadline = performance.now() + 20_000;
        while (
          !harness.pageLoaded("a", pageCount - 1) &&
          performance.now() < parkDeadline
        ) {
          await settle();
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        handleA.goToPage(pageCount - 1);
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        return {
          loadedAtSnapshot,
          loadedFromA: harness.loadedPageIndexes("a").length,
          loadedFromB: harness.loadedPageIndexes("b").length,
          scrollTopAfter: rootB.scrollTop,
          scrollTopBefore,
          viewA: harness.activePageIndex("a"),
          visibleFirst: visiblePages[0] ?? -1,
          visibleLast: visiblePages[visiblePages.length - 1] ?? -1,
          visiblePages: visiblePages.length,
          watched: watched.map(({ canvas, ink, pageIndex }) => {
            const now = baseCanvas(pageIndex);
            return {
              inkAfter: now ? canvasInk(now) : 0,
              inkBefore: ink,
              pageIndex,
              resident: harness.pageLoaded("b", pageIndex),
              sameCanvas: now === canvas,
            };
          }),
        };
      },
      {
        minVisiblePages: MIN_VISIBLE_PAGES,
        pageCount: EVICTION_PAGE_COUNT,
        warmUpPage: WARM_UP_PAGE,
      },
    );

    // A run where eviction never engaged, where view B was displaying little enough
    // for the old band to cover it, where the watch list was taken after the damage,
    // or where view A never moved would report an intact view B while proving nothing.
    expect(
      measurement.loadedFromA,
      "eviction never ran, so nothing was ever at risk",
    ).toEqual(RETENTION_LIMIT);
    expect(measurement.loadedFromB).toEqual(measurement.loadedFromA);
    expect(
      measurement.loadedAtSnapshot,
      "eviction had already run when the watch list was taken",
    ).toBeLessThan(RETENTION_LIMIT);
    expect(measurement.viewA).toEqual(EVICTION_PAGE_COUNT - 1);
    expect(measurement.scrollTopAfter).toEqual(measurement.scrollTopBefore);
    expect(measurement.visibleFirst).toBeLessThan(4);

    // The pane is taller than the band: a claim built from an active page and
    // LAZY_PAGE_BUFFER either side covers five pages, and view B displays more.
    expect(
      measurement.visiblePages,
      "view B's pane is not taller than the five-page band this test exists " +
        "to outrun",
    ).toBeGreaterThan(5);
    expect(
      measurement.watched.length,
      "view B was displaying nothing to lose",
    ).toBeGreaterThanOrEqual(MIN_VISIBLE_PAGES);
    for (const watched of measurement.watched) {
      expect(watched.pageIndex).toBeGreaterThanOrEqual(
        measurement.visibleFirst,
      );
      expect(watched.pageIndex).toBeLessThanOrEqual(measurement.visibleLast);
    }

    for (const watched of measurement.watched) {
      expect(watched, `page ${watched.pageIndex + 1} of view B`).toEqual({
        inkAfter: watched.inkBefore,
        inkBefore: watched.inkBefore,
        pageIndex: watched.pageIndex,
        resident: true,
        sameCanvas: true,
      });
    }
  });
});
