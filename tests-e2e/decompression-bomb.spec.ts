import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { objectStreamBombPdf } from "../tests/pdfBombs";

// PDFA-2: a crafted PDF can make pdf-lib inflate gigabytes. pdf-lib runs on the page's main thread, so without the parse gate opening such a file froze or crashed the tab and took every open document's unsaved work with it. The parse gate now makes that read in a worker first, where no stream may decode past 64 MB, and refuses a file that breaks that limit or runs out of time. This drives the whole thing in real Chromium: the object-stream bomb (pdf-lib inflates it inside PDFDocument.load itself, before any project code can look at it, and parses on past a stream it runs out of memory for, so it is the worker's 64 MB stream cap that stops it, not the time limit), the page staying responsive while it is checked, and the reader getting a plain message.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

// Far past the 64 MB a stream may decode to in the gate's worker, which stops it there on any machine, however fast; tiny on disk (nested deflate).
const BOMB_INFLATED_BYTES = 3 * 1024 * 1024 * 1024;

let bombBytes: Buffer | null = null;
async function objectStreamBomb() {
  bombBytes ??= Buffer.from(
    await objectStreamBombPdf(BOMB_INFLATED_BYTES, { nested: true }),
  );
  return bombBytes;
}

async function ordinaryPdf() {
  const doc = await PDFDocument.create();
  doc
    .addPage([300, 300])
    .drawText("An ordinary page.", { x: 40, y: 200, size: 18 });
  return Buffer.from(await doc.save());
}

// A frame counter running on the main thread: if the main thread froze, it stops advancing and the largest gap between frames blows up.
async function startResponsivenessProbe(page: Page) {
  await page.evaluate(() => {
    const state = { frames: 0, maxGapMs: 0, last: performance.now() };
    (window as unknown as { __probe: typeof state }).__probe = state;
    const tick = () => {
      const now = performance.now();
      state.maxGapMs = Math.max(state.maxGapMs, now - state.last);
      state.last = now;
      state.frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readResponsivenessProbe(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __probe: { frames: number; maxGapMs: number } })
        .__probe,
  );
}

test("an object-stream bomb is refused and the page stays responsive while it is checked", async ({
  page,
}) => {
  await page.goto("/");
  await startResponsivenessProbe(page);

  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "bomb.pdf",
    mimeType: "application/pdf",
    buffer: await objectStreamBomb(),
  });

  // The reader gets a plain message and a way out, not a frozen tab. Allowed well past the read budget so a slow CI machine still sees it.
  await expect(page.locator(".loading-message-error")).toContainText(
    /more time or memory to read than the current safety limit/i,
    { timeout: 20_000 },
  );

  // The whole point: the main thread kept running frames while the worker did the reading, so no single stall looks like a freeze.
  const probe = await readResponsivenessProbe(page);
  expect(probe.frames).toBeGreaterThan(20);
  expect(probe.maxGapMs).toBeLessThan(1_000);
});

test("an ordinary PDF still opens after a bomb was refused", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "ordinary.pdf",
    mimeType: "application/pdf",
    buffer: await ordinaryPdf(),
  });

  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".loading-message-error")).toHaveCount(0);
});
