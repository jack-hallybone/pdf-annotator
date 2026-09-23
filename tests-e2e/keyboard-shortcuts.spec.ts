import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Redo used to have two bindings that both undid: Ctrl+Z ignored Shift, so
// Ctrl+Shift+Z matched it before ever reaching the Ctrl+Y branch below.

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

test("Ctrl+O opens the same file picker as the Open PDFs button", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Forces the hidden <input type="file"> fallback: Playwright can drive a
    // filechooser event but not a window.showOpenFilePicker() call.
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open PDFs" })).toBeVisible();

  const fileChooserPromise = page.waitForEvent("filechooser");
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
