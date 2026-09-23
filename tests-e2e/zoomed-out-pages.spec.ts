import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import { MAX_BAND_LOAD_PAGES } from "../src/pdfdocumenteditor/viewerConfig";

// Measured as ink, because "a canvas is present" is equally true of a canvas
// PDF.js never painted into, which is exactly this defect.

// Longer than EAGER_PAGE_LIMIT (25), or the document loads every page up front
// and there is no lazy band left to get wrong.
const PAGE_COUNT = 60;
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

// A pane this tall at MIN_ZOOM shows about eleven pages of an A4-shaped
// document, comfortably more than the five an active-page band covered.
const TALL_VIEWPORT = { height: 1800, width: 1280 };

const MIN_VISIBLE_PAGES = 8;

test.describe.configure({ timeout: 180_000 });

// Tiny pages, so MIN_ZOOM puts more on screen than the load band may hold: a
// 90x120pt page is 24 CSS px tall at MIN_ZOOM.
const TINY_PAGE_COUNT = 200;

async function fixture(
  pageCount: number,
  size: [number, number],
  block: [number, number],
) {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage(size);
    page.drawRectangle({
      color: rgb(0.1, 0.1 + (index % 8) * 0.1, 0.6),
      height: block[1],
      width: block[0],
      x: (size[0] - block[0]) / 2,
      y: (size[1] - block[1]) / 2,
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-zoomed-"));
  const path = join(directory, `${pageCount}-pages.pdf`);
  await writeFile(path, await doc.save());
  return path;
}

// Read off the DOM rather than derived from the active page, which would be the
// same guess the code makes. A page displayed and not painted is reported with
// its placeholder, so the cap doing its job and no element at all can be told
// apart.
function readPane(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      ".pdfdocumenteditor-scroll-root",
    )!;
    const rootBox = root.getBoundingClientRect();

    const baseCanvas = (slot: HTMLElement) =>
      slot.querySelector<HTMLCanvasElement>(".canvasWrapper canvas");

    const inkOf = (canvas: HTMLCanvasElement) => {
      if (!canvas.width || !canvas.height) {
        return 0;
      }
      const sample = document.createElement("canvas");
      sample.width = 32;
      sample.height = 32;
      const context = sample.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return 0;
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, 32, 32);
      context.drawImage(canvas, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
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

    const displayed: {
      ink: number;
      pageIndex: number;
      pending: string | null;
      pendingHeight: number;
    }[] = [];
    for (const slot of document.querySelectorAll<HTMLElement>(
      ".pdfdocumenteditor-page-slot",
    )) {
      const box = slot.getBoundingClientRect();
      if (box.bottom <= rootBox.top + 4 || box.top >= rootBox.bottom - 4) {
        continue;
      }
      const canvas = baseCanvas(slot);
      const placeholder = slot.querySelector<HTMLElement>(
        ".pdfdocumenteditor-page-placeholder",
      );
      displayed.push({
        ink: canvas ? inkOf(canvas) : 0,
        pageIndex: Number(slot.dataset.pageIndex),
        pending: placeholder?.getAttribute("aria-label") ?? null,
        pendingHeight: placeholder
          ? Math.round(placeholder.getBoundingClientRect().height)
          : 0,
      });
    }

    return { displayed };
  });
}

