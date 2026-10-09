import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Ctrl+F used to be the browser's own find, which sees only the pages that happen to be drawn. With a document open it now opens the app's find bar, which reads every page's text in idle moments from the page on screen onward: these drive the bar end to end, and check that a long book stays quick - the first match at once, typing never held up, and a match hundreds of pages on found, scrolled to and highlighted.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';
const CURRENT_HIGHLIGHT = "pdfdocumenteditor-find-current";
const MATCH_HIGHLIGHT = "pdfdocumenteditor-find-match";

// "harbour" five times over three pages: twice on the first, once broken across a line on the second, and in capitals and inside "harbours" on the third.
const SHORT_PAGES = [
  [
    "The harbour was quiet that morning.",
    "Harbour lights went out one by one.",
  ],
  ["Beyond the breakwater the old har-", "bour wall still stood."],
  ["HARBOUR MASTER'S OFFICE", "No harbours were built after the war."],
];

const BOOK_PAGES = 700;
const BOOK_LINES = 30;
// In nothing else the book says, and only on this page, so the search has to read most of the book to reach it.
const FAR_WORD = "quincunx";
const FAR_PAGE_INDEX = 649;
const BOOK_WORDS = [
  "harbour",
  "the",
  "evening",
  "light",
  "fell",
  "across",
  "water",
  "and",
  "stone",
  "while",
  "gulls",
  "turned",
  "above",
  "boats",
  "moored",
  "along",
  "wall",
];

test("Ctrl+F is left to the browser until a document is open, then opens the find bar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".browserapp-home-card")).toBeVisible();
  await recordFindKeys(page);

  await page.keyboard.press("Control+f");
  await expect.poll(() => findKeysPrevented(page)).toEqual([false]);
  await expect(page.getByRole("search")).toHaveCount(0);

  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(await shortPdf());
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await page.keyboard.press("Control+f");
  await expect(findField(page)).toBeFocused();
  await expect.poll(() => findKeysPrevented(page)).toEqual([false, true]);
});

test("the Find button opens the find bar, for a reader with no keyboard", async ({
  page,
}) => {
  await openDocument(page, await shortPdf());
  await page.getByRole("button", { name: "Find in document" }).click();
  await expect(findField(page)).toBeFocused();
  await findField(page).fill("harbour");
  await expect(page.getByRole("search").getByRole("status")).toHaveText(
    "1 of 5",
  );
});

test("Enter, Shift+Enter and the arrows step through every match, whatever its case or line break", async ({
  page,
}) => {
  await openDocument(page, await shortPdf());
  await page.keyboard.press("Control+f");
  await page.keyboard.type("harbour");

  const count = page.getByRole("search").getByRole("status");
  await expect(count).toHaveText("1 of 5");
  await expect
    .poll(() => highlighted(page, CURRENT_HIGHLIGHT))
    .toEqual([{ pageIndex: 0, text: "harbour" }]);
  // The other matches on drawn pages are coloured too, more faintly.
  await expect
    .poll(() => highlighted(page, MATCH_HIGHLIGHT))
    .toContainEqual({ pageIndex: 0, text: "Harbour" });

  await page.keyboard.press("Enter");
  await expect(count).toHaveText("2 of 5");
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("3 of 5");
  await expect
    .poll(() => highlighted(page, CURRENT_HIGHLIGHT))
    .toEqual([{ pageIndex: 1, text: "har-bour" }]);

  await page.keyboard.press("Shift+Enter");
  await expect(count).toHaveText("2 of 5");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(count).toHaveText("1 of 5");
  // Round from the first to the last, and on to the first again.
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(count).toHaveText("5 of 5");
  await expect
    .poll(() => highlighted(page, CURRENT_HIGHLIGHT))
    .toEqual([{ pageIndex: 2, text: "harbour" }]);
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(count).toHaveText("1 of 5");

  await findField(page).fill("lighthouse");
  await expect(count).toHaveText("No matches");
  await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
});

