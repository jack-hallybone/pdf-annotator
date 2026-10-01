import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import {
  THUMB_WOBBLE_SLACK,
  TRACK_PAGE_FRACTION,
} from "../src/pdfdocumenteditor/pageScrollbar";

// On a long document one pixel of scrollbar moves the pages a hundred or more, so the wobble of a pen tip held on the browser's own thumb shook the pages up and down. The page column draws its own bars now: a pen's wobble of a few pixels leaves them still, and the mouse stays exact.

const PAGE_COUNT = 60;
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
// deploy.yml runs this suite with BASE_PATH set, and the dev server then serves everything under that sub-path.
const SPLIT_HARNESS_URL = `${process.env.BASE_PATH ?? ""}/tests-e2e/split-view/index.html`;

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
  }
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-bars-"));
  const path = join(directory, "sixty-pages.pdf");
  await writeFile(path, await doc.save());
  return path;
}

function thumbOf(scope: string, axis: "x" | "y") {
  return `${scope} .pdfdocumenteditor-scrollbar--${axis} .pdfdocumenteditor-scrollbar-thumb`;
}

async function box(page: Page, selector: string) {
  const bounds = await page.locator(selector).boundingBox();
  if (!bounds) {
    throw new Error(`${selector} is not on screen`);
  }
  return bounds;
}

function scrollTop(page: Page, scope = "") {
  return page
    .locator(`${scope} .pdfdocumenteditor-scroll-root`)
    .evaluate((root) => root.scrollTop);
}

// Two frames: one for the scroll event's measure, one for the thumb it moved to paint.
function settle(page: Page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

// A pen as Chrome receives one from a tablet, which Playwright's own mouse cannot be.
function pointer(cdp: CDPSession, pointerType: "mouse" | "pen") {
  const force = pointerType === "pen" ? 0.5 : 0;
  return {
    down: (x: number, y: number) =>
      cdp.send("Input.dispatchMouseEvent", {
        button: "left",
        buttons: 1,
        clickCount: 1,
        force,
        pointerType,
        type: "mousePressed",
        x,
        y,
      }),
    move: (x: number, y: number) =>
      cdp.send("Input.dispatchMouseEvent", {
        button: "left",
        buttons: 1,
        force,
        pointerType,
        type: "mouseMoved",
        x,
        y,
      }),
    up: (x: number, y: number) =>
      cdp.send("Input.dispatchMouseEvent", {
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType,
        type: "mouseReleased",
        x,
        y,
      }),
  };
}

async function openLongDocument(page: Page) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await longFixture());
  await expect(page.locator(".canvasWrapper canvas").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(thumbOf("", "y"))).toBeVisible();
}

// Midway, so the pages can shake either way, then long enough for the pages there to render: a page arriving must not pass for the thumb moving them.
async function scrollToMiddle(page: Page) {
  await page
    .locator(".pdfdocumenteditor-scroll-root")
    .evaluate((root) => root.scrollTo({ top: root.scrollHeight / 2 }));
  await page.waitForTimeout(2_000);
  await settle(page);
}

// Every scroll position the pages pass through from here on.
async function recordScrolling(page: Page) {
  await page.locator(".pdfdocumenteditor-scroll-root").evaluate((root) => {
    const log: number[] = [];
    root.addEventListener("scroll", () => log.push(root.scrollTop));
    (window as unknown as { scrollLog: number[] }).scrollLog = log;
  });
  return async () => {
    const log = await page.evaluate(
      () => (window as unknown as { scrollLog: number[] }).scrollLog,
    );
    return log.length ? Math.max(...log) - Math.min(...log) : 0;
  };
}

test("a pen held on the thumb keeps the pages still through a few pixels of wobble, and still drags them", async ({
  page,
}) => {
  await openLongDocument(page);
  await scrollToMiddle(page);
  const cdp = await page.context().newCDPSession(page);
  const pen = pointer(cdp, "pen");
  const thumb = await box(page, thumbOf("", "y"));
  const x = thumb.x + thumb.width / 2;
  const y = thumb.y + thumb.height / 2;
  const startTop = await scrollTop(page);
  const spread = await recordScrolling(page);

  // A tip held still on a tablet still wanders a pixel or three, along the bar and across it.
  await pen.down(x, y);
  for (let move = 0; move < 60; move += 1) {
    const wobble = [0, 1, -1, 2, -2, 3, -3, 2, -1, 1, 3, -2][move % 12];
    await pen.move(x + (move % 3) - 1, y + wobble);
    await page.waitForTimeout(8);
  }
  await settle(page);
  expect(await spread(), "the pages moved under a held pen").toBeLessThan(2);
  expect(Math.abs((await scrollTop(page)) - startTop)).toBeLessThan(2);

  // A deliberate drag still moves them, the thumb trailing the pen by the slack.
  for (let step = 1; step <= 40; step += 1) {
    await pen.move(x, y + step);
  }
  await settle(page);
  expect((await box(page, thumbOf("", "y"))).y - thumb.y).toBeCloseTo(
    40 - THUMB_WOBBLE_SLACK,
    0,
  );
  expect(await scrollTop(page)).toBeGreaterThan(startTop + 1000);
  await pen.up(x, y + 40);
});

