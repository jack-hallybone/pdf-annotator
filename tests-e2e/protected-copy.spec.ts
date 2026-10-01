import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName } from "pdf-lib";
import { detectReadOnlyReason } from "../src/pdfdocumenteditor/pdfProtection";

// "Edit a copy" promises a copy that no longer claims what the original did, so the PDF/A claim or signature has to be gone from the very first file the copy writes, changed or not, and from then on the copy is an ordinary file.

// Playwright cannot drive the File System Access picker; the shell's hidden input fires the same open path.
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const TAB = ".tabbedapp-document-tab";
const WARNING = ".banner.warning";

for (const fixture of ["test-pdfa.pdf", "test-signed.pdf"]) {
  test(`a copy of ${fixture} saved before any change is an ordinary file`, async ({
    page,
  }) => {
    await stubSaveFilePicker(page);
    await page.goto("/");
    await page
      .locator(HIDDEN_FILE_INPUT)
      .setInputFiles(
        fileURLToPath(new URL(`../tests/fixtures/${fixture}`, import.meta.url)),
      );
    await expect(page.locator(WARNING)).toBeVisible();
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

// showSaveFilePicker needs a real dialog, so it is stubbed with an in-memory file standing in for the chosen one. Its modified time only moves when it is written, as a real file's does: the in-place save refuses a file that looks changed since this window last wrote it.
async function stubSaveFilePicker(page: Page) {
  await page.addInitScript(() => {
    const saved = window as unknown as SavedFiles;
    const files = new Map<string, Uint8Array>();
    const modified = new Map<string, number>();
    saved.__savedFiles = files;
    saved.__pickerCalls = 0;

    (
      window as unknown as {
        showSaveFilePicker: (options?: {
          suggestedName?: string;
        }) => Promise<unknown>;
      }
    ).showSaveFilePicker = async (options) => {
      saved.__pickerCalls += 1;
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
      };
    };
  });
}
