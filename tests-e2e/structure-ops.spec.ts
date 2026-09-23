import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Page-structure regression net: every case checks the outcome twice - what the
// app shows, and what pdf-lib finds in the bytes it writes - so a pipeline that
// updates one without the other cannot pass.

const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/test-annotated.pdf", import.meta.url),
);

// Playwright cannot drive the File System Access picker; the shell's hidden
// input fires the same open path.
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

// Every wait below is on a full document reload - reparse, re-render, thumbnail
// re-raster - so these are seconds-scale where the rest of the suite is
// milliseconds.
const RELOAD_TIMEOUT_MS = 45_000;

test.describe.configure({ timeout: 180_000 });

async function openFixture(page: Page) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(fixturePath);
  await expect(page.locator("canvas").first()).toBeVisible();
}

type DocumentShape = {
  pageCount: number;
  rotations: number[];
};

function shapeOf(doc: PDFDocument): DocumentShape {
  return {
    pageCount: doc.getPageCount(),
    rotations: doc.getPages().map((docPage) => docPage.getRotation().angle),
  };
}

async function fixtureShape() {
  return shapeOf(await PDFDocument.load(await readFile(fixturePath)));
}

async function downloadedShape(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);

  return shapeOf(await PDFDocument.load(await readFile(await download.path())));
}

function pageThumbnails(page: Page) {
  return page.getByRole("button", { name: /^Page \d+$/ });
}

function menuItem(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

function historyButton(page: Page, name: "Redo" | "Undo") {
  return page.getByRole("button", { name, exact: true });
}

async function openPagesSidebar(page: Page) {
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(pageThumbnails(page).first()).toBeVisible();
}

async function openPageMenu(page: Page, pageNumber: number) {
  await page
    .getByRole("button", { name: `Actions for page ${pageNumber}` })
    .click();
  await expect(menuItem(page, "Delete page")).toBeVisible();
}

async function rotatePage(page: Page, pageNumber: number) {
  await openPageMenu(page, pageNumber);
  await menuItem(page, "Rotate").click();
}

async function addBlankPageAfter(page: Page, pageNumber: number) {
  await openPageMenu(page, pageNumber);
  await menuItem(page, "Add blank after").click();
}

async function deletePage(page: Page, pageNumber: number) {
  await openPageMenu(page, pageNumber);
  await menuItem(page, "Delete page").click();
}

async function expectThumbnailLandscape(page: Page, pageNumber: number) {
  const preview = page
    .locator(".page-thumbnail")
    .nth(pageNumber - 1)
    .locator(".page-thumbnail-preview");

  await expect
    .poll(
      async () => {
        const box = await preview.boundingBox();
        return box ? box.width > box.height : false;
      },
      { timeout: RELOAD_TIMEOUT_MS },
    )
    .toBe(true);
}

// "Delete page" stays disabled at a page count of one, so every test grows the
// fixture first, and rotating page 1 first gives it an identity the
// delete/undo/redo assertions can follow.
async function growDocument(page: Page): Promise<DocumentShape> {
  const fixture = await fixtureShape();
  expect(fixture.pageCount).toBe(1);

  await openPagesSidebar(page);
  await expect(pageThumbnails(page)).toHaveCount(fixture.pageCount, {
    timeout: RELOAD_TIMEOUT_MS,
  });
  await expect(historyButton(page, "Undo")).toBeDisabled();

  await rotatePage(page, 1);
  await expectThumbnailLandscape(page, 1);

  await addBlankPageAfter(page, 1);
  await expect(pageThumbnails(page)).toHaveCount(fixture.pageCount + 1, {
    timeout: RELOAD_TIMEOUT_MS,
  });
  await addBlankPageAfter(page, 2);
  await expect(pageThumbnails(page)).toHaveCount(fixture.pageCount + 2, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  return {
    pageCount: fixture.pageCount + 2,
    rotations: [(fixture.rotations[0] + 90) % 360, 0, 0],
  };
}

function afterDeletingFirstPage(grown: DocumentShape): DocumentShape {
  return {
    pageCount: grown.pageCount - 1,
    rotations: grown.rotations.slice(1),
  };
}

test("rotate, add and delete survive a download round trip", async ({
  page,
}) => {
  await openFixture(page);
  const grown = await growDocument(page);

  expect(await downloadedShape(page)).toEqual(grown);

  await deletePage(page, 1);
  await expect(pageThumbnails(page)).toHaveCount(grown.pageCount - 1, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  expect(await downloadedShape(page)).toEqual(afterDeletingFirstPage(grown));
});

test("undo restores a deleted page and its bytes", async ({ page }) => {
  await openFixture(page);
  const grown = await growDocument(page);

  await deletePage(page, 1);
  await expect(pageThumbnails(page)).toHaveCount(grown.pageCount - 1, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  await historyButton(page, "Undo").click();
  await expect(pageThumbnails(page)).toHaveCount(grown.pageCount, {
    timeout: RELOAD_TIMEOUT_MS,
  });
  await expectThumbnailLandscape(page, 1);

  expect(await downloadedShape(page)).toEqual(grown);
});

test("redo re-applies the deletion", async ({ page }) => {
  await openFixture(page);
  const grown = await growDocument(page);

  await deletePage(page, 1);
  await expect(pageThumbnails(page)).toHaveCount(grown.pageCount - 1, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  await historyButton(page, "Undo").click();
  await expect(pageThumbnails(page)).toHaveCount(grown.pageCount, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  await historyButton(page, "Redo").click();
  await expect(pageThumbnails(page)).toHaveCount(grown.pageCount - 1, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  expect(await downloadedShape(page)).toEqual(afterDeletingFirstPage(grown));
});

test("editing an annotation on a page an undo restored still downloads", async ({
  page,
}) => {
  await openFixture(page);
  const fixture = await fixtureShape();

  await openPagesSidebar(page);
  await addBlankPageAfter(page, 1);
  await expect(pageThumbnails(page)).toHaveCount(fixture.pageCount + 1, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  await deletePage(page, 1);
  await expect(pageThumbnails(page)).toHaveCount(fixture.pageCount, {
    timeout: RELOAD_TIMEOUT_MS,
  });
  await historyButton(page, "Undo").click();
  await expect(pageThumbnails(page)).toHaveCount(fixture.pageCount + 1, {
    timeout: RELOAD_TIMEOUT_MS,
  });

  await page.getByRole("tab", { name: "Annotations" }).click();
  const highlightRow = page.locator(".annotation-row", {
    has: page.locator(".annotation-row-meta", { hasText: "Highlight" }),
  });
  await expect(highlightRow.first()).toBeVisible({
    timeout: RELOAD_TIMEOUT_MS,
  });
  await highlightRow.first().locator(".annotation-row-open").click();
  const editor = page.getByRole("textbox", { name: "Comment" });
  await expect(editor).toBeVisible();
  await editor.fill("edited after the undo");
  await editor.blur();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);
  const written = await PDFDocument.load(await readFile(await download.path()));
  expect(written.getPageCount()).toBe(fixture.pageCount + 1);
  expect(await page.locator(".tabbedapp-notice").count()).toBe(0);
});
