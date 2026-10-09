import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Pressing Image selects the image tool for as long as its menu, or the picker one of its items opens, is up; every way out leaves Select. It used to leave whichever tool was selected before, so backing out of the menu left a pen armed.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test("backing out of the image menu leaves Select, not the tool before it", async ({
  page,
}) => {
  await openDocument(page);
  const image = page.getByRole("button", { name: "Image", exact: true });
  const menu = page.getByRole("menu");

  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  await image.click();
  await expect(menu).toBeVisible();
  await expect(image).toHaveClass(/\bselected\b/);
  await expect(toolButton(page, "Pen 1")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // A second press on Image closes the menu.
  await image.click();
  await expect(menu).toHaveCount(0);
  await expect(toolButton(page, "Select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(image).not.toHaveClass(/\bselected\b/);

  // So does a press anywhere else, and that press lands on the page as Select's, so it draws nothing.
  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  await image.click();
  await expect(menu).toBeVisible();
  const box = await page
    .locator(".pdfdocumenteditor-page")
    .first()
    .boundingBox();
  if (!box) {
    throw new Error("no page to click on");
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await expect(menu).toHaveCount(0);
  await expect(toolButton(page, "Select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("the image tool stays selected while its picker is open, then Select takes over", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Forces the hidden <input type="file"> fallback: Playwright can drive a filechooser event but not a window.showOpenFilePicker() call.
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: undefined,
    });
  });
  await openDocument(page);
  const image = page.getByRole("button", { name: "Image", exact: true });

  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  await image.click();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "From file..." }).click();
  const fileChooser = await fileChooserPromise;
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(image).toHaveClass(/\bselected\b/);

  await fileChooser.setFiles({
    buffer: await pngBytes(page),
    mimeType: "image/png",
    name: "stamp.png",
  });
  await expect(page.locator('image[href^="data:image/png"]')).toHaveCount(1);
  await expect(toolButton(page, "Select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(image).not.toHaveClass(/\bselected\b/);
});

function toolButton(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function openDocument(page: Page) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await pdfPath());
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".page-jump-control")).toBeVisible();
}

// Drawn by the page's own canvas, so the test needs no image fixture or encoder of its own.
async function pngBytes(page: Page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#c33";
    context.fillRect(0, 0, 40, 30);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

// Written here rather than committed: the page exists to have nothing on it.
async function pdfPath() {
  const document = await PDFDocument.create();
  document.addPage([420, 800]);

  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-image-"));
  const path = join(directory, "blank.pdf");
  await writeFile(path, await document.save());
  return path;
}
