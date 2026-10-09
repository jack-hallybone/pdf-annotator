import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Two document panes over the same file would look identical and be two copies, so the proof is a mark drawn in one panel appearing in the other panel's pixels, and a scroll position one keeps while the other moves.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const TAB = ".tabbedapp-document-tab";
const VIEW = ".pdfdocumenteditor";

// Sampled small and composited onto white, as smoke.spec.ts does: a blank page is one colour and no ink, so the stroke is the only thing that moves these.
const SAMPLE_WIDTH = 300;

test("splitting the only open tab shows one document in both panels", async ({
  page,
}) => {
  await openDocuments(page, [await blankPdf("only")]);
  await splitFromTab(page, 0, "Split Right");

  const [left, right] = [page.locator(VIEW).nth(0), page.locator(VIEW).nth(1)];
  await expect(page.locator(VIEW)).toHaveCount(2);
  await expectSideBySide(left, right);

  expect(await inkPixels(right)).toBe(0);

  await drawInkIn(page, left);

  // One model, two viewports - not one document copied.
  await expect.poll(() => inkPixels(right)).toBeGreaterThan(0);

  const leftScrollBefore = await scrollTop(left);
  await scrollBy(right, 400);
  await expect.poll(() => scrollTop(right)).toBeGreaterThan(leftScrollBefore);
  expect(await scrollTop(left)).toBe(leftScrollBefore);
});

test("the mirrored split's own resizer changes each pane's share", async ({
  page,
}) => {
  await openDocuments(page, [await blankPdf("only")]);
  await splitFromTab(page, 0, "Split Right");
  await page.locator(VIEW).nth(1).locator("canvas").first().waitFor();

  const resizer = page.locator(".pdfdocumenteditor-split-resizer");
  const before = await resizer.boundingBox();
  if (!before) {
    throw new Error("no resizer to drag");
  }

  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(before.x + 220, before.y + before.height / 2, {
    steps: 10,
  });
  await page.mouse.up();

  const [left, right] = await Promise.all([
    page.locator(VIEW).nth(0).boundingBox(),
    page.locator(VIEW).nth(1).boundingBox(),
  ]);
  if (!left || !right) {
    throw new Error("a pane has no box");
  }

  expect(left.width).toBeGreaterThan(right.width + 150);
});

test("the mirrored split's resizer is keyboard operable and reports its position", async ({
  page,
}) => {
  await openDocuments(page, [await blankPdf("only")]);
  await splitFromTab(page, 0, "Split Right");

  const resizer = page.locator(".pdfdocumenteditor-split-resizer");
  await expect(resizer).toHaveAttribute("aria-valuenow", "50");

  await resizer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizer).toHaveAttribute("aria-valuenow", "55");

  await page.keyboard.press("End");
  await expect(resizer).toHaveAttribute("aria-valuenow", "80");
});

test("re-picking a direction on the mirrored split changes its layout too", async ({
  page,
}) => {
  await openDocuments(page, [await blankPdf("only")]);
  await splitFromTab(page, 0, "Split Right");
  await splitFromTab(page, 0, "Split Down");

  const [top, bottom] = [page.locator(VIEW).nth(0), page.locator(VIEW).nth(1)];
  const [topBox, bottomBox] = await Promise.all([
    top.boundingBox(),
    bottom.boundingBox(),
  ]);
  if (!topBox || !bottomBox) {
    throw new Error("a pane has no box");
  }

  expect(bottomBox.y).toBeGreaterThan(topBox.y + topBox.height / 2);
});

test("splitting a background tab puts that document beside the active one, with no extra click", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await expect(page.locator(TAB)).toHaveCount(2);

  // Tab 0 (first.pdf) is active; splitting tab 1 from its own context menu should not need a follow-up click to place it - that was the whole point.
  await splitFromTab(page, 1, "Split Right");
  await expect(page.locator(".tabbedapp-document")).toHaveCount(2);
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(2);
  await expect(page.locator(`${TAB}.tabbedapp-tab-button-active`)).toHaveCount(
    2,
  );
  await expectSideBySide(
    page.locator(".tabbedapp-panel").nth(0),
    page.locator(".tabbedapp-panel").nth(1),
  );

  await page.getByRole("button", { name: "Close split view" }).click();
  await expect(page.locator(".tabbedapp-document")).toHaveCount(1);
  await expect(page.locator(TAB)).toHaveCount(2);
});

