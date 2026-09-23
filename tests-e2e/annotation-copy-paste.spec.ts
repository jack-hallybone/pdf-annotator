import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFString, rgb } from "pdf-lib";

// The annotation copied here comes from the file, so a copy that kept its source
// identity would be two in-memory annotations naming one dictionary, and a
// saved-and-reopened count is what tells a real copy from a second reference.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const TAB = ".tabbedapp-document-tab";

const HIGHLIGHT = { x1: 60, x2: 300, y1: 700, y2: 730 };
const PAGE_SIZE: [number, number] = [420, 800];

test("a copy pastes onto the page in view, and into another document", async ({
  page,
}) => {
  const file = await annotatedPdf();
  await openAnnotations(page, file);
  await expect(rows(page)).toHaveText([/page 1/]);

  await copySelectedHighlight(page);

  await page.keyboard.press("Control+v");
  await expect(rows(page)).toHaveText([/page 1/, /page 1/]);

  await goToPage(page, 2);
  await page.keyboard.press("Control+v");
  await expect(rows(page)).toHaveText([/page 1/, /page 1/, /page 2/]);

  await openInNewTab(page, file);
  await expect(rows(page)).toHaveText([/page 1/]);
  await page.keyboard.press("Control+v");
  await expect(rows(page)).toHaveText([/page 1/, /page 1/]);
});

test("a pasted annotation is an annotation of its own in the saved file", async ({
  page,
}) => {
  const file = await annotatedPdf();
  await openAnnotations(page, file);
  await copySelectedHighlight(page);

  await page.keyboard.press("Control+v");
  await goToPage(page, 2);
  await page.keyboard.press("Control+v");
  await expect(rows(page)).toHaveText([/page 1/, /page 1/, /page 2/]);

  const saved = await saveACopy(page);
  await openInNewTab(page, saved);

  await expect(rows(page)).toHaveText([/page 1/, /page 1/, /page 2/]);
});

function rows(page: Page) {
  return page.getByRole("list", { name: "Annotations" }).getByRole("listitem");
}

async function openAnnotations(page: Page, file: string) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(file);
  await expect(page.locator(TAB)).toHaveCount(1);
  await showAnnotations(page);
}

async function openInNewTab(page: Page, file: string) {
  const before = await page.locator(TAB).count();
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(file);
  await expect(page.locator(TAB)).toHaveCount(before + 1);
  await showAnnotations(page);
}

async function showAnnotations(page: Page) {
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await page.getByRole("button", { name: /show sidebar/i }).click();
  await page.getByRole("tab", { name: "Annotations" }).click();
  await expect(page.getByRole("list", { name: "Annotations" })).toBeVisible();
}

// Clicked rather than reached through a test-only hook: the copy listener only
// answers for the viewport that owns the gesture.
async function copySelectedHighlight(page: Page) {
  const box = await page
    .locator(".pdfdocumenteditor-page")
    .first()
    .boundingBox();
  if (!box) {
    throw new Error("The first page has no box to click into.");
  }

  const scale = box.width / PAGE_SIZE[0];
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.click(
    box.x + ((HIGHLIGHT.x1 + HIGHLIGHT.x2) / 2) * scale,
    box.y + (PAGE_SIZE[1] - (HIGHLIGHT.y1 + HIGHLIGHT.y2) / 2) * scale,
  );
  await expect(page.locator(".selection-delete-button")).toBeVisible();
  await page.keyboard.press("Control+c");
}

async function goToPage(page: Page, pageNumber: number) {
  const jump = page.getByRole("textbox", { name: "Page number" });
  await jump.fill(String(pageNumber));
  await jump.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector(".pdfdocumenteditor-scroll-root")?.scrollTop ??
          0,
      ),
    )
    .toBeGreaterThan(0);
  await expect(jump).toHaveValue(String(pageNumber));
}

async function saveACopy(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);
  const target = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(target);
  return target;
}

async function annotatedPdf() {
  const document = await PDFDocument.create();
  const first = document.addPage(PAGE_SIZE);
  first.drawText("One", { size: 24, x: 60, y: 600 });
  const second = document.addPage(PAGE_SIZE);
  second.drawText("Two", { size: 24, x: 60, y: 600 });
  first.drawRectangle({
    color: rgb(1, 0.9, 0.2),
    height: HIGHLIGHT.y2 - HIGHLIGHT.y1,
    opacity: 0.4,
    width: HIGHLIGHT.x2 - HIGHLIGHT.x1,
    x: HIGHLIGHT.x1,
    y: HIGHLIGHT.y1,
  });

  const { context } = document;
  const annotation = context.obj({
    C: [1, 0.9, 0.2],
    CA: 0.4,
    Contents: PDFString.of(""),
    F: 4,
    QuadPoints: [
      HIGHLIGHT.x1,
      HIGHLIGHT.y2,
      HIGHLIGHT.x2,
      HIGHLIGHT.y2,
      HIGHLIGHT.x1,
      HIGHLIGHT.y1,
      HIGHLIGHT.x2,
      HIGHLIGHT.y1,
    ],
    Rect: [HIGHLIGHT.x1, HIGHLIGHT.y1, HIGHLIGHT.x2, HIGHLIGHT.y2],
    Subtype: "Highlight",
    Type: "Annot",
  });
  first.node.set(
    PDFName.of("Annots"),
    context.obj([context.register(annotation)]),
  );

  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-clip-"));
  const path = join(directory, "annotated.pdf");
  await writeFile(path, await document.save());
  return path;
}
