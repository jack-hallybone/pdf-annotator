import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";

// Reading through a long document used to keep every visited page's canvases, and closing it kept them all, so the renderer grew by gigabytes until it stalled or crashed.

const PAGE_COUNT = 40;
const FILE_NAME = "forty-pages.pdf";
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test.describe.configure({ timeout: 180_000 });

async function longFixture() {
  const doc = await PDFDocument.create();
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({
      color: rgb(0.2, 0.3, 0.6),
      height: 300,
      width: 400,
      x: 100,
      y: 440,
    });
    page.drawText(`Page ${index + 1}`, { size: 36, x: 100, y: 360 });
  }
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-long-"));
  const path = join(directory, FILE_NAME);
  await writeFile(path, await doc.save());
  return path;
}

function slotSelector(index: number) {
  return `.pdfdocumenteditor-page-slot[data-page-index="${index}"]`;
}

async function scrollToPage(page: Page, index: number) {
  await page
    .locator(slotSelector(index))
    .evaluate((slot) => slot.scrollIntoView({ block: "start" }));
}

async function waitForRenderedPage(page: Page, index: number) {
  await page.waitForFunction(
    (selector) =>
      Boolean(
        document.querySelector<HTMLCanvasElement>(
          `${selector} article[data-page-ready="true"] .canvasWrapper canvas`,
        )?.width,
      ),
    slotSelector(index),
    { timeout: 30_000 },
  );
}

async function renderedPageCount(page: Page) {
  return page.evaluate(
    () =>
      [
        ...document.querySelectorAll<HTMLCanvasElement>(
          ".pdfdocumenteditor-page-slot .canvasWrapper canvas",
        ),
      ].filter((canvas) => canvas.width > 0).length,
  );
}

// Canvases that have left the document but are still reachable. PDF.js's own scratch canvases were never in a tree, so a parent marks one of ours.
async function detachedPageCanvases(page: Page) {
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const { result: prototype } = await cdp.send("Runtime.evaluate", {
      expression: "HTMLCanvasElement.prototype",
    });
    if (!prototype.objectId) {
      throw new Error("no canvas prototype");
    }
    const { objects } = await cdp.send("Runtime.queryObjects", {
      prototypeObjectId: prototype.objectId,
    });
    if (!objects.objectId) {
      throw new Error("no canvas list");
    }
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      functionDeclaration:
        "function () { return this.filter((canvas) => !canvas.isConnected && canvas.parentNode !== null).length; }",
      objectId: objects.objectId,
      returnByValue: true,
    });
    return result.value as number;
  } finally {
    await cdp.detach();
  }
}

test("reading through a long document keeps only the pages near the view rendered", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await longFixture());
  await waitForRenderedPage(page, 0);

  let releasedPageHeight = 0;
  for (let index = 1; index < PAGE_COUNT; index += 1) {
    await scrollToPage(page, index);
    await waitForRenderedPage(page, index);
    if (index === 10) {
      releasedPageHeight = await page
        .locator(slotSelector(10))
        .evaluate((slot) => slot.getBoundingClientRect().height);
    }
  }

  // A page at the default zoom is about 2.7M device pixels, so the budget holds a dozen; all forty stayed rendered before.
  expect(await renderedPageCount(page)).toBeLessThanOrEqual(16);
  expect(await detachedPageCanvases(page)).toBe(0);

  // A released page keeps its height, so the column does not shift under the reader, and renders again on the way back. Within a pixel: PDF.js rounds a rendered page's box to whole pixels and the placeholder keeps the exact size.
  const releasedSlot = page.locator(slotSelector(10));
  await expect(releasedSlot.locator(".canvasWrapper canvas")).toHaveCount(0);
  const heightWhileReleased = await releasedSlot.evaluate(
    (slot) => slot.getBoundingClientRect().height,
  );
  expect(Math.abs(heightWhileReleased - releasedPageHeight)).toBeLessThan(1);
  await scrollToPage(page, 10);
  await waitForRenderedPage(page, 10);

  await page.getByRole("button", { name: `Close ${FILE_NAME}` }).click();
  await expect(page.locator(".pdfdocumenteditor-page-slot")).toHaveCount(0);
  expect(await detachedPageCanvases(page)).toBe(0);
});