test("the second header names whichever document is in that panel", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
    await blankPdf("third"),
  ]);

  await splitFromTab(page, 1, "Split Right");
  await expect(page.locator(".tabbedapp-second-header-title")).toHaveText(
    "second.pdf",
  );

  // Swapping the secondary document updates the name it carries.
  await splitFromTab(page, 2, "Split Right");
  await expect(page.locator(".tabbedapp-second-header-title")).toHaveText(
    "third.pdf",
  );

  await page.getByRole("button", { name: "Close split view" }).click();
  await splitFromTab(page, 1, "Split Down");
  await expect(page.locator(".tabbedapp-second-header-title")).toHaveText(
    "second.pdf",
  );
});

test("a tab can still be moved into either panel once split", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);

  await splitFromTab(page, 0, "Split Right");
  await expect(page.locator(".tabbedapp-document")).toHaveCount(1);

  await page.locator(TAB).nth(1).getByRole("button").first().click();
  await expect(page.locator(".tabbedapp-document")).toHaveCount(2);
});

test("splitting a third tab swaps out the previous secondary document", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
    await blankPdf("third"),
  ]);

  await splitFromTab(page, 1, "Split Right"); // first.pdf + second.pdf
  await expect(page.locator(".tabbedapp-document")).toHaveCount(2);

  // Ink drawn in the outgoing panel is unsaved model state that a swap must hand back to the shared document, or it is gone the moment the panel holding it unmounts - not merely hidden until the tab is reselected.
  await drawInkIn(page, page.locator(".tabbedapp-panel").nth(1));
  await expect.poll(() => inkPixels(page.locator("body"))).toBeGreaterThan(0);

  // The menu item is never hidden just because a split is already open - it swaps the secondary document instead of doing nothing.
  await splitFromTab(page, 2, "Split Right"); // first.pdf + third.pdf
  await expect(page.locator(".tabbedapp-document")).toHaveCount(2);
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(2);
  await expect(activeTab(page, "first.pdf")).toHaveCount(1);
  await expect(activeTab(page, "third.pdf")).toHaveCount(1);
  await expect(activeTab(page, "second.pdf")).toHaveCount(0);

  // Bring second.pdf back and confirm the stroke it carried is still there.
  await page.locator(TAB).nth(1).getByRole("button").first().click();
  await waitForShellSettled(page);
  await expect.poll(() => inkPixels(page.locator("body"))).toBeGreaterThan(0);
});

test("re-picking a direction on the same split changes the layout without closing it", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);

  await splitFromTab(page, 1, "Split Right");
  await splitFromTab(page, 1, "Split Down");
  await expect(page.locator(".tabbedapp-document")).toHaveCount(2);
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(2);

  const [top, bottom] = [
    page.locator(".tabbedapp-panel").nth(0),
    page.locator(".tabbedapp-panel").nth(1),
  ];
  const [topBox, bottomBox] = await Promise.all([
    top.boundingBox(),
    bottom.boundingBox(),
  ]);
  if (!topBox || !bottomBox) {
    throw new Error("a panel has no box");
  }

  expect(bottomBox.y).toBeGreaterThan(topBox.y + topBox.height / 2);
});

test("dragging the resizer changes each panel's share, in step with the header split above it", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right");
  await page.locator(".tabbedapp-panel canvas").nth(1).waitFor();

  const resizer = page.locator(".tabbedapp-panel-resizer");
  const before = await resizer.boundingBox();
  if (!before) {
    throw new Error("no resizer to drag");
  }

  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(before.x + 220, before.y + before.height / 2, {
    steps: 10,
  });
  await page.mouse.up();

  const [leftPanel, rightPanel, tabbar, secondHeader] = await Promise.all([
    page.locator(".tabbedapp-panel").nth(0).boundingBox(),
    page.locator(".tabbedapp-panel").nth(1).boundingBox(),
    page.locator(".tabbedapp-tabbar").boundingBox(),
    page.locator(".tabbedapp-second-header").boundingBox(),
  ]);
  if (!leftPanel || !rightPanel || !tabbar || !secondHeader) {
    throw new Error("missing a box after dragging");
  }

  // Moved right by ~220px, not merely moved at all - and the header row narrowed by the same amount, because one ratio drives both. Allow for the resizer's own width, which the panels give up and the header does not.
  expect(leftPanel.width).toBeGreaterThan(rightPanel.width + 150);
  expect(Math.abs(leftPanel.width - tabbar.width)).toBeLessThanOrEqual(5);
  expect(Math.abs(rightPanel.width - secondHeader.width)).toBeLessThanOrEqual(
    5,
  );
});

