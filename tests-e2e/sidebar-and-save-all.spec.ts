import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Download, type Page } from "@playwright/test";

// The comment round trip runs model -> pdf-lib -> file -> pdf.js -> model, and
// Save All is a batch across tabs where all but one are unmounted.

const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/test-annotated.pdf", import.meta.url),
);

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

async function openFixture(page: Page, file = fixturePath) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(file);
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".page-jump-control")).toBeVisible();
}

// Playwright's download path is a UUID with no extension and the app decides a
// File is a PDF by its type or its name, so the copy is saved under its real
// filename.
async function savedCopyPath(download: Download) {
  const target = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(target);
  return target;
}

async function openCopyInNewTab(page: Page, file: string) {
  const tabs = await page.locator(".tabbedapp-document-tab").count();
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(file);
  await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(tabs + 1);
  await expect(page.locator(".page-jump-control")).toBeVisible();
}

async function openAnnotationsTab(page: Page) {
  await page.getByRole("button", { name: /show sidebar/i }).click();
  await page.getByRole("tab", { name: "Annotations" }).click();
  await expect(page.getByRole("list", { name: "Annotations" })).toBeVisible();
}

async function outlinedPdf() {
  const { PDFDocument, PDFName, PDFString } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 300]);
  first.drawText("First", { size: 24, x: 40, y: 200 });
  const second = doc.addPage([300, 300]);
  second.drawText("Second", { size: 24, x: 40, y: 200 });

  const { context } = doc;
  const outlines = context.obj({ Type: "Outlines", Count: 2 });
  const outlinesRef = context.register(outlines);
  const firstItem = context.obj({
    Title: PDFString.of("Chapter one"),
    Parent: outlinesRef,
    Dest: [first.ref, PDFName.of("Fit")],
  });
  const firstRef = context.register(firstItem);
  const secondItem = context.obj({
    Title: PDFString.of("Chapter two"),
    Parent: outlinesRef,
    Dest: [second.ref, PDFName.of("Fit")],
  });
  const secondRef = context.register(secondItem);
  firstItem.set(PDFName.of("Next"), secondRef);
  secondItem.set(PDFName.of("Prev"), firstRef);
  outlines.set(PDFName.of("First"), firstRef);
  outlines.set(PDFName.of("Last"), secondRef);
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);

  return Buffer.from(await doc.save());
}

// The highlight is on the second page: the only way to prove a row click
// navigates rather than merely opening itself in the list.
async function annotatedTwoPagePdf() {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 300]);
  first.drawText("Page one text", { size: 14, x: 30, y: 250 });
  const second = doc.addPage([300, 300]);
  second.drawText("Page two text", { size: 14, x: 30, y: 250 });
  second.node.set(
    PDFName.of("Annots"),
    doc.context.obj([
      doc.context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: [28, 246, 130, 266],
        QuadPoints: [28, 266, 130, 266, 28, 246, 130, 246],
        C: [1, 0.9, 0.2],
        CA: 0.4,
        F: 4,
      }),
    ]),
  );
  return Buffer.from(await doc.save());
}

// Longer than EAGER_PAGE_LIMIT (25), with a highlight on the last page: past
// that limit pages load only when scrolled to.
const LONG_DOCUMENT_PAGES = 40;

async function longPdf({ annotated } = { annotated: true }) {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let index = 0; index < LONG_DOCUMENT_PAGES; index += 1) {
    const page = doc.addPage([300, 300]);
    page.drawText(`Page ${index + 1} text`, { size: 14, x: 30, y: 250 });
  }
  if (!annotated) {
    return Buffer.from(await doc.save());
  }

  const last = doc.getPage(LONG_DOCUMENT_PAGES - 1);
  last.node.set(
    PDFName.of("Annots"),
    doc.context.obj([
      doc.context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: [28, 246, 130, 266],
        QuadPoints: [28, 266, 130, 266, 28, 246, 130, 246],
        C: [0.2, 0.7, 0.3],
        CA: 0.4,
        F: 4,
      }),
    ]),
  );
  return Buffer.from(await doc.save());
}

