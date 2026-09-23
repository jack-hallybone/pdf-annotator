import assert from "node:assert/strict";
import { test } from "node:test";
import { fireEvent, render } from "@testing-library/react";
import { AnnotationShape } from "../src/pdfdocumenteditor/components/PageAnnotationOverlays";
import type {
  PageViewport,
  PdfAnnotation,
  Tool,
} from "../src/pdfdocumenteditor/types";

// Both the overlay's jobs fail silently: drawing each annotation over the pixels
// of its page (PDF space is bottom-up and in points, the SVG top-down and in CSS
// pixels), and deciding whether a pointer-down belongs to the annotation or to
// the page underneath.

const PAGE_HEIGHT_PT = 792;

function viewportAtZoom(zoom: number) {
  return {
    width: 612 * zoom,
    height: PAGE_HEIGHT_PT * zoom,
    scale: zoom,
    rotation: 0,
    convertToViewportPoint: (x: number, y: number) => [
      x * zoom,
      (PAGE_HEIGHT_PT - y) * zoom,
    ],
  } as unknown as PageViewport;
}

const viewport = viewportAtZoom(1);

// A 60x60pt note whose lower-left corner is 100pt in and 600pt up the page, so
// its top edge is 792 - 660 = 132 CSS px down from the top of the page.
const note = {
  id: "note-1",
  kind: "stickyNote",
  pageIndex: 0,
  rect: { x1: 100, y1: 600, x2: 160, y2: 660 },
  text: "",
  color: [1, 0.9, 0.3],
} as PdfAnnotation;

const highlight = {
  id: "highlight-1",
  kind: "textHighlight",
  pageIndex: 0,
  rects: [{ x1: 100, y1: 600, x2: 200, y2: 612 }],
  quadPoints: [],
  color: [1, 0.9, 0.3],
  opacity: 0.4,
  comment: "",
} as PdfAnnotation;

const stamp = {
  id: "stamp-1",
  kind: "imageStamp",
  pageIndex: 0,
  rect: { x1: 100, y1: 600, x2: 160, y2: 660 },
  imageData: "AAAA",
  mimeType: "image/png",
  widthPx: 60,
  heightPx: 60,
} as PdfAnnotation;

type Calls = {
  hovers: boolean[];
  page: string[];
  selects: string[];
  drags: string[];
};

type Options = {
  focused?: boolean;
  partOfSelection?: boolean;
  readOnly?: boolean;
  selected?: boolean;
  tool?: Tool;
  viewport?: PageViewport;
};

function renderShape(annotation: PdfAnnotation, options: Options = {}) {
  const calls: Calls = { hovers: [], page: [], selects: [], drags: [] };
  const { container } = render(
    <svg onPointerDown={() => calls.page.push("pointerdown")}>
      <AnnotationShape
        annotation={annotation}
        focused={options.focused ?? false}
        onBeginEdit={() => undefined}
        onBeginFreeTextResizeHandleDrag={() => undefined}
        onBeginHighlightHandleDrag={() => undefined}
        onBeginMoveDrag={(_event, id) => calls.drags.push(id)}
        onFocusEnd={() => undefined}
        onHoverChange={(hovered) => calls.hovers.push(hovered)}
        onSelect={(id) => calls.selects.push(id)}
        onUpdate={() => undefined}
        partOfSelection={options.partOfSelection ?? options.selected ?? false}
        readOnly={options.readOnly ?? false}
        scale={options.viewport ? 2 : 1}
        selected={options.selected ?? false}
        showPopover={false}
        tool={options.tool ?? "select"}
        viewport={options.viewport ?? viewport}
      />
    </svg>,
  );

  const shape = container.querySelector("svg > g");
  assert.ok(shape, "the annotation should render a group");
  return { calls, container, shape };
}

function pressOn(shape: Element, init: Record<string, number> = {}) {
  return fireEvent.pointerDown(shape, { button: 0, buttons: 1, ...init });
}

test("an annotation is drawn where the page shows it, not at its PDF coordinates", () => {
  const { shape } = renderShape(note);

  // PDF y counts up from the bottom; the SVG counts down from the top.
  assert.equal(shape.getAttribute("transform"), "translate(100 132)");
  const body = shape.querySelector("rect");
  assert.equal(body?.getAttribute("width"), "60");
  assert.equal(body?.getAttribute("height"), "60");
});

test("zooming redraws the annotation at the zoomed position and size", () => {
  const { shape } = renderShape(note, { viewport: viewportAtZoom(2) });

  assert.equal(shape.getAttribute("transform"), "translate(200 264)");
  const body = shape.querySelector("rect");
  assert.equal(body?.getAttribute("width"), "120");
  assert.equal(body?.getAttribute("height"), "120");
});

