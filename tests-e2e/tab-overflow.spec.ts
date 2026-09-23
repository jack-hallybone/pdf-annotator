import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Tabs used to stop shrinking at a 9rem floor, so the strip scrolled once
// more than a handful were open. Now the floor is just the close button's
// own footprint (see .tabbedapp-document-tab's min-width) - a reader still
// reaches and closes every tab directly, and the tab-list menu is where a
// squeezed title is read in full.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const TAB = ".tabbedapp-document-tab";
const TAB_CLOSE = ".tabbedapp-tab-close";
// --theme-control-xs (24px) + --theme-space-xs inset doubled, one on each
// side (8px) + this tab's own 1px+1px border - the close button floats over
// the title's own area (see .tabbedapp-tab-close) rather than beside it, so
// that title's padding never has to fit in this floor too.
const MIN_TAB_WIDTH = 24 + 8 + 2;

test.use({ viewport: { width: 760, height: 900 } });

test("tabs shrink well past the old readable floor rather than force the strip to scroll", async ({
  page,
}) => {
  const names = Array.from({ length: 14 }, (_, index) => `doc-${index}`);
  await openDocuments(page, await Promise.all(names.map(blankPdf)));

  const nav = page.locator(".tabbedapp-tabs");
  const [scrollWidth, clientWidth] = await nav.evaluate((el) => [
    el.scrollWidth,
    el.clientWidth,
  ]);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});

test("even squeezed far past that, a tab never shrinks below its close button, and still closes", async ({
  page,
}) => {
  const names = Array.from({ length: 40 }, (_, index) => `doc-${index}`);
  await openDocuments(page, await Promise.all(names.map(blankPdf)));

  const rects = await page.locator(TAB).evaluateAll((tabs) =>
    tabs.map((tab) => {
      const close = tab.querySelector(".tabbedapp-tab-close");
      return {
        tab: tab.getBoundingClientRect(),
        close: close?.getBoundingClientRect(),
      };
    }),
  );
  for (const { tab, close } of rects) {
    expect(tab.width).toBeGreaterThanOrEqual(MIN_TAB_WIDTH - 1);
    // The close button has to fit fully inside its own tab, not spill past
    // it - a floor sized only for the button itself let it clip through.
    expect(close!.left).toBeGreaterThanOrEqual(tab.left - 1);
    expect(close!.right).toBeLessThanOrEqual(tab.right + 1);
    // At this exact floor, with no title left to justify it, the button
    // should read as centred rather than flush against one border - a
    // floor that only doubled as the button's own trailing inset left all
    // the slack on one side.
    const leftGap = close!.left - tab.left;
    const rightGap = tab.right - close!.right;
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
  }

  const lastClose = page.locator(TAB).last().locator(TAB_CLOSE);
  await lastClose.click();
  await expect(page.locator(TAB)).toHaveCount(names.length - 1);
});

test("+ sits right after the last tab when there's room, and never touches the divider when there isn't", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const names = Array.from({ length: 3 }, (_, index) => `doc-${index}`);
  await openDocuments(page, await Promise.all(names.map(blankPdf)));

  const navBox = (await page.locator(".tabbedapp-tabs").boundingBox())!;
  const plusBox = (await page.locator(".tabbedapp-new-tab").boundingBox())!;
  // Right after the last tab, not stranded near the fixed list/save cluster
  // on the far right of a mostly-empty bar.
  expect(plusBox.x - (navBox.x + navBox.width)).toBeLessThanOrEqual(4);

  await page.setViewportSize({ width: 760, height: 900 });
  const manyNames = Array.from({ length: 20 }, (_, index) => `many-${index}`);
  await openDocuments(page, await Promise.all(manyNames.map(blankPdf)), {
    reuse: true,
  });

  const crowdedPlusBox = (await page
    .locator(".tabbedapp-new-tab")
    .boundingBox())!;
  const dividerBox = (await page
    .locator(".tabbedapp-tabbar-divider-end")
    .boundingBox())!;
  // A full strip grows nav right up to the divider's own edge - + needs its
  // own margin there, or it sits flush against (or under) that divider.
  expect(
    dividerBox.x - (crowdedPlusBox.x + crowdedPlusBox.width),
  ).toBeGreaterThanOrEqual(1);
});

test("the tab list button is always present, disabled only with no tabs open", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".tabbedapp-tab-list-toggle")).toBeDisabled();

  await openDocuments(page, [await blankPdf("only")], { reuse: true });
  await expect(page.locator(".tabbedapp-tab-list-toggle")).toBeEnabled();
});

test("the tab list menu shows every open tab and switches to the one clicked", async ({
  page,
}) => {
  const names = ["one", "two", "three", "four", "five", "six"];
  await openDocuments(page, await Promise.all(names.map(blankPdf)));

  await page.locator(".tabbedapp-tab-list-toggle").click();
  const items = page.locator(".tabbedapp-tab-list-menu-item");
  await expect(items).toHaveCount(names.length);
  for (const name of names) {
    await expect(
      page.locator(".tabbedapp-tab-list-menu-item-title", {
        hasText: `${name}.pdf`,
      }),
    ).toHaveCount(1);
  }

  // one.pdf is active on open; six.pdf is the tab furthest out of reach.
  await page
    .locator(".tabbedapp-tab-list-menu-item", { hasText: "six.pdf" })
    .click();
  await expect(
    page.locator(`${TAB}.tabbedapp-tab-button-active`, { hasText: "six.pdf" }),
  ).toHaveCount(1);
});

test("the tab list menu opens flush with its own toggle button, not left-anchored away from it", async ({
  page,
}) => {
  const names = ["one", "two", "three"];
  await openDocuments(page, await Promise.all(names.map(blankPdf)));

  const buttonBox = (await page
    .locator(".tabbedapp-tab-list-toggle")
    .boundingBox())!;
  await page.locator(".tabbedapp-tab-list-toggle").click();
  const menuBox = (await page
    .locator(".tabbedapp-tab-list-menu")
    .boundingBox())!;

  // Right-edge anchored: this button lives at the bar's own right edge, so
  // a menu narrower than its own worst-case width must not leave a gap
  // between it and the button it opened from.
  expect(
    Math.abs(buttonBox.x + buttonBox.width - (menuBox.x + menuBox.width)),
  ).toBeLessThanOrEqual(1);
});

async function openDocuments(
  page: Page,
  files: string[],
  { reuse = false }: { reuse?: boolean } = {},
) {
  if (!reuse) {
    await page.goto("/");
  }

  const before = reuse ? await page.locator(TAB).count() : 0;
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(files);
  await expect(page.locator(TAB)).toHaveCount(before + files.length);
  await expect(page.locator("canvas").first()).toBeVisible();
}

// Written here rather than committed: the pages exist to have nothing on them.
async function blankPdf(name: string) {
  const document = await PDFDocument.create();
  document.addPage([420, 800]);

  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-tabs-"));
  const path = join(directory, `${name}.pdf`);
  await writeFile(path, await document.save());
  return path;
}