test("the resizer is keyboard operable and reports its position", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right");

  const resizer = page.locator(".tabbedapp-panel-resizer");
  await expect(resizer).toHaveAttribute("aria-valuenow", "50");

  await resizer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizer).toHaveAttribute("aria-valuenow", "55");

  await page.keyboard.press("End");
  await expect(resizer).toHaveAttribute("aria-valuenow", "80");

  await page.keyboard.press("Home");
  await expect(resizer).toHaveAttribute("aria-valuenow", "20");

  // Clamped, not merely slow to grow: further shrinking does nothing more.
  await page.keyboard.press("ArrowLeft");
  await expect(resizer).toHaveAttribute("aria-valuenow", "20");
});

test("closing a column split works from its own second header", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Down");
  await expect(page.locator(".tabbedapp-document")).toHaveCount(2);

  await page.getByRole("button", { name: "Close split view" }).click();
  await expect(page.locator(".tabbedapp-document")).toHaveCount(1);
});

test("closing the secondary panel's own tab collapses split view instead of leaving it stuck open", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right"); // first.pdf + second.pdf
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(2);

  // Close the secondary panel's own tab directly (its own [x] button, not the dedicated Close Split button) - this used to leave splitView on with a secondaryDocumentId naming a tab that no longer exists, so the shell rendered as a single pane while still internally flagged split.
  await page.getByRole("button", { name: "Close second.pdf" }).click();
  await waitForShellSettled(page);

  await expect(page.locator(TAB)).toHaveCount(1);
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Close split view" }),
  ).toHaveCount(0);
});

// Collapsing the split moves the document that stays out of its panel's markup, which remounts it from its tab's record: whatever it holds that the record does not is lost, unless the close captures it first.
test("closing the second panel's tab keeps the unsaved edits of the document that stays", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right"); // first.pdf + second.pdf
  await drawInkIn(page, page.locator(".tabbedapp-panel").nth(0));
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);

  await page.getByRole("button", { name: "Close second.pdf" }).click();
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(0);
  await waitForShellSettled(page);

  await expect.poll(() => inkPixels(page.locator(VIEW))).toBeGreaterThan(0);
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);
});

test("closing the left tab keeps the unsaved edits of the second-panel document that takes its place", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right"); // first.pdf + second.pdf
  await drawInkIn(page, page.locator(".tabbedapp-panel").nth(1));
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);

  // Its right-hand neighbour becomes the active tab, so second.pdf now fills both panels.
  await page.getByRole("button", { name: "Close first.pdf" }).click();
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(0);
  await expect(page.locator(VIEW)).toHaveCount(2);
  await waitForShellSettled(page);

  await expect
    .poll(() => inkPixels(page.locator(VIEW).first()))
    .toBeGreaterThan(0);
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);
});

// The opened file takes the left panel only; the right keeps its document on screen, and so must keep what that document renders with.
test("opening a file during a two-document split leaves the second panel showing its pages", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right"); // first.pdf + second.pdf
  const right = page.locator(".tabbedapp-panel").nth(1);
  await expect(
    right.locator(".pdfdocumenteditor-page canvas").first(),
  ).toBeVisible();

  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await blankPdf("third"));
  await expect(activeTab(page, "third.pdf")).toHaveCount(1);
  await waitForShellSettled(page);

  await expect(page.locator(".tabbedapp-second-header-title")).toHaveText(
    "second.pdf",
  );
  await expect(right.locator(".loading-overlay")).toHaveCount(0);
  await expect(
    right.locator(".pdfdocumenteditor-page canvas").first(),
  ).toBeVisible();
});

test("split down stacks the panels instead of placing them side by side", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);

  await splitFromTab(page, 1, "Split Down");
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(2);

  const [top, bottom] = [
    page.locator(".tabbedapp-panel").nth(0),
    page.locator(".tabbedapp-panel").nth(1),
  ];
  const [topBox, bottomBox] = await Promise.all([
    top.boundingBox(),
    bottom.boundingBox(),
  ]);
  if (!topBox || !bottomBox) {
    throw new Error("a panel has no box");
  }

  expect(bottomBox.y).toBeGreaterThan(topBox.y + topBox.height / 2);
  expect(Math.abs(topBox.width - bottomBox.width)).toBeLessThanOrEqual(2);
});

