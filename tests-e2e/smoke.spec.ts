import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";

const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/test-annotated.pdf", import.meta.url),
);

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

// Ink in the canvas, not just a visible canvas with a non-zero box: an empty canvas the app laid out satisfied that while every page came up blank.
const SAMPLE_WIDTH = 400;
const MIN_DISTINCT_COLOURS = 8;
const MIN_INK_PIXELS = 200;

// Playwright cannot drive the File System Access picker; the shell's hidden <input type="file"> fires the same open path.
async function openFixture(page: Page) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(fixturePath);
  await expect(page.locator("canvas").first()).toBeVisible();
}

// Copied into a smaller canvas of our own first: a full backing-store readback is slow and makes Chromium warn, and the page canvas is transparent where nothing was painted, so compositing onto white makes blank a single colour.
async function pageCanvasInk(canvas: Locator) {
  return canvas.evaluate(
    (element: HTMLCanvasElement, { sampleWidth }) => {
      if (element.width === 0 || element.height === 0) {
        return { colours: 0, ink: 0, sampled: 0, width: 0, height: 0 };
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
      const colours = new Set<number>();
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        colours.add((red << 16) | (green << 8) | blue);
        if (red < 224 || green < 224 || blue < 224) {
          ink += 1;
        }
      }

      return {
        colours: colours.size,
        ink,
        sampled: width * height,
        width: element.width,
        height: element.height,
      };
    },
    { sampleWidth: SAMPLE_WIDTH },
  );
}

async function expectFirstPagePainted(page: Page) {
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

  await expect
    .poll(async () => (await pageCanvasInk(canvas)).ink, {
      message: "the first page canvas never got any ink drawn into it",
    })
    .toBeGreaterThanOrEqual(MIN_INK_PIXELS);

  const painted = await pageCanvasInk(canvas);
  expect(
    painted.colours,
    `the page canvas holds ${painted.colours} distinct colours; a page that ` +
      "rendered nothing holds one",
  ).toBeGreaterThanOrEqual(MIN_DISTINCT_COLOURS);
  expect(painted.width).toBeGreaterThan(0);
  expect(painted.height).toBeGreaterThan(0);

  await expect(page.getByText(/^Could not display page/)).toHaveCount(0);
}

test("boots, opens a PDF, and renders its first page", async ({ page }) => {
  await openFixture(page);

  await expectFirstPagePainted(page);

  await expect(
    page.getByRole("button", { name: "Download a copy" }),
  ).toBeVisible();
});

// A custom property carries its value through verbatim, so anything the theme composes reaches a canvas 2D context as a string it silently drops; without PdfPageView's probe span the reading answers for another element's palette.
test("the accent probe's anchor is mounted, and resolves to a paintable colour", async ({
  page,
}) => {
  await openFixture(page);

  const probed = await page.evaluate(() => {
    const anchor = document.querySelector(".pdfdocumenteditor");
    if (!anchor) return { mounted: false, colour: "" };
    const probe = document.createElement("span");
    probe.style.cssText = "display: none; color: var(--theme-accent)";
    anchor.append(probe);
    const colour = getComputedStyle(probe).color.trim();
    probe.remove();
    return { mounted: true, colour };
  });

  expect(probed.mounted, "no .pdfdocumenteditor to hang the probe on").toBe(
    true,
  );
  expect(probed.colour).toMatch(/^rgba?\(/);
});

test("download-a-copy round trips to a valid PDF with the same page count", async ({
  page,
}) => {
  await openFixture(page);

  const original = await PDFDocument.load(await readFile(fixturePath));

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);

  const bytes = await readFile(await download.path());

  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);

  const roundTripped = await PDFDocument.load(bytes);
  expect(roundTripped.getPageCount()).toBe(original.getPageCount());
});

test("a downloaded copy can be reopened in the app", async ({ page }) => {
  await openFixture(page);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download a copy" }).click(),
  ]);
  const downloadPath = await download.path();

  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(downloadPath);
  await expectFirstPagePainted(page);
});

// Nothing on the page changes between these clicks, so its view never re-renders: the trust "Always allow" adds has to reach the links it drew beforehand.
test('"Always allow" reaches the next link on the same page, and still asks before one that adds a recipient', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = (url) => {
      opened.push(String(url));
      return null;
    };
  });
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "links.pdf",
    mimeType: "application/pdf",
    buffer: await mailLinksPdf(),
  });

  const link = (url: string) =>
    page.getByRole("link", { name: `Open link: ${url}`, exact: true });
  const dialog = page.locator(".external-link-dialog");
  const opened = () =>
    page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

  await link("mailto:support@vendor.example").click();
  await dialog.getByRole("checkbox", { name: /^Always allow/ }).check();
  await dialog.getByRole("button", { name: "Open" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(opened).toContain("mailto:support@vendor.example");

  await link("mailto:support@vendor.example?subject=Later").click();
  await expect
    .poll(opened)
    .toContain("mailto:support@vendor.example?subject=Later");
  await expect(dialog).toBeHidden();

  await link("mailto:support@vendor.example?bcc=attacker@evil.example").click();
  await expect(dialog).toBeVisible();
  expect(await opened()).not.toContain(
    "mailto:support@vendor.example?bcc=attacker@evil.example",
  );
});

// Three links on one page: a plain address, the same address with a subject, and the same address adding a Bcc.
async function mailLinksPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const urls = [
    "mailto:support@vendor.example",
    "mailto:support@vendor.example?subject=Later",
    "mailto:support@vendor.example?bcc=attacker@evil.example",
  ];
  page.node.set(
    PDFName.of("Annots"),
    doc.context.obj(
      urls.map((url, index) =>
        doc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [20, 220 - index * 80, 280, 280 - index * 80],
          Border: [0, 0, 0],
          A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
        }),
      ),
    ),
  );
  return Buffer.from(await doc.save());
}
