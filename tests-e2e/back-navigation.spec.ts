import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFNull } from "pdf-lib";

// Back retraces jumps - a link, a page number - each to the exact position it left, including one taken with the foot of the page before still in view, where the page in view is not the page the view starts on.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const TAB = ".tabbedapp-document-tab";
const SCROLL_ROOT = ".pdfdocumenteditor-scroll-root";

test("each Back returns to the exact view the jump before it left", async ({
  page,
}) => {
  await openDocument(page, "citing.pdf", await citingPdf());
  const reading = await readAcrossPagesOneAndTwo(page);

  await page.locator('[data-page-index="1"] .annotationLayer a').click();
  await expect(backButton(page, 2)).toBeVisible();
  await expect(pageNumber(page)).toHaveValue("5");

  await jumpToPage(page, 3);
  await expect(backButton(page, 5)).toBeVisible();

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(pageNumber(page)).toHaveValue("5");
  await expect(backButton(page, 2)).toBeVisible();

  await backButton(page, 2).click();
  await expect
    .poll(async () => Math.abs((await scrollTop(page)) - reading))
    .toBeLessThanOrEqual(1);
  await expect(page.locator(".back-control")).toHaveCount(0);
});

test("Cmd+[ goes back too, and a jump that moves nothing leaves no step", async ({
  page,
}) => {
  await openDocument(page, "citing.pdf", await citingPdf());

  // Already on page 1, so this jump goes nowhere.
  await jumpToPage(page, 1);
  await jumpToPage(page, 4);
  await expect(backButton(page, 1)).toBeVisible();

  await page.keyboard.press("Meta+BracketLeft");
  await expect.poll(() => scrollTop(page)).toBe(0);
  await expect(page.locator(".back-control")).toHaveCount(0);
});

test("Back outlives a switch to another tab, and a page operation clears it", async ({
  page,
}) => {
  await openDocument(page, "citing.pdf", await citingPdf());
  await jumpToPage(page, 4);
  await expect(backButton(page, 1)).toBeVisible();

  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "other.pdf",
    mimeType: "application/pdf",
    buffer: await otherPdf(),
  });
  await expect(page.locator(TAB)).toHaveCount(2);
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await expect(page.locator(".back-control")).toHaveCount(0);

  await page.locator(`${TAB} .tabbedapp-tab-main[title="citing.pdf"]`).click();
  await expect(backButton(page, 1)).toBeVisible();
  await backButton(page, 1).click();
  await expect.poll(() => scrollTop(page)).toBe(0);

  // A page operation renumbers the pages Back would name.
  await jumpToPage(page, 4);
  await expect(backButton(page, 1)).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.getByRole("button", { name: "Actions for page 4" }).click();
  await page.getByRole("button", { name: "Rotate", exact: true }).click();
  await expect(page.locator(".back-control")).toHaveCount(0, {
    timeout: 45_000,
  });
});

function backButton(page: Page, pageNumber: number) {
  return page.getByRole("button", { name: `Back to page ${pageNumber}` });
}

function pageNumber(page: Page) {
  return page.getByRole("textbox", { name: "Page number" });
}

async function openDocument(page: Page, name: string, buffer: Buffer) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer,
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();
}

async function jumpToPage(page: Page, target: number) {
  await pageNumber(page).fill(String(target));
  await pageNumber(page).press("Enter");
  await expect(pageNumber(page)).toHaveValue(String(target));
}

async function scrollTop(page: Page) {
  return page.evaluate(
    (selector) => document.querySelector(selector)?.scrollTop ?? -1,
    SCROLL_ROOT,
  );
}

// Page 2's top 40% of the way down the view: page 2 is the page in view, and the view starts on page 1.
async function readAcrossPagesOneAndTwo(page: Page) {
  const top = await page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    const slot = root?.querySelector<HTMLElement>('[data-page-index="1"]');
    if (!root || !slot) {
      return -1;
    }

    root.scrollTop +=
      slot.getBoundingClientRect().top -
      root.getBoundingClientRect().top -
      root.clientHeight * 0.4;
    return root.scrollTop;
  }, SCROLL_ROOT);
  await expect(pageNumber(page)).toHaveValue("2");
  return top;
}

// Six pages taller than the view, with a citation near the top of page 2 that links to the references on page 5.
async function citingPdf() {
  const doc = await PDFDocument.create();
  const pages = Array.from({ length: 6 }, (_, index) => {
    const added = doc.addPage([420, 800]);
    added.drawText(`Page ${index + 1}`, { size: 24, x: 40, y: 740 });
    return added;
  });
  const citation = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [40, 690, 260, 712],
    Border: [0, 0, 0],
    Dest: [pages[4].ref, PDFName.of("XYZ"), PDFNull, 500, PDFNull],
  });
  pages[1].node.set(
    PDFName.of("Annots"),
    doc.context.obj([doc.context.register(citation)]),
  );
  return Buffer.from(await doc.save());
}

async function otherPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([420, 800]).drawText("Other", { size: 24, x: 40, y: 740 });
  return Buffer.from(await doc.save());
}