// Ctrl+S has one shared "which document" resolution feeding both the save and the print command, so this alone also stands for Ctrl+P.
test("Ctrl+S in split view saves whichever panel has focus, not always the left one", async ({
  page,
}) => {
  await stubSaveFilePicker(page);
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right");
  await expect(page.locator(".tabbedapp-panel")).toHaveCount(2);

  // openSplit leaves focus on the panel it just placed a document into, so this first save with no click at all already exercises the split: the unfixed code saved the left panel's document regardless of focus.
  await page.keyboard.press("Control+s");
  await expect.poll(() => savedFileNames(page)).toContain("second.pdf");

  // Move focus to the left panel and confirm the shortcut now follows it there too, instead of always resolving to one hardcoded side.
  await page
    .locator(".tabbedapp-panel")
    .nth(0)
    .locator(".pdfdocumenteditor-page")
    .first()
    .click();
  await page.keyboard.press("Control+s");
  await expect.poll(() => savedFileNames(page)).toContain("first.pdf");
});

test("the tab menu's Save and Print stay available for the secondary panel's own document", async ({
  page,
}) => {
  await openDocuments(page, [
    await blankPdf("first"),
    await blankPdf("second"),
  ]);
  await splitFromTab(page, 1, "Split Right");

  // Right-click the secondary panel's own tab (second.pdf), not the primary panel's - its Save/Print used to be disabled because "available" only ever compared the right-clicked tab against the left panel's document.
  await expect(await openTabMenu(page, 1, "Save")).toBeEnabled();
  await expect(
    page.getByRole("menuitem", { name: "Print", exact: true }),
  ).toBeEnabled();
});

// showSaveFilePicker needs a real dialog too, so it is stubbed with an in-memory file standing in for the chosen one. Mirrors the same helper in sidebar-and-save-all.spec.ts; kept local since these spec files share no helper module.
async function stubSaveFilePicker(page: Page) {
  await page.addInitScript(() => {
    const files = new Map<string, Uint8Array>();
    (
      window as unknown as { __savedFiles: Map<string, Uint8Array> }
    ).__savedFiles = files;

    (
      window as unknown as {
        showSaveFilePicker: (options?: {
          suggestedName?: string;
        }) => Promise<unknown>;
      }
    ).showSaveFilePicker = async (options) => {
      const name = options?.suggestedName ?? "saved.pdf";
      return {
        kind: "file" as const,
        name,
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return {
            async write(blob: Blob) {
              chunks.push(new Uint8Array(await blob.arrayBuffer()));
            },
            async close() {
              const total = chunks.reduce((sum, part) => sum + part.length, 0);
              const merged = new Uint8Array(total);
              let offset = 0;
              for (const part of chunks) {
                merged.set(part, offset);
                offset += part.length;
              }
              files.set(name, merged);
            },
            async abort() {},
          };
        },
        async getFile() {
          const stored = files.get(name) ?? new Uint8Array();
          return new File([stored.slice().buffer], name, {
            type: "application/pdf",
          });
        },
        async queryPermission() {
          return "granted";
        },
        async requestPermission() {
          return "granted";
        },
      };
    };
  });
}

async function savedFileNames(page: Page) {
  return page.evaluate(() => [
    ...(
      window as unknown as { __savedFiles: Map<string, Uint8Array> }
    ).__savedFiles.keys(),
  ]);
}

// Titled by the file, not by tab position, since a swap reorders which documents are visible without reordering the tabs themselves.
function activeTab(page: Page, title: string) {
  return page.locator(
    `${TAB}.tabbedapp-tab-button-active:has(.tabbedapp-tab-main[title="${title}"])`,
  );
}

async function splitFromTab(
  page: Page,
  tabIndex: number,
  item: "Split Right" | "Split Down",
) {
  await (await openTabMenu(page, tabIndex, item)).click();
  // The render that closes the menu is the one that splits and marks the documents coming into view busy; under load it can land well after the click, and a settle wait started before it would end at once.
  await expect(page.locator(".tabbedapp-tab-context-menu")).toHaveCount(0);

  // A busy shell (still settling a newly mounted document pane) drops right-click silently, so a follow-up split or swap has to wait this out first.
  await waitForShellSettled(page);
}