test("the annotations tab lists a mark on a page nobody has scrolled to", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "long.pdf",
    mimeType: "application/pdf",
    buffer: await longPdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await expect(page.locator(".page-number-input")).toHaveValue("1");

  // A pass that re-ranked or re-loaded pages would blank their canvases for two
  // frames, which a screenshot cannot see, so the frames are counted.
  await page.getByRole("button", { name: /show sidebar/i }).click();
  const baseCanvas = page.locator(
    '.pdfdocumenteditor-page-slot[data-page-index="0"] .canvasWrapper canvas',
  );
  await expect(baseCanvas).toBeVisible();

  const blankFrames = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let missing = 0;
        const startedAt = performance.now();
        const tick = () => {
          const canvas = document.querySelector(
            '.pdfdocumenteditor-page-slot[data-page-index="0"] .canvasWrapper canvas',
          );
          if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) {
            missing += 1;
          }
          if (performance.now() - startedAt > 2_000) {
            resolve(missing);
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

  await page.getByRole("tab", { name: "Annotations" }).click();
  await expect(page.getByRole("list", { name: "Annotations" })).toBeVisible();
  const row = page.locator(".annotation-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".annotation-row-meta")).toContainText(
    `page ${LONG_DOCUMENT_PAGES}`,
  );
  await expect(row.locator(".annotation-row-quote")).toContainText(
    `Page ${LONG_DOCUMENT_PAGES} text`,
  );
  expect(
    await blankFrames,
    "page 1 lost its canvas while the list filled",
  ).toBe(0);

  const rendered = await page
    .locator(".pdfdocumenteditor-page-slot .canvasWrapper canvas")
    .count();
  expect(rendered).toBeGreaterThan(0);
  // The window around the current page, not the document: LAZY_PAGE_BUFFER is 2,
  // so a handful. A bound of "fewer than 40" would still pass on 39.
  expect(rendered).toBeLessThanOrEqual(10);

  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(0);

  await row.locator(".annotation-row-open").click();
  await expect(page.locator(".page-number-input")).toHaveValue(
    String(LONG_DOCUMENT_PAGES),
  );
});

// An empty list means both "this document has none" and "not read yet", and has
// to keep telling them apart after a page edit reloads the document.
test("an empty list says the document has none only once it has read it", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "long-plain.pdf",
    mimeType: "application/pdf",
    buffer: await longPdf({ annotated: false }),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();

  await page.getByRole("button", { name: /show sidebar/i }).click();
  await page.getByRole("tab", { name: "Annotations" }).click();
  await expect(page.locator(".annotations-empty")).toHaveText(
    "No annotations in this document yet.",
  );

  await page.getByRole("tab", { name: "Pages" }).click();
  await page.getByRole("button", { name: "Actions for page 1" }).click();
  await page
    .getByRole("button", { name: "Delete page", exact: true })
    .click({ timeout: 30_000 });
  await expect(page.locator(".page-jump-control")).toContainText(
    `of ${LONG_DOCUMENT_PAGES - 1}`,
    { timeout: 45_000 },
  );

  await page.getByRole("tab", { name: "Annotations" }).click();
  await expect(page.locator(".annotations-empty")).toHaveText(
    "No annotations in this document yet.",
  );

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".page-jump-control")).toContainText(
    `of ${LONG_DOCUMENT_PAGES}`,
    { timeout: 45_000 },
  );
  await expect(page.locator(".annotations-empty")).toHaveText(
    "No annotations in this document yet.",
  );
});

// Page surgery reloads the document and forgets which pages have been read, so
// the pass has to run again - and not during the reload, where the document in
// hand is the one being replaced.
test("the list is still whole after a page is deleted under it", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "long.pdf",
    mimeType: "application/pdf",
    buffer: await longPdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();

  await openAnnotationsTab(page);
  await expect(page.locator(".annotation-row")).toHaveCount(1);

  await page.getByRole("tab", { name: "Pages" }).click();
  await page.getByRole("button", { name: "Actions for page 1" }).click();
  await page
    .getByRole("button", { name: "Delete page", exact: true })
    .click({ timeout: 30_000 });
  await expect(page.locator(".page-jump-control")).toContainText(
    `of ${LONG_DOCUMENT_PAGES - 1}`,
    { timeout: 45_000 },
  );

  await page.getByRole("tab", { name: "Annotations" }).click();
  const remaining = page.locator(".annotation-row");
  await expect(remaining).toHaveCount(1);
  await expect(remaining.locator(".annotation-row-meta")).toContainText(
    `page ${LONG_DOCUMENT_PAGES - 1}`,
  );
});