test("a mouse drag on the thumb tracks the pointer exactly, as the browser's own did", async ({
  page,
}) => {
  await openLongDocument(page);
  await scrollToMiddle(page);
  const cdp = await page.context().newCDPSession(page);
  const mouse = pointer(cdp, "mouse");
  const thumb = await box(page, thumbOf("", "y"));
  const x = thumb.x + thumb.width / 2;
  const y = thumb.y + thumb.height / 2;
  const startTop = await scrollTop(page);

  await mouse.down(x, y);
  for (let step = 1; step <= 40; step += 1) {
    await mouse.move(x, y + step);
  }
  await settle(page);
  expect((await box(page, thumbOf("", "y"))).y - thumb.y).toBeCloseTo(40, 0);
  const draggedTop = await scrollTop(page);
  expect(draggedTop).toBeGreaterThan(startTop + 1000);

  // Every pixel counts for a mouse, back as well as on.
  await mouse.move(x, y + 37);
  await settle(page);
  expect((await box(page, thumbOf("", "y"))).y - thumb.y).toBeCloseTo(37, 0);
  expect(await scrollTop(page)).toBeLessThan(draggedTop);
  await mouse.up(x, y + 37);
});

test("a press on the track pages toward it and leaves focus where it was, and a wheel over the bar scrolls", async ({
  page,
}) => {
  await openLongDocument(page);
  const pageNumber = page.getByRole("textbox", { name: "Page number" });
  await pageNumber.focus();
  const bar = await box(page, ".pdfdocumenteditor-scrollbar--y");
  const viewHeight = await page
    .locator(".pdfdocumenteditor-scroll-root")
    .evaluate((root) => root.clientHeight);
  const startTop = await scrollTop(page);

  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height - 20);
  await expect
    .poll(() => scrollTop(page))
    .toBeCloseTo(startTop + viewHeight * TRACK_PAGE_FRACTION, -1);
  await expect(pageNumber).toBeFocused();

  const pagedTop = await scrollTop(page);
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scrollTop(page)).toBeCloseTo(pagedTop + 300, -1);
});

test("the sideways bar shows only while the pages are wider than the view, and the zoom controls stay clear of it", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 480 });
  await openLongDocument(page);
  const root = page.locator(".pdfdocumenteditor");
  await expect(root).toHaveAttribute("data-scrolls-sideways", "true");
  await expect(page.locator(thumbOf("", "x"))).toBeVisible();

  const scroller = await box(page, ".pdfdocumenteditor-scroll-root");
  const sidewaysBar = await box(page, ".pdfdocumenteditor-scrollbar--x");
  const upright = await box(page, ".pdfdocumenteditor-scrollbar--y");
  const zoom = await box(page, ".zoom-controls");
  // The bars sit beside and under the pages, as the browser's did, and the browser's own are gone.
  expect(upright.x).toBeCloseTo(scroller.x + scroller.width, 0);
  expect(sidewaysBar.y).toBeCloseTo(scroller.y + scroller.height, 0);
  expect(zoom.y + zoom.height).toBeLessThanOrEqual(sidewaysBar.y);
  expect(zoom.x + zoom.width).toBeLessThanOrEqual(upright.x);
  expect(
    await page
      .locator(".pdfdocumenteditor-scroll-root")
      .evaluate(
        (element: HTMLElement) => element.offsetWidth - element.clientWidth,
      ),
  ).toBe(0);

  const scrollLeft = () =>
    page
      .locator(".pdfdocumenteditor-scroll-root")
      .evaluate((element) => element.scrollLeft);
  const thumb = await box(page, thumbOf("", "x"));
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2 + 30, thumb.y + 2);
  await page.mouse.up();
  expect(await scrollLeft()).toBeGreaterThan(0);

  await page.setViewportSize({ height: 800, width: 1280 });
  await expect(root).not.toHaveAttribute("data-scrolls-sideways");
  await expect(page.locator(".pdfdocumenteditor-scrollbar--x")).toBeHidden();
});

test("each of two views has its own bars, and dragging one scrolls only its view", async ({
  page,
}) => {
  await page.goto(SPLIT_HARNESS_URL);
  await page.locator(".split-harness-input").setInputFiles(await longFixture());
  await page.waitForFunction(
    () =>
      (
        window as unknown as { splitViewHarness?: { ready: () => boolean } }
      ).splitViewHarness?.ready() === true,
    undefined,
    { timeout: 90_000 },
  );
  const a = '[data-view="a"]';
  const b = '[data-view="b"]';
  await expect(page.locator(thumbOf(a, "y"))).toBeVisible();
  await expect(page.locator(thumbOf(b, "y"))).toBeVisible();
  const startB = await scrollTop(page, b);

  const thumb = await box(page, thumbOf(a, "y"));
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + 60, {
    steps: 6,
  });
  await page.mouse.up();

  expect(await scrollTop(page, a)).toBeGreaterThan(1000);
  expect(await scrollTop(page, b)).toBe(startB);
});