// Under heavy load the settle wait can still end in the gap between StrictMode's two waves, and the right-click is then dropped, so it is repeated until the menu shows the item; never over a menu that did open, which opens where the tab was clicked.
async function openTabMenu(page: Page, tabIndex: number, item: string) {
  const menuItem = page.getByRole("menuitem", { name: item, exact: true });
  await expect(async () => {
    if (!(await menuItem.isVisible())) {
      await page.locator(TAB).nth(tabIndex).click({ button: "right" });
    }
    await expect(menuItem).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  return menuItem;
}

async function openDocuments(page: Page, files: string[]) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(files);
  await expect(page.locator(TAB)).toHaveCount(files.length);
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await watchShellBusy(page);
}

// In dev, React StrictMode double-invokes a freshly mounted document pane's load effect, so the first mount's busy flag genuinely toggles true/false more than once in quick succession (a real second wave, not a flicker) - "data-busy is false right now" can catch the gap between two waves rather than the settled end, and a right-click issued into that gap is dropped the same as one issued while genuinely busy. This stamps every change of the flag so a wait can instead require it to have STAYED false: the first wave rises and falls within one task, so the observer only ever reads it as "false", and stamping only a "true" reading missed that wave and read the gap after it as settled.
async function watchShellBusy(page: Page) {
  await page.evaluate(() => {
    const shell = document.querySelector(".tabbedapp-shell");
    if (!shell) {
      throw new Error("no .tabbedapp-shell to watch");
    }
    const w = window as unknown as { __shellBusyChangedAt: number };
    w.__shellBusyChangedAt = 0;
    new MutationObserver(() => {
      w.__shellBusyChangedAt = Date.now();
    }).observe(shell, { attributes: true, attributeFilter: ["data-busy"] });
  });
}

// Bigger than the gap a StrictMode double-invoke leaves between its two waves, which is the entering file's read (observed at 15-20ms under load, 50-80ms at 4x CPU throttling), small next to the 15s expect budget this polls within.
const SHELL_SETTLE_MS = 250;

async function waitForShellSettled(page: Page) {
  await page.waitForFunction(
    (settleMs) => {
      const shell = document.querySelector(".tabbedapp-shell");
      const changedAt =
        (window as unknown as { __shellBusyChangedAt?: number })
          .__shellBusyChangedAt ?? 0;
      return (
        shell?.getAttribute("data-busy") === "false" &&
        Date.now() - changedAt >= settleMs
      );
    },
    SHELL_SETTLE_MS,
    { timeout: 15_000 },
  );
}

async function expectSideBySide(left: Locator, right: Locator) {
  const [leftBox, rightBox] = await Promise.all([
    left.boundingBox(),
    right.boundingBox(),
  ]);
  if (!leftBox || !rightBox) {
    throw new Error("a panel has no box");
  }

  expect(rightBox.x).toBeGreaterThan(leftBox.x + leftBox.width / 2);
  expect(Math.abs(leftBox.width - rightBox.width)).toBeLessThanOrEqual(2);
}

async function drawInkIn(page: Page, view: Locator) {
  // Scoped to the view: two different documents split side by side each carry their own tool dock, so a page-wide lookup is ambiguous.
  await view.getByRole("button", { name: "Pen 1", exact: true }).click();
  const box = await view
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
}

// The annotation layers only, not the page canvas: the page here is blank and what is measured is the mark.
async function inkPixels(view: Locator) {
  return view.locator(".pdfdocumenteditor-ink-canvas-layer").evaluateAll(
    (canvases, { sampleWidth }) => {
      let ink = 0;
      for (const element of canvases as HTMLCanvasElement[]) {
        if (element.width === 0 || element.height === 0) {
          continue;
        }

        const width = Math.min(element.width, sampleWidth);
        const height = Math.max(
          1,
          Math.round((element.height / element.width) * width),
        );
        const sample = document.createElement("canvas");
        sample.width = width;
        sample.height = height;
        const context = sample.getContext("2d", { willReadFrequently: true });
        if (!context) {
          throw new Error("no 2d context for the pixel sample");
        }

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(element, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        for (let index = 0; index < pixels.length; index += 4) {
          if (
            pixels[index] < 224 ||
            pixels[index + 1] < 224 ||
            pixels[index + 2] < 224
          ) {
            ink += 1;
          }
        }
      }
      return ink;
    },
    { sampleWidth: SAMPLE_WIDTH },
  );
}

function scrollTop(view: Locator) {
  return view
    .locator(".pdfdocumenteditor-scroll-root")
    .evaluate((element) => element.scrollTop);
}

async function scrollBy(view: Locator, delta: number) {
  await view
    .locator(".pdfdocumenteditor-scroll-root")
    .evaluate((element, by) => element.scrollBy(0, by), delta);
}

// Written here rather than committed: the pages exist to have nothing on them.
async function blankPdf(name: string) {
  const document = await PDFDocument.create();
  for (let index = 0; index < 4; index += 1) {
    document.addPage([420, 800]);
  }

  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-split-"));
  const path = join(directory, `${name}.pdf`);
  await writeFile(path, await document.save());
  return path;
}