test("clicking an entry navigates to the annotation's page", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "two-pages.pdf",
    mimeType: "application/pdf",
    buffer: await annotatedTwoPagePdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await expect(page.locator(".page-number-input")).toHaveValue("1");

  await openAnnotationsTab(page);
  const row = page.locator(".annotation-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".annotation-row-meta")).toContainText("page 2");
  await expect(row.locator(".annotation-row-quote")).toContainText("Page two");

  await row.locator(".annotation-row-open").click();
  await expect(page.locator(".page-number-input")).toHaveValue("2");
});

test("the annotations tab lists the document's annotations and navigates to one", async ({
  page,
}) => {
  await openFixture(page);
  await openAnnotationsTab(page);

  const rows = page.locator(".annotation-row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(1);

  await expect(
    page.locator(".annotation-row-quote", { hasText: "This is" }),
  ).toBeVisible();

  await expect(page.locator(".annotation-row-meta").first()).toContainText(
    "page 1",
  );

  await rows.first().locator(".annotation-row-open").click();
  await expect(rows.first()).toHaveClass(/annotation-row-selected/);
});

test("a comment added in the sidebar survives a save and reopen", async ({
  page,
}) => {
  await openFixture(page);
  await openAnnotationsTab(page);

  const highlightRow = page.locator(".annotation-row", {
    has: page.locator(".annotation-row-meta", { hasText: "Highlight" }),
  });
  await highlightRow.first().locator(".annotation-row-open").click();

  const editor = page.getByRole("textbox", { name: "Comment" });
  await expect(editor).toBeVisible();
  await editor.fill("worth checking: ) ( \\ later");
  await editor.blur();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);
  const savedPath = await savedCopyPath(download);

  await openCopyInNewTab(page, savedPath);
  await openAnnotationsTab(page);
  await expect(
    page.locator(".annotation-row-comment", { hasText: "worth checking" }),
  ).toBeVisible();

  const reopened = page.locator(".annotation-row", {
    has: page.locator(".annotation-row-comment", { hasText: "worth checking" }),
  });
  await reopened.first().locator(".annotation-row-open").click();
  const reopenedEditor = page.getByRole("textbox", { name: "Comment" });
  await expect(reopenedEditor).toHaveValue(/worth checking/);
  await reopenedEditor.fill("");
  await reopenedEditor.blur();

  const [cleared] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);
  await openCopyInNewTab(page, await savedCopyPath(cleared));
  await openAnnotationsTab(page);
  await expect(page.locator(".annotation-row-comment")).toHaveCount(0);
});

test("a starred annotation survives a save and reopen, and filters the list", async ({
  page,
}) => {
  await openFixture(page);
  await openAnnotationsTab(page);

  const rowCount = await page.locator(".annotation-row").count();
  expect(rowCount).toBeGreaterThan(1);

  await page.locator(".annotation-row-star").first().click();
  await expect(page.locator(".annotation-row-star").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: /show starred only/i }).click();
  await expect(page.locator(".annotation-row")).toHaveCount(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);

  await openCopyInNewTab(page, await savedCopyPath(download));
  await openAnnotationsTab(page);
  await page.getByRole("button", { name: /show starred only/i }).click();
  await expect(page.locator(".annotation-row")).toHaveCount(1);
  await expect(page.locator(".annotation-row-star")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a star survives a save and reopen on a directly-stored annotation", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "two-pages.pdf",
    mimeType: "application/pdf",
    buffer: await annotatedTwoPagePdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();

  await openAnnotationsTab(page);
  await expect(page.locator(".annotation-row")).toHaveCount(1);
  await page.locator(".annotation-row-star").click();
  await expect(page.locator(".annotation-row-star")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);

  await openCopyInNewTab(page, await savedCopyPath(download));
  await openAnnotationsTab(page);
  await expect(page.locator(".annotation-row-star")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /show starred only/i }).click();
  await expect(page.locator(".annotation-row")).toHaveCount(1);
});

test("colour swatches filter the list, and clearing them restores it", async ({
  page,
}) => {
  await openFixture(page);
  await openAnnotationsTab(page);

  const total = await page.locator(".annotation-row").count();
  const swatches = page.locator(".annotations-swatch");
  expect(await swatches.count()).toBeGreaterThan(1);

  await swatches.first().click();
  const filtered = await page.locator(".annotation-row").count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(total);

  await swatches.first().click();
  await expect(page.locator(".annotation-row")).toHaveCount(total);
});

