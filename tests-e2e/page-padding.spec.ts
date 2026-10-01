import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// The scroll container's side padding is meant to give the floating dock a
// clear strip while a page has room to spare, but never to cost more than the
// bare top/between-page gap once the page itself needs that room instead -
// see --app-page-gutter-inline in pdfdocumenteditor/styles.css.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const A4 = [595, 842] as const;

async function pdfFixture(size: readonly [number, number] = A4) {
  const doc = await PDFDocument.create();
  doc.addPage([...size]);
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-padding-"));
  const path = join(directory, "one-page.pdf");
  await writeFile(path, await doc.save());
  return path;
}

async function openFixture(page: Page, size?: readonly [number, number]) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await pdfFixture(size));
  await expect(page.locator(".pdfdocumenteditor-page-frame")).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(400);
}

function readScrollRootGeometry(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      ".pdfdocumenteditor-scroll-root",
    );
    if (!root) {
      throw new Error("no scroll container");
    }
    const style = getComputedStyle(root);
    return {
      paddingLeft: parseFloat(style.paddingLeft),
      paddingRight: parseFloat(style.paddingRight),
      paddingTop: parseFloat(style.paddingTop),
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    };
  });
}

test.describe("the page column's side padding tracks how much room the page has", () => {
  test("matches the top/between-page gap once the page is wider than the window", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 480 });
    await openFixture(page);

    const geometry = await readScrollRootGeometry(page);
    expect(
      geometry.scrollWidth,
      "the page must actually overflow for this case to mean anything",
    ).toBeGreaterThan(geometry.clientWidth);
    expect(geometry.paddingLeft).toBeCloseTo(geometry.paddingTop, 0);
    expect(geometry.paddingRight).toBeCloseTo(geometry.paddingTop, 0);
    // Still symmetric, so the page stays centred rather than drifting to one side.
    expect(geometry.paddingLeft).toBeCloseTo(geometry.paddingRight, 0);
  });

  test("keeps the full dock clearance while the page comfortably fits", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openFixture(page);

    const geometry = await readScrollRootGeometry(page);
    expect(
      geometry.scrollWidth,
      "the page must fit for this case to mean anything",
    ).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.paddingLeft).toBeCloseTo(geometry.paddingRight, 0);
    expect(
      geometry.paddingLeft,
      "the full dock clearance should still be reserved when there is room for it",
    ).toBeGreaterThan(geometry.paddingTop + 8);
  });

  test("shrinks live as the window narrows past the page, with no zoom change", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openFixture(page);
    const wide = await readScrollRootGeometry(page);
    expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth + 1);

    await page.setViewportSize({ height: 800, width: 480 });
    await expect
      .poll(async () => (await readScrollRootGeometry(page)).paddingLeft)
      .toBeLessThan(wide.paddingLeft);

    const narrow = await readScrollRootGeometry(page);
    expect(narrow.paddingLeft).toBeCloseTo(narrow.paddingTop, 0);
  });
});
