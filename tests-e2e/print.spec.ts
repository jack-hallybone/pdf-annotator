import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";

const PAGE_COUNT = 20;
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

async function multiPageFixture() {
  const doc = await PDFDocument.create();
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({
      color: rgb(0.2, 0.2, 0.6),
      height: 762,
      width: 515,
      x: 40,
      y: 40,
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-print-"));
  const path = join(directory, "twenty-pages.pdf");
  await writeFile(path, await doc.save());
  return path;
}

// window.print() is a modal, OS-level dialog in a real browser; stubbing it
// out (via a binding, since the app calls it on the printable iframe's own
// window, a separate context from the page's) keeps this deterministic and
// isolates what this test actually guards: the app resolving the print
// operation rather than hanging on it.
test("printing bakes the PDF into a frame and resolves without leaving the app busy", async ({
  page,
}) => {
  let printCalls = 0;
  await page.exposeFunction("__reportPrint", () => {
    printCalls += 1;
  });
  await page.addInitScript(() => {
    window.print = () => {
      (window as unknown as { __reportPrint: () => void }).__reportPrint();
    };
  });

  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await multiPageFixture());
  await expect(page.locator("canvas").first()).toBeVisible();

  const printButton = page.getByRole("button", {
    exact: true,
    name: "Print",
  });
  await expect(printButton).toBeEnabled();
  await printButton.click();

  // Comfortably inside the app's own 4-second stalled-frame fallback: this
  // must resolve on the fast path, not need the safety net to save it.
  await expect
    .poll(() => printCalls, {
      message: "the printable frame never called print()",
      timeout: 2_000,
    })
    .toBeGreaterThan(0);

  // beginBusyOperation()/finishBusyOperation() gate this same button: if the
  // print operation's promise never settled, it would stay disabled forever.
  await expect(printButton).toBeEnabled({ timeout: 2_000 });
});