test("the contents tab appears only for a document that has an outline", async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole("button", { name: /show sidebar/i }).click();
  await expect(page.getByRole("tab", { name: "Pages" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Contents" })).toHaveCount(0);

  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "outlined.pdf",
    mimeType: "application/pdf",
    buffer: await outlinedPdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await page.getByRole("button", { name: /show sidebar/i }).click();
  await page.getByRole("tab", { name: "Contents" }).click();

  await expect(page.getByRole("button", { name: "Chapter one" })).toBeVisible();
  await page.getByRole("button", { name: "Chapter two" }).click();
  await expect(page.locator(".page-number-input")).toHaveValue("2");
});

async function savedFileNames(page: Page) {
  return page.evaluate(() => [
    ...(
      window as unknown as { __savedFiles: Map<string, Uint8Array> }
    ).__savedFiles.keys(),
  ]);
}

test("Save All lists every unsaved tab, and each is resolved with its own Save As", async ({
  page,
}) => {
  await stubSaveFilePicker(page);
  await page.goto("/");

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "New tab" }).click();
    await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
    await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(
      index + 1,
    );
    await expect(page.locator(".page-jump-control")).toBeVisible();
  }

  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(3);
  const saveAll = page.getByRole("button", { name: /save all/i });
  await expect(saveAll).toBeVisible();

  // None of the three has a file of its own, so Save All lists them instead
  // of guessing at a destination - each is resolved with its own Save As.
  await saveAll.click();
  const destinationDialog = page.getByRole("dialog", {
    name: "Choose where to save",
  });
  await expect(destinationDialog).toBeVisible();
  for (let remaining = 3; remaining > 0; remaining -= 1) {
    await destinationDialog
      .getByRole("button", { name: "Save as..." })
      .first()
      .click();
    await expect(
      destinationDialog.getByRole("button", { name: "Save as..." }),
    ).toHaveCount(remaining - 1);
  }
  await expect(destinationDialog).toBeHidden();
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(0);

  const names = await savedFileNames(page);
  expect(names).toHaveLength(3);
  for (const name of names) {
    const size = await page.evaluate(
      (fileName) =>
        (
          window as unknown as { __savedFiles: Map<string, Uint8Array> }
        ).__savedFiles.get(fileName)!.length,
      name,
    );
    expect(size).toBeGreaterThan(500);
  }

  await page.keyboard.press("Control+Shift+S");
  await expect(page.locator(".banner").last()).toContainText(
    "No unsaved changes",
  );
});

test("a Save As that fails leaves that file listed, ready to retry", async ({
  page,
}) => {
  await stubSaveFilePicker(page);
  await page.goto("/");

  for (let index = 0; index < 2; index += 1) {
    await page.getByRole("button", { name: "New tab" }).click();
    await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
    await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(
      index + 1,
    );
    await expect(page.locator(".page-jump-control")).toBeVisible();
  }

  // The first Save As resolved fails to write; the second succeeds.
  await page.evaluate(() => {
    const files = (
      window as unknown as { __savedFiles: Map<string, Uint8Array> }
    ).__savedFiles;
    const original = files.set.bind(files);
    let writes = 0;
    files.set = (name: string, value: Uint8Array) => {
      writes += 1;
      if (writes === 1 && value.length > 0) {
        throw new Error("the disk said no");
      }
      return original(name, value);
    };
  });

  await page.keyboard.press("Control+Shift+S");
  const destinationDialog = page.getByRole("dialog", {
    name: "Choose where to save",
  });
  await expect(destinationDialog).toBeVisible();
  await destinationDialog
    .getByRole("button", { name: "Save as..." })
    .first()
    .click();

  // Still listed and still dirty: the failed write did not silently drop it.
  await expect(destinationDialog).toBeVisible();
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(2);

  // Retrying the same file now succeeds (the stub only fails the first write).
  await destinationDialog
    .getByRole("button", { name: "Save as..." })
    .first()
    .click();
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);
});

// showSaveFilePicker needs a real dialog too, so it is stubbed with an
// in-memory file standing in for the chosen one.
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
      // Every blank document starts out "Untitled.pdf", and each save here is
      // its own dialog now rather than one batch an app-side disambiguator
      // could dedupe - so this, like a real save dialog would, offers the
      // next free name instead of colliding with an already-saved one.
      let name = options?.suggestedName ?? "saved.pdf";
      if (files.has(name)) {
        const stem = name.replace(/\.pdf$/i, "");
        let attempt = 1;
        while (files.has(`${stem} (${attempt}).pdf`)) {
          attempt += 1;
        }
        name = `${stem} (${attempt}).pdf`;
      }
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

