import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// A text selection can run on over a page break, but an annotation lives on one page. Highlighting it used to mark only the page whose button was pressed, while storing the whole selection, both pages' text, as that one highlight's quote.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("a selection over a page break highlights each page with its own text, as one undo step", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "two-pages.pdf",
    mimeType: "application/pdf",
    buffer: await twoPagePdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await selectOverThePageBreak(page);

  await page
    .getByRole("button", { name: "Highlight selection" })
    .first()
    .click();

  // Copy text reads back the text under a highlight, so it shows each page's highlight covers that page's part of the selection and no more.
  for (const [pageIndex, line, covered] of [
    [0, "First page line three", "line two\nFirst page line three"],
    [1, "Second page line one", "Second page line one\nSecond"],
  ] as const) {
    await clickHighlightOver(page, pageIndex, line);
    await page.getByRole("button", { name: "Copy text" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(covered);
  }

  await page.getByRole("button", { name: /show sidebar/i }).click();
  await page.getByRole("tab", { name: "Annotations" }).click();
  const rows = page.locator(".annotation-row");
  await expect(rows.locator(".annotation-row-meta")).toHaveText([
    "Highlight · page 1",
    "Highlight · page 2",
  ]);
  await expect(rows.locator(".annotation-row-quote")).toHaveText([
    "line two First page line three",
    "Second page line one Second",
  ]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".annotations-empty")).toHaveText("No annotations");
});

function textLine(page: Page, pageIndex: number, text: string) {
  return page
    .locator(`[data-page-index="${pageIndex}"] .textLayer span`)
    .filter({ hasText: text });
}

// The highlight drawn over a line takes a click on it, and the click selects it.
async function clickHighlightOver(page: Page, pageIndex: number, text: string) {
  const box = await textLine(page, pageIndex, text).boundingBox();
  if (!box) {
    throw new Error(`"${text}" is not on screen.`);
  }

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// From the middle of page 1's second line to the middle of page 2's second line, with the page break in the middle of the view so both text layers are drawn. Set in code, not dragged, so where it starts and ends is exact.
async function selectOverThePageBreak(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      ".pdfdocumenteditor-scroll-root",
    );
    const second = root?.querySelector<HTMLElement>('[data-page-index="1"]');
    if (root && second) {
      root.scrollTop +=
        second.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        root.clientHeight / 2;
    }
  });
  await expect(textLine(page, 0, "First page line two")).toHaveCount(1);
  await expect(textLine(page, 1, "Second page line two")).toHaveCount(1);

  await page.evaluate(() => {
    const textOf = (pageIndex: number, text: string) =>
      [
        ...document.querySelectorAll(
          `[data-page-index="${pageIndex}"] .textLayer span`,
        ),
      ].find((span) => span.textContent === text)?.firstChild;
    const start = textOf(0, "First page line two");
    const end = textOf(1, "Second page line two");
    if (!start || !end) {
      return;
    }

    const range = document.createRange();
    range.setStart(start, "First page ".length);
    range.setEnd(end, "Second".length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
}

// Short pages, so the foot of page 1 and the head of page 2 fit in the view together.
async function twoPagePdf() {
  const doc = await PDFDocument.create();
  const first = doc.addPage([420, 300]);
  first.drawText("First page line one", { size: 14, x: 40, y: 120 });
  first.drawText("First page line two", { size: 14, x: 40, y: 90 });
  first.drawText("First page line three", { size: 14, x: 40, y: 60 });
  const second = doc.addPage([420, 300]);
  second.drawText("Second page line one", { size: 14, x: 40, y: 240 });
  second.drawText("Second page line two", { size: 14, x: 40, y: 210 });
  return Buffer.from(await doc.save());
}
