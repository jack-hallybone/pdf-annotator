import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Turning a stylus over and rubbing with its eraser end erases, whichever tool is chosen. Only the main and right buttons used to be told apart, so the eraser end drew with the pen, or picked up and moved the stroke with Select.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // A synthetic pointer is never an active one, so a real capture call throws; penEraserStroke sends every event to the element first pressed, as a capture would.
    Element.prototype.setPointerCapture = () => undefined;
  });
});

for (const tool of ["Pen 1", "Select"]) {
  test(`a stylus's eraser end erases a stroke with ${tool} chosen`, async ({
    page,
  }) => {
    await openDocument(page);
    const stroke = await strokeAcrossPage(page);

    await page.getByRole("button", { name: "Pen 1", exact: true }).click();
    await page.mouse.move(...stroke[0]);
    await page.mouse.down();
    for (const point of stroke.slice(1)) {
      await page.mouse.move(...point);
    }
    await page.mouse.up();
    await expect.poll(() => inkPixels(page)).toBeGreaterThan(0);

    await page.getByRole("button", { name: tool, exact: true }).click();
    await penEraserStroke(page, stroke);
    await expect.poll(() => inkPixels(page)).toBe(0);
    // Not picked up either: a selected stroke is drawn over the page instead of on its canvas.
    await expect(
      page.locator(".pdfdocumenteditor-interaction-layer :is(path, polyline)"),
    ).toHaveCount(0);

    // Erased, not hidden: undoing brings it back.
    await page.keyboard.press("Control+z");
    await expect.poll(() => inkPixels(page)).toBeGreaterThan(0);
  });
}

type Point = [number, number];

async function strokeAcrossPage(page: Page): Promise<Point[]> {
  const box = await page
    .locator(".pdfdocumenteditor-page")
    .first()
    .boundingBox();
  if (!box) {
    throw new Error("no page to draw on");
  }
  const y = box.y + box.height * 0.3;
  return Array.from({ length: 21 }, (_, step) => [
    box.x + box.width * (0.2 + 0.03 * step),
    y,
  ]);
}

// Pointer Events report a stylus's eraser end as button 5 when it touches, and buttons bit 32 while it stays down. No browser automation can press it, so the events are made here.
async function penEraserStroke(page: Page, stroke: Point[]) {
  await page.evaluate((points) => {
    const [first] = points;
    const target = document.elementFromPoint(first[0], first[1]);
    if (!target) {
      throw new Error("nothing under the eraser");
    }
    const send = (
      type: string,
      [clientX, clientY]: [number, number],
      button: number,
      buttons: number,
    ) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 7,
          pointerType: "pen",
          isPrimary: true,
          pressure: buttons ? 0.5 : 0,
          clientX,
          clientY,
          button,
          buttons,
        }),
      );
    send("pointerdown", first, 5, 32);
    for (const point of points.slice(1)) {
      send("pointermove", point, -1, 32);
    }
    send("pointerup", points.at(-1) ?? first, 5, 0);
  }, stroke);
}

// The annotation canvases only, never the page canvas.
function inkPixels(page: Page) {
  return page
    .locator(".pdfdocumenteditor-ink-canvas-layer")
    .evaluateAll((canvases) => {
      let ink = 0;
      for (const element of canvases as HTMLCanvasElement[]) {
        if (element.width === 0 || element.height === 0) continue;
        const context = element.getContext("2d", {
          willReadFrequently: true,
        });
        if (!context) continue;
        const { data } = context.getImageData(
          0,
          0,
          element.width,
          element.height,
        );
        for (let at = 3; at < data.length; at += 4) {
          if (data[at] > 8) ink += 1;
        }
      }
      return ink;
    });
}

async function openDocument(page: Page) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await pdfPath());
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".page-jump-control")).toBeVisible();
}

// Written here rather than committed: the page exists to have nothing on it.
async function pdfPath() {
  const document = await PDFDocument.create();
  document.addPage([420, 800]);

  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-eraser-"));
  const path = join(directory, "blank.pdf");
  await writeFile(path, await document.save());
  return path;
}