test("Save All lists a file with no destination, and Save As resolves it", async ({
  page,
}) => {
  await stubSaveFilePicker(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
  await expect(page.locator(".page-jump-control")).toBeVisible();

  await page.getByRole("button", { name: /save all/i }).click();
  const destinationDialog = page.getByRole("dialog", {
    name: "Choose where to save",
  });
  await expect(destinationDialog).toBeVisible();
  await destinationDialog.getByRole("button", { name: "Save as..." }).click();

  await expect(destinationDialog).toBeHidden();
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(0);
  expect(await savedFileNames(page)).toEqual(["Untitled.pdf"]);
});

test("Save As from the destination dialog also resolves a parked (background) tab", async ({
  page,
}) => {
  await stubSaveFilePicker(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
  // Waited for by content, not just the tab strip: tab 1's document pane is
  // lazy-loaded, and creating tab 2 before it mounts would park it having
  // never registered - the very session tab 2 then needs to capture.
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(1);
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
  await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(2);
  await expect(page.locator(".page-jump-control")).toBeVisible();
  // Tab 1 is parked (unmounted) now that tab 2 is the active one.
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(2);

  await page.getByRole("button", { name: /save all/i }).click();
  const destinationDialog = page.getByRole("dialog", {
    name: "Choose where to save",
  });
  await expect(destinationDialog).toBeVisible();
  await destinationDialog
    .getByRole("button", { name: "Save as..." })
    .first()
    .click();

  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);
  expect(await savedFileNames(page)).toEqual(["Untitled.pdf"]);
});

test("Cancel leaves the tabs open and dirty, with no way to mass-discard them from here", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
  await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(2);
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(2);

  await page.getByRole("button", { name: /save all/i }).click();
  const destinationDialog = page.getByRole("dialog", {
    name: "Choose where to save",
  });
  await expect(destinationDialog).toBeVisible();

  // A destination for one file, not a verdict on every listed one - discard
  // belongs to the per-tab close flow, not this dialog.
  await expect(
    destinationDialog.getByRole("button", { name: /discard/i }),
  ).toHaveCount(0);

  // Cancel only dismisses the dialog: both tabs stay open, still unsaved.
  await destinationDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(destinationDialog).toBeHidden();
  await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(2);
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(2);
});

test("closing a dirty tab can save it instead of discarding it", async ({
  page,
}) => {
  await stubSaveFilePicker(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /New Blank A4/i }).click();
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);

  await page.locator(".tabbedapp-tab-close").first().click();
  await expect(page.locator(".tabbedapp-close-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();

  // No file of its own yet, so the close waits on the same destination
  // dialog Save All uses; resolving it here still leaves the tab open, so
  // closing it is a second, now unconfirmed, click.
  const destinationDialog = page.getByRole("dialog", {
    name: "Choose where to save",
  });
  await destinationDialog.getByRole("button", { name: "Save as..." }).click();
  await expect(page.locator(".tabbedapp-tab-close-dirty")).toHaveCount(0);
  await page.locator(".tabbedapp-tab-close").first().click();

  await expect(page.locator(".tabbedapp-document-tab")).toHaveCount(0);
  expect(await savedFileNames(page)).toEqual(["Untitled.pdf"]);
});

test("a downloaded copy carries the comment and the star for another reader", async ({
  page,
}) => {
  await openFixture(page);
  await openAnnotationsTab(page);

  const row = page.locator(".annotation-row", {
    has: page.locator(".annotation-row-meta", { hasText: "Highlight" }),
  });
  await row.first().locator(".annotation-row-open").click();
  await page.getByRole("textbox", { name: "Comment" }).fill("for the record");
  await page.getByRole("textbox", { name: "Comment" }).blur();
  await row.first().locator(".annotation-row-star").click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);
  const bytes = await readFile(await savedCopyPath(download));

  const { PDFDocument, PDFDict, PDFName, PDFBool } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(0).node.Annots()!;
  let found = false;
  for (let index = 0; index < annots.size(); index += 1) {
    const dict = annots.lookupMaybe(index, PDFDict);
    const contents = dict?.get(PDFName.of("Contents")) as
      { decodeText?: () => string } | undefined;
    if (contents?.decodeText?.() === "for the record") {
      found = true;
      expect(
        dict?.lookupMaybe(PDFName.of("PANN_Starred"), PDFBool)?.asBoolean(),
      ).toBe(true);
    }
  }
  expect(found, "the comment never reached /Contents").toBe(true);
});
