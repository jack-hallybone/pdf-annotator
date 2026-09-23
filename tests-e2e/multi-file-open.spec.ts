import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// The drop here is a real one, dispatched through CDP and carrying real paths on
// disk: a DataTransfer built inside the page has no drag data store behind it.

const TAB = ".tabbedapp-document-tab";
const NAMES = ["alpha", "bravo", "charlie"];

test("a drop of three PDFs opens three tabs, each with its file handle", async ({
  page,
}) => {
  const paths = await pdfsOnDisk();
  await openHome(page);

  await dropFiles(page, paths);
  await expect(page.locator(TAB)).toHaveText([/alpha/, /bravo/, /charlie/]);

  await dropFiles(page, paths);
  await expect(page.locator(TAB)).toHaveText([/alpha/, /bravo/, /charlie/]);
});

test("a file-handler launch carrying three files opens three tabs", async ({
  page,
}) => {
  await stubLaunchQueue(page, { filesPerLaunch: 3 });
  await page.goto("/");

  await expect(page.locator(TAB)).toHaveText([/alpha/, /bravo/, /charlie/]);

  await page.evaluate(() => window.relaunchWithPdfs());
  await expect(page.locator(TAB)).toHaveText([/alpha/, /bravo/, /charlie/]);
});

test("three single-file launches - the Windows shape - open three tabs", async ({
  page,
}) => {
  await stubLaunchQueue(page, { filesPerLaunch: 1 });
  await page.goto("/");

  await expect(page.locator(TAB)).toHaveText([/alpha/, /bravo/, /charlie/]);

  await page.evaluate(() => window.relaunchWithPdfs());
  await expect(page.locator(TAB)).toHaveText([/alpha/, /bravo/, /charlie/]);
});

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open PDFs" })).toBeVisible();
}

async function pdfBytes(name: string) {
  const document = await PDFDocument.create();
  document.addPage([200, 200]).drawText(name, { size: 18, x: 20, y: 100 });
  return document.save();
}

async function pdfsOnDisk() {
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-multi-"));
  return Promise.all(
    NAMES.map(async (name) => {
      const path = join(directory, `${name}.pdf`);
      await writeFile(path, await pdfBytes(name));
      return path;
    }),
  );
}

// CDP's Input.dispatchDragEvent takes paths on disk, so what the page receives
// is the browser's own store - the one that stops answering, and the one whose
// items can hand out file handles.
async function dropFiles(page: Page, files: string[]) {
  const client = await page.context().newCDPSession(page);
  const box = await page.locator("body").boundingBox();
  if (!box) {
    throw new Error("The app shell has no box to drop onto.");
  }

  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const data = {
    items: files.map((path) => ({
      mimeType: "application/pdf",
      data: "",
      title: path.split("/").at(-1) ?? "",
    })),
    files,
    dragOperationsMask: 1,
  };

  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await client.send("Input.dispatchDragEvent", { type, x, y, data });
  }

  await client.detach();
}

declare global {
  interface Window {
    relaunchWithPdfs: () => void;
  }
}

// The handles are real FileSystemFileHandles, written into the origin's private
// file system by the page, so the reading, sniffing and entry-identity
// comparison the app does with them are all its own.
async function stubLaunchQueue(
  page: Page,
  { filesPerLaunch }: { filesPerLaunch: number },
) {
  const payloads = await Promise.all(
    NAMES.map(async (name) => ({
      name: `${name}.pdf`,
      bytes: Array.from(await pdfBytes(name)),
    })),
  );

  await page.addInitScript(
    ({ filesPerLaunch, payloads }) => {
      const ready = (async () => {
        const root = await navigator.storage.getDirectory();
        return Promise.all(
          payloads.map(async ({ name, bytes }) => {
            const handle = await root.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(new Uint8Array(bytes));
            await writable.close();
            return handle;
          }),
        );
      })();

      let consumer:
        ((params: { files: FileSystemFileHandle[] }) => void) | null = null;
      const queued: FileSystemFileHandle[][] = [];

      function deliver(batch: FileSystemFileHandle[]) {
        if (consumer) {
          consumer({ files: batch });
          return;
        }
        queued.push(batch);
      }

      function launch(handles: FileSystemFileHandle[]) {
        for (let start = 0; start < handles.length; start += filesPerLaunch) {
          deliver(handles.slice(start, start + filesPerLaunch));
        }
      }

      void ready.then(launch);
      window.relaunchWithPdfs = () => void ready.then(launch);

      Object.defineProperty(window, "launchQueue", {
        configurable: true,
        writable: true,
        value: {
          setConsumer(
            next: (params: { files: FileSystemFileHandle[] }) => void,
          ) {
            consumer = next;
            for (const batch of queued.splice(0)) {
              next({ files: batch });
            }
          },
        },
      });
    },
    { filesPerLaunch, payloads },
  );
}
