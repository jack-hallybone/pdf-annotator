import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName } from "pdf-lib";
import { detectReadOnlyReason } from "../src/pdfdocumenteditor/pdfProtection";

// "Edit a copy" promises a copy that no longer claims what the original did, so the PDF/A claim or signature has to be gone from the very first file the copy writes, changed or not, and from then on the copy is an ordinary file. "Unlock original" makes the same promise of the original itself, which its saves go over.

// Playwright cannot drive the File System Access picker; the shell's hidden input fires the same open path.
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const TAB = ".tabbedapp-document-tab";
const WARNING = ".banner.warning";

for (const fixture of ["test-pdfa.pdf", "test-signed.pdf"]) {
  test(`a copy of ${fixture} saved before any change is an ordinary file`, async ({
    page,
  }) => {
    await stubFilePickers(page);
    await page.goto("/");
    await page.locator(HIDDEN_FILE_INPUT).setInputFiles(fixturePath(fixture));
    await expect(page.locator(WARNING)).toBeVisible();
    // Opened without a file handle, so there is no original to save over.
    await expect(
      page.getByRole("button", { name: "Unlock original" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Edit a copy" }).click();

    await documentAction(page, "Save As...").click();
    const copyName = fixture.replace(/\.pdf$/, " - copy.pdf");
    await expect.poll(() => savedSize(page, copyName)).toBeGreaterThan(0);
    const firstSave = await savedBytes(page, copyName);
    expect(await detectReadOnlyReason(firstSave, null, false)).toBeNull();

    const reopenedPath = test.info().outputPath(copyName);
    await writeFile(reopenedPath, firstSave);
    await page.locator(HIDDEN_FILE_INPUT).setInputFiles(reopenedPath);
    await expect(page.locator(TAB)).toHaveCount(2);
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.locator(".page-jump-control")).toBeVisible();
    await expect(page.locator(WARNING)).toHaveCount(0);

    // Back on the copy, restored from its parked state: a change saves in place, to the file Save As chose, not through a second Save As.
    await page.locator(TAB).first().click();
    await drawStroke(page);
    await documentAction(page, "Save").click();
    await expect
      .poll(async () => (await savedBytes(page, copyName)).length)
      .not.toBe(firstSave.length);
    expect(await pickerCalls(page)).toBe(1);
    await expect(page.locator(".tabbedapp-notice")).toHaveCount(0);
    expect(
      await detectReadOnlyReason(await savedBytes(page, copyName), null, false),
    ).toBeNull();
  });
}

for (const fixture of ["test-pdfa.pdf", "test-signed.pdf"]) {
  test(`Unlock original saves ${fixture} over itself, as an ordinary file, even from a parked tab`, async ({
    page,
  }) => {
    const original = await readFile(fixturePath(fixture));
    await openFromDisk(page, fixture, original);
    await page.getByRole("button", { name: "Unlock original" }).click();
    await expect(page.getByText(READ_ONLY_TEXT)).toHaveCount(0);
    await expect(page.getByText(/^Editing the original\./)).toBeVisible();
    await expect(page.locator(TAB)).not.toContainText("copy");
    await drawStroke(page);

    // Parked unsaved behind a second tab, then back: still the original's tab, so Save writes it rather than asking where.
    const other = test.info().outputPath("other.pdf");
    await writeFile(other, await blankPdf());
    await page.locator(HIDDEN_FILE_INPUT).setInputFiles(other);
    await expect(page.locator(TAB)).toHaveCount(2);
    await expect(page.locator(".page-jump-control")).toBeVisible();
    const originalTab = page.getByRole("button", {
      exact: true,
      name: fixture,
    });
    await originalTab.click();
    await expect(originalTab).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".page-jump-control")).toBeVisible();
    await documentAction(page, "Save").click();

    await expect
      .poll(async () => (await savedBytes(page, fixture)).length)
      .not.toBe(original.length);
    expect(await pickerCalls(page)).toBe(0);
    expect(
      await detectReadOnlyReason(await savedBytes(page, fixture), null, false),
    ).toBeNull();
  });

  test(`Edit a copy of ${fixture} opened from disk never writes the original`, async ({
    page,
  }) => {
    const original = await readFile(fixturePath(fixture));
    await openFromDisk(page, fixture, original);
    await page.getByRole("button", { name: "Edit a copy" }).click();
    await drawStroke(page);
    await documentAction(page, "Save").click();

    const copyName = fixture.replace(/\.pdf$/, " - copy.pdf");
    await expect.poll(() => savedSize(page, copyName)).toBeGreaterThan(0);
    expect(await pickerCalls(page)).toBe(1);
    expect(Buffer.from(await savedBytes(page, fixture)).equals(original)).toBe(
      true,
    );
  });
}

