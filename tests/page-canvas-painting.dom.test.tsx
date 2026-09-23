import assert from "node:assert/strict";
import { test } from "node:test";
import type { PageViewport } from "../src/pdfdocumenteditor/types";
import "./rendererAssetStubs";

// pdf.js's own page view gives up quietly: on some documents it leaves the
// canvas wrapper empty, on others it hands back a canvas that rendered nothing,
// and either way the reader sees a blank page with no error.

// jsdom has no 2D rasteriser, so the emptiness probe is stubbed below and the
// pixel scan lives in pdfRender's own tests.

// pageCanvasPainting reaches pdf.js through pdfRender, so it needs the renderer
// asset stubs registered by the side-effect import above; this import has to be
// dynamic so it runs after that registration rather than alongside it.
const { renderRasterFallback, shouldUseRasterFallback } =
  await import("../src/pdfdocumenteditor/pageCanvasPainting");

const SAMPLE = 32;

// A canvas marked `data-painted` samples as having content; anything else
// samples as the opaque white a failed render leaves behind.
function samplePixels(painted: boolean) {
  const pixels = new Uint8ClampedArray(SAMPLE * SAMPLE * 4).fill(255);
  if (painted) {
    pixels[0] = 0;
    pixels[1] = 0;
    pixels[2] = 0;
  }
  return pixels;
}

let sampled: HTMLCanvasElement | null = null;
const transforms: number[][] = [];
const fakeContext = {
  clearRect: () => {
    sampled = null;
  },
  drawImage: (source: HTMLCanvasElement) => {
    sampled = source;
  },
  getImageData: () => ({
    data: samplePixels(sampled?.hasAttribute("data-painted") === true),
  }),
  setTransform: (...values: number[]) => {
    transforms.push(values);
  },
} as unknown as CanvasRenderingContext2D;

HTMLCanvasElement.prototype.getContext = (() =>
  fakeContext) as unknown as HTMLCanvasElement["getContext"];

function pageContainer(canvas?: { painted?: boolean; released?: boolean }) {
  const container = document.createElement("div");
  const page = document.createElement("div");
  page.className = "page";
  const wrapper = document.createElement("div");
  wrapper.className = "canvasWrapper";
  page.append(wrapper);
  container.append(page);

  if (canvas) {
    const element = document.createElement("canvas");
    element.width = canvas.released ? 0 : 800;
    element.height = canvas.released ? 0 : 1000;
    if (canvas.painted) {
      element.setAttribute("data-painted", "");
    }
    wrapper.append(element);
  }

  return container;
}

test("a page pdf.js actually painted is left alone", () => {
  assert.equal(
    shouldUseRasterFallback(pageContainer({ painted: true })),
    false,
  );
});

test("an empty canvas wrapper means pdf.js never got as far as a canvas", () => {
  assert.equal(shouldUseRasterFallback(pageContainer()), true);
});

test("a canvas that rendered nothing still needs the fallback", () => {
  assert.equal(shouldUseRasterFallback(pageContainer({})), true);
});

test("a released canvas buffer counts as no canvas at all", () => {
  assert.equal(
    shouldUseRasterFallback(pageContainer({ released: true })),
    true,
  );
});

test("only the canvas inside the canvas wrapper counts", () => {
  const container = pageContainer();
  const strayLayer = document.createElement("div");
  strayLayer.className = "annotationLayer";
  const stray = document.createElement("canvas");
  stray.width = 800;
  stray.height = 1000;
  stray.setAttribute("data-painted", "");
  strayLayer.append(stray);
  container.querySelector(".page")?.append(strayLayer);

  assert.equal(shouldUseRasterFallback(container), true);
});

const viewport = {
  width: 612,
  height: 792,
  scale: 1,
  rotation: 0,
  viewBox: [0, 0, 612, 792],
} as unknown as PageViewport;

function fakePage() {
  const calls: { annotationMode: number }[] = [];
  return {
    calls,
    page: {
      render: (options: { annotationMode: number }) => {
        calls.push(options);
        return { promise: Promise.resolve() };
      },
    },
  };
}

test("the fallback paints into the shape pdf.js would have produced", async () => {
  transforms.length = 0;
  const container = pageContainer({ painted: true });
  const { page, calls } = fakePage();

  const canvas = await renderRasterFallback(
    page as never,
    viewport,
    container,
    0,
    () => undefined,
  );

  assert.ok(canvas, "the fallback should return the canvas it painted");
  assert.equal(container.querySelectorAll(".canvasWrapper canvas").length, 1);
  assert.equal(canvas.parentElement?.className, "canvasWrapper");
  assert.equal(canvas.hasAttribute("data-painted"), false);
  assert.equal(calls.length, 1);

  const ratio = canvas.width / viewport.width;
  assert.ok(
    ratio >= 1,
    "the backing buffer should not be smaller than the page",
  );
  assert.equal(canvas.height, Math.ceil(viewport.height * ratio));
  assert.equal(canvas.style.width, `${viewport.width}px`);
  assert.equal(canvas.style.height, `${viewport.height}px`);
  assert.deepEqual(transforms.at(-1), [ratio, 0, 0, ratio, 0, 0]);
});

test("the fallback builds the page scaffolding when pdf.js left none", async () => {
  const container = document.createElement("div");
  const { page } = fakePage();

  const canvas = await renderRasterFallback(
    page as never,
    viewport,
    container,
    0,
    () => undefined,
  );

  assert.ok(canvas);
  const pdfPage = container.querySelector<HTMLElement>(".page");
  assert.ok(pdfPage, "a .page host should have been created");
  assert.equal(pdfPage.style.width, `${viewport.width}px`);
  assert.equal(pdfPage.style.height, `${viewport.height}px`);
  assert.equal(canvas.parentElement?.className, "canvasWrapper");
});