test.describe("a zoomed-out viewport paints every page it displays", () => {
  test.use({ viewport: TALL_VIEWPORT });

  test("every page the pane displays at minimum zoom carries ink", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .locator(HIDDEN_FILE_INPUT)
      .setInputFiles(await fixture(PAGE_COUNT, [595, 842], [515, 762]));
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);

    for (let press = 0; press < 16; press += 1) {
      await page.keyboard.press("Control+Minus");
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(2_000);

    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        ".pdfdocumenteditor-scroll-root",
      )!;
      root.scrollTop = Math.round(root.scrollHeight * 0.5);
    });
    await page.waitForTimeout(1_000);

    // Polling and then asserting is not circular: the poll can only end early, and a
    // band that never asks for those pages never ends it.
    await expect
      .poll(
        async () =>
          (await readPane(page)).displayed.filter((p) => p.ink === 0).length,
        { timeout: 60_000 },
      )
      .toEqual(0);

    const pane = await readPane(page);

    // A pane showing five pages, or one parked back at the top of the document,
    // would report "everything painted" while proving nothing about the band.
    expect(
      pane.displayed.length,
      "the pane is not showing more pages than the old five-page band covered",
    ).toBeGreaterThanOrEqual(MIN_VISIBLE_PAGES);
    expect(
      pane.displayed[0]?.pageIndex,
      "the pane is parked where the zoom-out journey already loaded pages",
    ).toBeGreaterThan(5);
    expect(pane.displayed.at(-1)!.pageIndex).toBeLessThan(PAGE_COUNT);

    expect(
      pane.displayed.filter((entry) => entry.ink === 0),
      "pages the pane is displaying have no painted pixels",
    ).toEqual([]);
  });

  // "Load the visible range" is unbounded, which is why MAX_BAND_LOAD_PAGES exists.
  // The cap is acceptable only because it takes the edges of the viewport and never
  // the middle, and a page past it is visibly pending rather than a gap.
  test("past the cap a page is a pending placeholder, not a gap", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .locator(HIDDEN_FILE_INPUT)
      .setInputFiles(await fixture(TINY_PAGE_COUNT, [90, 120], [70, 100]));
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);

    for (let press = 0; press < 16; press += 1) {
      await page.keyboard.press("Control+Minus");
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(2_000);

    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        ".pdfdocumenteditor-scroll-root",
      )!;
      root.scrollTop = Math.round(root.scrollHeight * 0.6);
    });
    await page.waitForTimeout(1_000);

    await expect
      .poll(
        async () =>
          (await readPane(page)).displayed.filter((entry) => entry.ink > 0)
            .length,
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(MIN_VISIBLE_PAGES);
    await page.waitForTimeout(3_000);

    const pane = await readPane(page);
    const painted = pane.displayed.filter((entry) => entry.ink > 0);
    const blank = pane.displayed.filter((entry) => entry.ink === 0);

    // If the pane is not showing more pages than the band may hold, the cap never
    // bit and everything below is vacuous.
    expect(
      pane.displayed.length,
      "the pane is not showing more pages than MAX_BAND_LOAD_PAGES",
    ).toBeGreaterThan(MAX_BAND_LOAD_PAGES);
    expect(blank.length, "the cap did not bite").toBeGreaterThan(0);

    // The cap took both edges: one painted run with blanks above and below it in
    // roughly equal numbers. "The middle is inside the painted run" is not enough - a
    // band loading from the first visible page satisfies that whenever the cap is
    // more than half the pane.
    const paintedIndexes = painted.map((entry) => entry.pageIndex);
    const first = paintedIndexes[0]!;
    const last = paintedIndexes.at(-1)!;
    expect(paintedIndexes).toEqual(
      Array.from({ length: last - first + 1 }, (_, step) => first + step),
    );

    const leadingBlanks = pane.displayed.findIndex((entry) => entry.ink > 0);
    const trailingBlanks =
      pane.displayed.length -
      1 -
      pane.displayed.reduce(
        (best, entry, index) => (entry.ink > 0 ? index : best),
        -1,
      );
    expect(
      leadingBlanks,
      "nothing was cut from the TOP of the viewport, so the band did not " +
        "load outward from the centre",
    ).toBeGreaterThan(0);
    expect(
      trailingBlanks,
      "nothing was cut from the BOTTOM of the viewport",
    ).toBeGreaterThan(0);
    expect(
      Math.abs(leadingBlanks - trailingBlanks),
      `the painted run is not centred (${leadingBlanks} blank above, ` +
        `${trailingBlanks} below)`,
    ).toBeLessThanOrEqual(3);

    for (const entry of blank) {
      expect(entry.pending, `page ${entry.pageIndex + 1} is a gap`).toEqual(
        `Loading page ${entry.pageIndex + 1}`,
      );
      expect(entry.pendingHeight).toBeGreaterThan(0);
    }
  });
});