// pdf.js shows the pages and pdf-lib writes them, and a page-tree leaf with no /Type is a page to pdf.js alone: every edit would land a page off, a copy's as much as the original's, so there is no copy to edit either.
test("a file whose page lists disagree opens read-only with no copy to edit", async ({
  page,
}) => {
  const pdfDoc = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) {
    pdfDoc.addPage([300, 400]);
  }
  pdfDoc.getPage(0).node.delete(PDFName.of("Type"));
  const path = test.info().outputPath("pages.pdf");
  await writeFile(path, await pdfDoc.save({ useObjectStreams: false }));

  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(path);
  await expect(page.locator(WARNING)).toContainText(
    "page structure is malformed",
  );
  await expect(page.getByRole("button", { name: "Edit a copy" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Pen 1", exact: true }),
  ).toHaveCount(0);
});

const READ_ONLY_TEXT = "open as read-only";

function fixturePath(name: string) {
  return fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url));
}

async function blankPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([300, 400]);
  return pdfDoc.save();
}

// Through Open PDFs, the way a reader opens a file in Chromium, so the tab holds a handle to save over.
async function openFromDisk(page: Page, name: string, bytes: Uint8Array) {
  await stubFilePickers(page, { bytes: Array.from(bytes), name });
  await page.goto("/");
  await page.getByRole("button", { name: "Open PDFs" }).click();
  await expect(page.getByText(READ_ONLY_TEXT)).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit a copy" })).toBeVisible();
}

function documentAction(page: Page, name: string) {
  return page
    .getByLabel("Document actions")
    .first()
    .getByRole("button", { name, exact: true });
}

async function drawStroke(page: Page) {
  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  const pdfPage = page.locator(".pdfdocumenteditor-page").first();
  await expect(pdfPage).toBeVisible();
  const box = await pdfPage.boundingBox();
  if (!box) {
    throw new Error("The page has no box to draw on.");
  }
  const y = box.y + box.height * 0.2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y + 40, { steps: 20 });
  await page.mouse.up();
}

type SavedFiles = {
  __pickerCalls: number;
  __savedFiles: Map<string, Uint8Array>;
};

async function savedBytes(page: Page, name: string) {
  const bytes = await page.evaluate(
    (fileName) =>
      Array.from(
        (window as unknown as SavedFiles).__savedFiles.get(fileName) ?? [],
      ),
    name,
  );
  return new Uint8Array(bytes);
}

async function savedSize(page: Page, name: string) {
  return page.evaluate(
    (fileName) =>
      (window as unknown as SavedFiles).__savedFiles.get(fileName)?.length ?? 0,
    name,
  );
}

function pickerCalls(page: Page) {
  return page.evaluate(() => (window as unknown as SavedFiles).__pickerCalls);
}

// The File System Access pickers need real dialogs, so they are stubbed with in-memory files standing in for the chosen ones, and an opened file is seeded into the same store. A file's modified time only moves when it is written, as a real file's does: the in-place save refuses a file that looks changed since this window last wrote it.
async function stubFilePickers(
  page: Page,
  opened?: { bytes: number[]; name: string },
) {
  await page.addInitScript((openedFile) => {
    const saved = window as unknown as SavedFiles;
    const files = new Map<string, Uint8Array>();
    const modified = new Map<string, number>();
    saved.__savedFiles = files;
    saved.__pickerCalls = 0;
    if (openedFile) {
      files.set(openedFile.name, new Uint8Array(openedFile.bytes));
      modified.set(openedFile.name, 1);
    }

    const handleFor = (name: string) => ({
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
            modified.set(name, Date.now());
          },
          async abort() {},
        };
      },
      async getFile() {
        const stored = files.get(name) ?? new Uint8Array();
        return new File([stored.slice().buffer], name, {
          lastModified: modified.get(name) ?? 0,
          type: "application/pdf",
        });
      },
      async queryPermission() {
        return "granted";
      },
      async requestPermission() {
        return "granted";
      },
    });

    const pickers = window as unknown as {
      showOpenFilePicker?: () => Promise<unknown[]>;
      showSaveFilePicker: (options?: {
        suggestedName?: string;
      }) => Promise<unknown>;
    };
    pickers.showSaveFilePicker = async (options) => {
      saved.__pickerCalls += 1;
      return handleFor(options?.suggestedName ?? "saved.pdf");
    };
    if (openedFile) {
      pickers.showOpenFilePicker = async () => [handleFor(openedFile.name)];
    }
  }, opened);
}
