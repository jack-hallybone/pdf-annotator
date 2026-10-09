import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// The reference manager, on the same origin, hands a library PDF's file handle to the annotator's window. Here a page of this origin does what it does: writes a real file into the origin's private file system, opens the annotator's window, and sends the handle once the annotator says it is ready.

const TAB = ".tabbedapp-document-tab";
const NAME = "library-paper.pdf";

test("a PDF the reference manager hands over opens, and Save writes back to its file", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const bytes = Array.from(await pdfBytes());
  const opened = context.waitForEvent("page");
  const answered = page.evaluate(
    async ({ bytes, name }) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();

      const id = crypto.randomUUID();
      const target = window.open(location.href, "pdf-annotator");
      return new Promise<string>((resolve) => {
        window.addEventListener("message", (event) => {
          if (event.data?.type === "pdf-annotator-ready") {
            target?.postMessage(
              { type: "pdf-annotator-open", id, handle },
              location.origin,
            );
          } else if (
            event.data?.type === "pdf-annotator-opened" &&
            event.data.id === id
          ) {
            resolve("opened");
          }
        });
      });
    },
    { bytes, name: NAME },
  );

  const annotator = await opened;
  await expect(annotator.locator(TAB)).toHaveText([/library-paper/]);
  expect(await answered).toBe("opened");

  const before = await fileBytes(page);
  await drawStroke(annotator);
  await expect(annotator.locator(".tabbedapp-tab-close-dirty")).toHaveCount(1);
  await annotator.keyboard.press("Control+s");
  await expect.poll(() => fileBytes(page)).not.toEqual(before);
  await expect(annotator.locator(".tabbedapp-tab-close-dirty")).toHaveCount(0);
  const saved = await PDFDocument.load(new Uint8Array(await fileBytes(page)));
  expect(saved.getPage(0).node.Annots()?.size()).toBe(1);
});

test("a file sent from another origin opens nothing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open PDFs" })).toBeVisible();
  const bytes = Array.from(await pdfBytes());
  await page.evaluate(
    async ({ bytes, name }) => {
      const root = await navigator.storage.getDirectory();
      async function write(fileName: string) {
        const handle = await root.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(bytes));
        await writable.close();
        return handle;
      }
      const elsewhere = await write("elsewhere.pdf");
      const handle = await write(name);

      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://elsewhere.example",
          data: { type: "pdf-annotator-open", id: "a", handle: elsewhere },
        }),
      );
      window.postMessage(
        { type: "pdf-annotator-open", id: "b", handle },
        location.origin,
      );
    },
    { bytes, name: NAME },
  );

  // They arrive in order, so by the time this origin's file opens the other has been turned away.
  await expect(page.locator(TAB)).toHaveText([/library-paper/]);
});

async function pdfBytes() {
  const document = await PDFDocument.create();
  document.addPage([300, 300]).drawText("From the library", {
    size: 18,
    x: 20,
    y: 150,
  });
  return document.save();
}

function fileBytes(page: Page) {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(name)).getFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }, NAME);
}

async function drawStroke(page: Page) {
  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  const box = await page
    .locator(".pdfdocumenteditor-page")
    .first()
    .boundingBox();
  if (!box) {
    throw new Error("no page to draw on");
  }

  const y = box.y + box.height * 0.3;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y + 40, { steps: 20 });
  await page.mouse.up();
}