test("Escape closes the find bar, clears its colours and gives focus back", async ({
  page,
}) => {
  await openDocument(page, await shortPdf());
  const zoomSettings = page.getByRole("button", { name: "Zoom settings" });
  await zoomSettings.focus();

  await page.keyboard.press("Control+f");
  await expect(findField(page)).toBeFocused();
  await page.keyboard.type("harbour");
  await expect(page.getByRole("search").getByRole("status")).toHaveText(
    "1 of 5",
  );
  await expect.poll(() => highlighted(page, CURRENT_HIGHLIGHT)).toHaveLength(1);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("search")).toHaveCount(0);
  await expect(zoomSettings).toBeFocused();
  await expect.poll(() => highlighted(page, CURRENT_HIGHLIGHT)).toEqual([]);
  await expect.poll(() => highlighted(page, MATCH_HIGHLIGHT)).toEqual([]);

  // Opened again, it offers the last search, selected so typing replaces it.
  await page.keyboard.press("Control+f");
  await expect(findField(page)).toBeFocused();
  await expect(findField(page)).toHaveValue("harbour");
  expect(
    await findField(page).evaluate(
      (field: HTMLInputElement) => field.selectionEnd! - field.selectionStart!,
    ),
  ).toBe("harbour".length);
});

test("a long book shows its first match at once, keeps up with typing, and finds a word hundreds of pages on", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDocument(page, await bookPdf());
  await page.keyboard.press("Control+f");
  await startProbes(page);

  // The first page is read and searched as soon as there is a query.
  await findField(page).fill("harbour");
  const firstMatchMs = await msUntilCount(page, /^1 of \d+$/);

  // Typed a key at a time while the pages "harbour" left unread are still being read.
  await watchFrames(page);
  await findField(page).clear();
  await findField(page).pressSequentially(FAR_WORD, { delay: 100 });
  const typing = await stopWatchingFrames(page);
  const farMatchMs = await msUntilCount(page, /^1 of 1$/);

  // Scrolled to, drawn and coloured, and not hidden under the find bar or the floating controls.
  await expect
    .poll(() => highlighted(page, CURRENT_HIGHLIGHT), { timeout: 30_000 })
    .toEqual([{ pageIndex: FAR_PAGE_INDEX, text: FAR_WORD }]);
  expect(await currentMatchUncovered(page)).toBe(true);

  test.info().annotations.push({
    description: `${BOOK_PAGES} pages: the first match ${Math.round(firstMatchMs)} ms after the query; page ${FAR_PAGE_INDEX + 1}'s ${Math.round(farMatchMs)} ms after the last key; while typing, the slowest key ${Math.round(typing.maxKeyLatencyMs)} ms to paint and the longest frame ${Math.round(typing.maxFrameGapMs)} ms`,
    type: "timing",
  });
  // Several times what a development build takes here, for a slow and shared machine; a production build is quicker still. A key held up behind the search, or a search that stalls, is well past them.
  expect(firstMatchMs).toBeLessThan(1_000);
  expect(farMatchMs).toBeLessThan(10_000);
  // The slowest key takes under 100 ms to paint here on a quiet machine, but once took 216 ms while four verifies shared it, and up to about 400 ms with the page's CPU slowed three or four times; a stall is past even this.
  expect(typing.maxKeyLatencyMs).toBeLessThan(500);
  // Most of a long frame here is the development build re-rendering every page slot; this is for a stall.
  expect(typing.maxFrameGapMs).toBeLessThan(500);
});

async function openDocument(page: Page, path: string) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(path);
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".page-jump-control")).toBeVisible();
}

function findField(page: Page) {
  return page.getByRole("textbox", { name: "Find in document" });
}

// Read once the key has been everywhere it is going, so it reflects what every listener did with it.
async function recordFindKeys(page: Page) {
  await page.evaluate(() => {
    const prevented: boolean[] = [];
    (window as unknown as { __findKeys: boolean[] }).__findKeys = prevented;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "f") {
          window.setTimeout(() => prevented.push(event.defaultPrevented));
        }
      },
      true,
    );
  });
}

function findKeysPrevented(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __findKeys: boolean[] }).__findKeys,
  );
}

// Each range a highlight colours, as the text it covers and the page it is on.
function highlighted(page: Page, name: string) {
  return page.evaluate((name) => {
    const ranges = [...(CSS.highlights.get(name) ?? [])];
    return ranges.map((staticRange) => {
      const range = document.createRange();
      range.setStart(staticRange.startContainer, staticRange.startOffset);
      range.setEnd(staticRange.endContainer, staticRange.endOffset);
      const slot =
        staticRange.startContainer.parentElement?.closest("[data-page-index]");
      return {
        pageIndex: Number(slot?.getAttribute("data-page-index")),
        text: range.toString(),
      };
    });
  }, name);
}

