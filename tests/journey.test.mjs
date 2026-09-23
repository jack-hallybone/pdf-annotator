// The whole journey, against the built site rather than the dev server: it
// builds, opens a PDF, takes an annotation, saves, and the annotation is still
// there when the file is opened again, measured in pixels twice.

//   Run:  node tests/journey.test.mjs   (builds the site; needs playwright's chromium)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { serveBuiltSite } from "./site.mjs";

// A plain one-page PDF, made here: `test-annotated.pdf` carries 23 annotations
// of its own, so every reading below would start at hundreds of ink pixels, and
// `test-pdfa.pdf` opens read-only, correctly, so there is no pen to click.
async function writeFixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("A page to annotate.", { x: 64, y: 720, size: 28, font });
  page.drawRectangle({
    x: 64,
    y: 300,
    width: 460,
    height: 360,
    borderWidth: 3,
  });
  const at = join(await mkdtemp(join(tmpdir(), "pdfa-journey-")), "plain.pdf");
  await writeFile(at, await pdf.save());
  return at;
}

// The picker is a File System Access dialog no browser automation can drive, so
// files are set on the fallback input the shell always renders, which takes the
// same open path.
const FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

const FIXTURE = await writeFixture();
const site = await serveBuiltSite();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const crashes = [];
page.on("pageerror", (error) => crashes.push(String(error)));

after(async () => {
  await browser.close();
  site.close();
});

// The annotation canvases only, never the page canvas: the fixture's page has
// text on it, so a reading that included the document would be thousands of
// pixels before the pen was ever picked up.
const inkPixels = () =>
  page
    .locator(".pdfdocumenteditor-ink-canvas-layer")
    .evaluateAll((canvases) => {
      let ink = 0;
      for (const element of canvases) {
        if (element.width === 0 || element.height === 0) continue;
        const width = Math.min(element.width, 400);
        const height = Math.max(
          1,
          Math.round((element.height / element.width) * width),
        );
        const sample = document.createElement("canvas");
        sample.width = width;
        sample.height = height;
        const context = sample.getContext("2d", { willReadFrequently: true });
        context.drawImage(element, 0, 0, width, height);
        const { data } = context.getImageData(0, 0, width, height);
        for (let at = 3; at < data.length; at += 4) {
          if (data[at] > 8) ink += 1;
        }
      }
      return ink;
    });

const openFile = async (path) => {
  await page.locator(FILE_INPUT).setInputFiles(path);
  await page
    .locator(".pdfdocumenteditor-page canvas")
    .first()
    .waitFor({ state: "visible" });
};

let saved;

test("it builds, loads, and shows itself", async () => {
  await page.goto(site.url);
  await page.locator(".browserapp-home-card").waitFor({ state: "visible" });
});

test("it opens a PDF and renders the first page", async () => {
  await openFile(FIXTURE);
  await page
    .locator(".pdfdocumenteditor-page canvas")
    .first()
    .waitFor({ state: "visible" });
});

test("a pen stroke puts ink on the page", async () => {
  assert.equal(await inkPixels(), 0, "there was ink before the pen was used");

  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  const box = await page
    .locator(".pdfdocumenteditor-page")
    .first()
    .boundingBox();
  assert.ok(box, "no page to draw on");
  const y = box.y + box.height * 0.2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y + 40, { steps: 20 });
  await page.mouse.up();

  await assert.doesNotReject(
    page.waitForFunction(() =>
      [
        ...document.querySelectorAll(".pdfdocumenteditor-ink-canvas-layer"),
      ].some((canvas) => canvas.width > 0),
    ),
  );
  assert.ok((await inkPixels()) > 0, "the pen drew nothing");
});

test("saving produces a PDF", async () => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);
  // saveAs, not `download.path()`: Playwright's own temp path has no extension,
  // and the app refuses an extensionless file silently.
  saved = join(dirname(FIXTURE), "saved.pdf");
  await download.saveAs(saved);
  const bytes = await readFile(saved);
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("reopening the saved file still shows the annotation", async () => {
  // Reloaded first, and that is the whole case: opening the saved file into the
  // running app leaves the tab that still holds the stroke in memory beside it, so
  // every reading below would find the annotation either way.
  await page.goto(site.url);
  await page.locator(".browserapp-home-card").waitFor({ state: "visible" });
  assert.equal(await inkPixels(), 0, "the reload did not clear the session");

  await openFile(saved);
  await page.getByRole("button", { name: /show sidebar/iu }).click();
  await page.getByRole("tab", { name: "Annotations" }).click();
  await page
    .locator(".annotation-row")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.locator(".annotation-row").count(), 1);
  assert.ok((await inkPixels()) > 0, "the reopened file paints no annotation");
});

test("nothing threw along the way", () => {
  assert.deepEqual(crashes, []);
});
