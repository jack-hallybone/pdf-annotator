import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFNull, PDFString } from "pdf-lib";

// A destination with a null top, such as most /XYZ entries in a contents list, names only its page. The null used to be read as 0, the page's foot, so following it showed the next page instead.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test("a contents entry that names only its page lands on that page", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "chapters.pdf",
    mimeType: "application/pdf",
    buffer: await chaptersPdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await page.getByRole("button", { name: /show sidebar/i }).click();
  await page.getByRole("tab", { name: "Contents" }).click();
  await page.getByRole("button", { name: "Chapter two" }).click();

  await expect.poll(() => pageAtMiddleOfView(page)).toBe(1);
});

async function pageAtMiddleOfView(page: Page) {
  return page.evaluate(() => {
    const view = document
      .querySelector(".pdfdocumenteditor-scroll-root")
      ?.getBoundingClientRect();
    if (!view) {
      return null;
    }
    const middle = view.top + view.height / 2;
    const slot = [
      ...document.querySelectorAll<HTMLElement>(
        ".pdfdocumenteditor-page-slot[data-page-index]",
      ),
    ].find((element) => {
      const box = element.getBoundingClientRect();
      return box.top <= middle && middle <= box.bottom;
    });
    return slot ? Number(slot.dataset.pageIndex) : null;
  });
}

// Three pages taller than the view, so landing at a page's foot shows the next one.
async function chaptersPdf() {
  const titles = ["Chapter one", "Chapter two", "Chapter three"];
  const doc = await PDFDocument.create();
  const { context } = doc;
  const outlines = context.obj({ Type: "Outlines", Count: titles.length });
  const outlinesRef = context.register(outlines);

  const items = titles.map((title) => {
    const added = doc.addPage([420, 800]);
    added.drawText(title, { size: 24, x: 40, y: 700 });
    return context.obj({
      Title: PDFString.of(title),
      Parent: outlinesRef,
      Dest: [added.ref, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull],
    });
  });
  const refs = items.map((item) => context.register(item));
  items.forEach((item, index) => {
    if (index > 0) item.set(PDFName.of("Prev"), refs[index - 1]);
    if (index < items.length - 1) item.set(PDFName.of("Next"), refs[index + 1]);
  });
  outlines.set(PDFName.of("First"), refs[0]);
  outlines.set(PDFName.of("Last"), refs[refs.length - 1]);
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);

  return Buffer.from(await doc.save());
}
