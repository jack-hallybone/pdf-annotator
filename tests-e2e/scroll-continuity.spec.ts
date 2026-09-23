import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";

// A screenshot cannot see the two-frame flash when the current page changes, so
// this scrolls in small steps and reads every on-screen page's base canvas on
// every animation frame.

const PAGE_COUNT = 8;
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test.describe.configure({ timeout: 180_000 });

async function multiPageFixture() {
  const doc = await PDFDocument.create();
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    const page = doc.addPage([595, 842]);
    // A block covering most of the page, so "painted" and "blank" are not a
    // judgement call at any sample point.
    page.drawRectangle({
      color: rgb(0.1, 0.1 + index * 0.1, 0.6),
      height: 762,
      width: 515,
      x: 40,
      y: 40,
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-scroll-"));
  const path = join(directory, "eight-pages.pdf");
  await writeFile(path, await doc.save());
  return path;
}

test("scrolling past a page boundary never blanks a rendered page", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await multiPageFixture());
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 60_000 });
  // The pages either side of the first render lazily, and the defect is about
  // pages already on screen, so let them arrive first.
  await page.waitForTimeout(6_000);

  const measurement = await page.evaluate(async (pageCount) => {
    const root = document.querySelector(".pdfdocumenteditor-scroll-root");
    if (!(root instanceof HTMLElement)) {
      throw new Error("no scroll container");
    }

    const slotFor = (index: number) =>
      document.querySelector<HTMLElement>(
        `.pdfdocumenteditor-page-slot[data-page-index="${index}"]`,
      );

    // The page raster, not the overlays: a slot also holds default-sized ink,
    // appearance and annotation canvases.
    const baseCanvasFor = (index: number) =>
      slotFor(index)?.querySelector<HTMLCanvasElement>(
        ".canvasWrapper canvas",
      ) ?? null;

    const onScreen = (index: number) => {
      const slot = slotFor(index);
      if (!slot) {
        return false;
      }
      const bounds = slot.getBoundingClientRect();
      const viewport = root.getBoundingClientRect();
      return (
        bounds.bottom > viewport.top + 4 && bounds.top < viewport.bottom - 4
      );
    };

    const painted = (index: number) => {
      const canvas = baseCanvasFor(index);
      if (!canvas?.width || !canvas.height) {
        return false;
      }
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return false;
      }
      let coloured = 0;
      for (let y = 1; y < 10; y += 1) {
        for (let x = 1; x < 10; x += 1) {
          const [red, green, blue, alpha] = context.getImageData(
            Math.floor((canvas.width * x) / 10),
            Math.floor((canvas.height * y) / 10),
            1,
            1,
          ).data;
          if (alpha !== 0 && (red < 240 || green < 240 || blue < 240)) {
            coloured += 1;
          }
        }
      }
      return coloured > 10;
    };

    const paintedBefore: number[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      if (painted(index)) {
        paintedBefore.push(index);
      }
    }

    const activePage = () => {
      const current = document.querySelector('[aria-current="page"]');
      const slot = current?.closest<HTMLElement>("[data-page-index]");
      return slot ? Number(slot.dataset.pageIndex) : null;
    };

    const nextFrame = () =>
      new Promise((resolve) => requestAnimationFrame(resolve));
    const blanks: { page: number; scrollTop: number }[] = [];
    const boundaries: number[] = [];
    let lastActive = activePage();
    const start = root.scrollTop;

    for (let step = 1; step <= 220; step += 1) {
      root.scrollTop = start + 24 * step;
      await nextFrame();

      const active = activePage();
      if (active !== lastActive) {
        boundaries.push(Math.round(root.scrollTop));
        lastActive = active;
      }

      for (const index of paintedBefore) {
        if (onScreen(index) && !painted(index)) {
          blanks.push({
            page: index + 1,
            scrollTop: Math.round(root.scrollTop),
          });
        }
      }
    }

    return { blanks, boundaries, paintedBefore: paintedBefore.length };
  }, PAGE_COUNT);

  // A run that never crossed a boundary, or that had nothing painted to lose,
  // would report zero flashes without proving anything.
  expect(measurement.paintedBefore).toBeGreaterThan(1);
  expect(measurement.boundaries.length).toBeGreaterThan(1);

  expect(
    measurement.blanks,
    `pages went blank while scrolling past a boundary (active page changed at scrollTop ${measurement.boundaries.join(", ")})`,
  ).toEqual([]);
});
