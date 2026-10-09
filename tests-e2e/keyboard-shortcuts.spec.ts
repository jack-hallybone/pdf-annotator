import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Redo used to have two bindings that both undid: Ctrl+Z ignored Shift, so Ctrl+Shift+Z matched it before ever reaching the Ctrl+Y branch below.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const TAB = ".tabbedapp-document-tab";

test("Ctrl+Z undoes, and Ctrl+Shift+Z redoes rather than undoing again", async ({
  page,
}) => {
  await openDocument(page);
  await drawStroke(page);

  const undoButton = page.getByRole("button", { name: "Undo" });
  const redoButton = page.getByRole("button", { name: "Redo" });
  await expect(undoButton).toBeEnabled();
  await expect(redoButton).toBeDisabled();

  await page.keyboard.press("Control+z");
  await expect(undoButton).toBeDisabled();
  await expect(redoButton).toBeEnabled();

  await page.keyboard.press("Control+Shift+z");
  await expect(undoButton).toBeEnabled();
  await expect(redoButton).toBeDisabled();
});

test("Ctrl+Y also redoes", async ({ page }) => {
  await openDocument(page);
  await drawStroke(page);

  const undoButton = page.getByRole("button", { name: "Undo" });
  const redoButton = page.getByRole("button", { name: "Redo" });

  await page.keyboard.press("Control+z");
  await expect(redoButton).toBeEnabled();

  await page.keyboard.press("Control+y");
  await expect(undoButton).toBeEnabled();
  await expect(redoButton).toBeDisabled();
});

// A Mac keyboard's delete key sends Backspace, so with only Delete bound a Mac had no key that deleted a mark.
test("Backspace deletes the selected mark, as Delete does", async ({
  page,
}) => {
  await openDocument(page);
  const onStroke = await drawStroke(page);
  // A selected stroke leaves the ink canvas and is drawn over the page, with its handles, until it is let go.
  const overlay = page.locator(
    ".pdfdocumenteditor-interaction-layer :is(path, polyline)",
  );
  await page.mouse.click(...onStroke);
  await expect(overlay.first()).toBeVisible();

  await page.keyboard.press("Backspace");
  await expect(overlay).toHaveCount(0);
  expect(await inkPixels(page)).toBe(0);

  // Gone, not hidden: undoing brings it back.
  await page.keyboard.press("Control+z");
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(0);
});

test("Ctrl+O opens the same file picker as the Open PDFs button", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Forces the hidden <input type="file"> fallback: Playwright can drive a filechooser event but not a window.showOpenFilePicker() call.
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: undefined,
    });
  });

  // Listened for before goto(): started just before the key press, Playwright's file-chooser interception could still be switching on when a slow page opened the picker.
  const fileChooserPromise = page.waitForEvent("filechooser");

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open PDFs" })).toBeVisible();

  await page.keyboard.press("Control+o");
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(await pdfPath("via-ctrl-o"));

  await expect(page.locator(TAB)).toHaveCount(1);
  await expect(page.locator("canvas").first()).toBeVisible();
});

async function openDocument(page: Page) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await pdfPath("only"));
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".page-jump-control")).toBeVisible();
}

async function drawStroke(page: Page) {
  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  const box = await page
    .locator(".pdfdocumenteditor-page")
    .first()
    .boundingBox();
  if (!box) {
    throw new Error("no page to draw on");
  }

  const y = box.y + box.height * 0.2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y + 40, { steps: 20 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  // Halfway along the stroke, so a click there lands on it.
  return [box.x + box.width * 0.5, y + 20] as const;
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

// Written here rather than committed: the page exists to have nothing on it.
async function pdfPath(name: string) {
  const document = await PDFDocument.create();
  document.addPage([420, 800]);

  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-keys-"));
  const path = join(directory, `${name}.pdf`);
  await writeFile(path, await document.save());
  return path;
}