test("an image stamp spins about its own centre, not the page origin", () => {
  const { shape } = renderShape({ ...stamp, rotation: 90 } as PdfAnnotation);
  const image = shape.querySelector("image");

  // Centre of the 60x60 box at (100, 132): rotating about anything else would
  // fling the stamp off its own footprint.
  assert.equal(
    image?.getAttribute("transform"),
    "translate(130 162) rotate(90) translate(-30 -30)",
  );
  assert.equal(image?.getAttribute("width"), "60");
  assert.equal(image?.getAttribute("height"), "60");
});

test("a text highlight's hit target is invisible but still catches the pointer", () => {
  const { shape } = renderShape(highlight);
  const hitTarget = shape.querySelector<SVGRectElement>("rect");

  assert.ok(hitTarget);
  assert.equal(hitTarget.style.opacity, "0");
  assert.equal(hitTarget.style.pointerEvents, "all");
  assert.equal(hitTarget.getAttribute("x"), "100");
  assert.equal(hitTarget.getAttribute("y"), "180");
  assert.equal(hitTarget.getAttribute("width"), "100");
  assert.equal(hitTarget.getAttribute("height"), "12");
});

test("a selected text highlight grows handles at the ends of the run", () => {
  const { shape } = renderShape(highlight, { selected: true });
  const handles = [...shape.querySelectorAll(".highlight-handle")];

  assert.equal(handles.length, 2);
  // Vertically centred on the run (792 - 606), at its first and last edge.
  assert.deepEqual(
    handles.map((handle) => [
      handle.getAttribute("cx"),
      handle.getAttribute("cy"),
    ]),
    [
      ["100", "186"],
      ["200", "186"],
    ],
  );
});

test("an unselected annotation does not show its handles", () => {
  const { shape } = renderShape(highlight);
  assert.equal(shape.querySelectorAll(".highlight-handle").length, 0);
});

test("pressing an annotation with the select tool selects it and starts a drag", () => {
  const { calls, shape } = renderShape(note, { tool: "select" });

  assert.equal(pressOn(shape), false, "the press should be claimed");
  assert.deepEqual(calls.selects, ["note-1"]);
  assert.deepEqual(calls.drags, ["note-1"]);
  assert.deepEqual(calls.page, []);
});

test("pressing an annotation already in the selection does not collapse it", () => {
  const { calls, shape } = renderShape(note, {
    partOfSelection: true,
    tool: "select",
  });

  pressOn(shape);
  assert.deepEqual(calls.selects, []);
  assert.deepEqual(calls.drags, ["note-1"]);
});

test("the eraser presses through the annotation to the page", () => {
  const { calls, shape } = renderShape(note, { tool: "eraser" });

  assert.equal(pressOn(shape), true, "the press should not be claimed");
  assert.deepEqual(calls.selects, []);
  assert.deepEqual(calls.drags, []);
  assert.deepEqual(calls.page, ["pointerdown"]);
});

test("the pencil presses through the annotation to the page", () => {
  const { calls, shape } = renderShape(note, { tool: "draw" });

  assert.deepEqual(calls.page, []);
  pressOn(shape);
  assert.deepEqual(calls.selects, []);
  assert.deepEqual(calls.drags, []);
  assert.deepEqual(calls.page, ["pointerdown"]);
});

test("a read-only document ignores presses on its annotations", () => {
  const { calls, shape } = renderShape(note, {
    readOnly: true,
    tool: "select",
  });

  assert.equal(pressOn(shape), true);
  assert.deepEqual(calls.selects, []);
  assert.deepEqual(calls.drags, []);
});

test("a right-click does not start a drag", () => {
  const { calls, shape } = renderShape(note, { tool: "select" });

  pressOn(shape, { button: 2, buttons: 2 });
  assert.deepEqual(calls.selects, []);
  assert.deepEqual(calls.drags, []);
});

test("the highlight tool moves a highlight it is pressed on", () => {
  const { calls, shape } = renderShape(highlight, { tool: "highlight" });

  assert.equal(pressOn(shape), false, "the press should be claimed");
  assert.deepEqual(calls.selects, ["highlight-1"]);
  assert.deepEqual(calls.drags, ["highlight-1"]);
  assert.deepEqual(calls.page, []);
});

test("the highlight tool swallows a press on an annotation it cannot move", () => {
  const { calls, shape } = renderShape(note, { tool: "highlight" });

  assert.equal(pressOn(shape), true, "no default is prevented");
  assert.deepEqual(calls.selects, []);
  assert.deepEqual(calls.drags, []);
  assert.deepEqual(calls.page, []);
});

test("hovering an annotation is reported both ways", () => {
  const { calls, shape } = renderShape(note);

  fireEvent.pointerEnter(shape);
  fireEvent.pointerLeave(shape);
  assert.deepEqual(calls.hovers, [true, false]);
});