// The middle of the current match is in the view and on its page, with nothing floating over it.
function currentMatchUncovered(page: Page) {
  return page.evaluate((name) => {
    const [staticRange] = [...(CSS.highlights.get(name) ?? [])];
    const range = document.createRange();
    range.setStart(staticRange.startContainer, staticRange.startOffset);
    range.setEnd(staticRange.endContainer, staticRange.endOffset);
    const box = range.getBoundingClientRect();
    const view = document
      .querySelector(".pdfdocumenteditor-scroll-root")!
      .getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return (
      box.top >= view.top &&
      box.bottom <= view.bottom &&
      Boolean(hit?.closest("article")?.contains(staticRange.startContainer))
    );
  }, CURRENT_HIGHLIGHT);
}

type FindProbe = {
  keyLatenciesMs: number[];
  maxFrameGapMs: number;
  queryAt: number;
  watchingFrames: boolean;
};

// When the query last changed; Event Timing's key press to next paint, which is what a person typing feels; and, while watchingFrames is set, the longest gap between frames, which a busy main thread stretches. Frames are watched only while typing, since asking for every frame also keeps the browser from ever being idle.
async function startProbes(page: Page) {
  await page.evaluate(() => {
    const probe: FindProbe = {
      keyLatenciesMs: [],
      maxFrameGapMs: 0,
      queryAt: 0,
      watchingFrames: false,
    };
    (window as unknown as { __findProbe: FindProbe }).__findProbe = probe;

    document.querySelector(".find-bar-input")!.addEventListener("input", () => {
      probe.queryAt = performance.now();
    });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.startsWith("key") || entry.name === "input") {
          probe.keyLatenciesMs.push(entry.duration);
        }
      }
    }).observe({
      durationThreshold: 16,
      type: "event",
    } as PerformanceObserverInit);
  });
}

function watchFrames(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __findProbe: FindProbe }).__findProbe;
    probe.keyLatenciesMs.length = 0;
    probe.maxFrameGapMs = 0;
    probe.watchingFrames = true;
    let last = performance.now();
    const tick = (now: number) => {
      probe.maxFrameGapMs = Math.max(probe.maxFrameGapMs, now - last);
      last = now;
      if (probe.watchingFrames) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

function stopWatchingFrames(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __findProbe: FindProbe }).__findProbe;
    probe.watchingFrames = false;
    return {
      maxFrameGapMs: probe.maxFrameGapMs,
      maxKeyLatencyMs: Math.max(0, ...probe.keyLatenciesMs),
    };
  });
}

// From the last change to the query until the count reads `pattern`.
function msUntilCount(page: Page, pattern: RegExp) {
  return page.evaluate(
    (source) =>
      new Promise<number>((resolve) => {
        const probe = (window as unknown as { __findProbe: FindProbe })
          .__findProbe;
        const count = document.querySelector(".find-bar-count")!;
        const check = () => {
          if (new RegExp(source).test(count.textContent ?? "")) {
            observer.disconnect();
            resolve(performance.now() - probe.queryAt);
          }
        };
        const observer = new MutationObserver(check);
        observer.observe(count, {
          characterData: true,
          childList: true,
          subtree: true,
        });
        check();
      }),
    pattern.source,
  );
}

// Written here rather than committed, like the other generated fixtures.
let shortPdfPath: Promise<string> | null = null;
function shortPdf() {
  shortPdfPath ??= (async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    for (const lines of SHORT_PAGES) {
      const page = doc.addPage([420, 300]);
      lines.forEach((line, index) =>
        page.drawText(line, { font, size: 16, x: 40, y: 240 - index * 24 }),
      );
    }
    return savedPdf(doc, "harbour.pdf");
  })();
  return shortPdfPath;
}

let bookPdfPath: Promise<string> | null = null;
function bookPdf() {
  bookPdfPath ??= (async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    for (let pageIndex = 0; pageIndex < BOOK_PAGES; pageIndex += 1) {
      const page = doc.addPage([420, 595]);
      for (let line = 0; line < BOOK_LINES; line += 1) {
        const words = Array.from(
          { length: 10 },
          (_, word) =>
            BOOK_WORDS[
              (pageIndex * 7 + line * 3 + word * 5) % BOOK_WORDS.length
            ],
        );
        if (pageIndex === FAR_PAGE_INDEX && line === BOOK_LINES / 2) {
          words[4] = FAR_WORD;
        }
        page.drawText(words.join(" "), {
          font,
          size: 10,
          x: 40,
          y: 550 - line * 16,
        });
      }
    }
    return savedPdf(doc, "long-book.pdf");
  })();
  return bookPdfPath;
}

async function savedPdf(doc: PDFDocument, name: string) {
  const directory = await mkdtemp(join(tmpdir(), "pdfdocumenteditor-find-"));
  const path = join(directory, name);
  await writeFile(path, await doc.save());
  return path;
}
