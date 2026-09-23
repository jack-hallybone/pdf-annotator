import assert from "node:assert/strict";
import test from "node:test";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  clientPointToViewportPoint,
  eventToPdfPoint,
  eventToPdfPointFromElement,
  eventToPdfPoints,
  eventToPdfPointsFromElement,
  eventToViewportPoint,
  nearestTextHitRect,
} from "../src/pdfdocumenteditor/pagePointerGeometry";
import type { TextHitRect } from "../src/pdfdocumenteditor/pagePointerGeometry";
import type { PageViewport } from "../src/pdfdocumenteditor/types";

// A pointer arrives in client coordinates and has to come back out in PDF user
// space, so three transforms stack on every sample - subtract where the page
// sits on screen, divide by how big it is drawn, flip through pdf.js's viewport
// - and getting any of them wrong offsets every annotation without erroring.

const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;

// A stand-in for pdf.js's viewport, unrotated: it scales and flips the y axis.
function viewportAtZoom(zoom: number) {
  return {
    width: PAGE_WIDTH_PT * zoom,
    height: PAGE_HEIGHT_PT * zoom,
    scale: zoom,
    rotation: 0,
    convertToPdfPoint: (x: number, y: number) => [
      x / zoom,
      PAGE_HEIGHT_PT - y / zoom,
    ],
  } as unknown as PageViewport;
}

function pageRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  } as DOMRect;
}

type Sample = { clientX: number; clientY: number };

function pointerEvent(
  { clientX, clientY }: Sample,
  bounds: DOMRect,
  coalesced?: Sample[],
) {
  const nativeEvent = {
    clientX,
    clientY,
    ...(coalesced ? { getCoalescedEvents: () => coalesced } : {}),
  };
  return {
    currentTarget: { getBoundingClientRect: () => bounds },
    nativeEvent,
  } as unknown as ReactPointerEvent<SVGSVGElement>;
}

function pointerEventInsidePage(
  { clientX, clientY }: Sample,
  bounds: DOMRect | null,
) {
  return {
    currentTarget: {
      closest: (selector: string) =>
        selector === ".pdfdocumenteditor-page" && bounds
          ? { getBoundingClientRect: () => bounds }
          : null,
    },
    nativeEvent: { clientX, clientY },
  } as unknown as ReactPointerEvent<Element>;
}

test("a pointer over the page maps to the PDF point beneath it", () => {
  const viewport = viewportAtZoom(1);
  const bounds = pageRect(100, 50, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);

  // One inch in and one inch down from the page's top-left corner, so 72 across
  // and 72 up from the bottom edge.
  const event = pointerEvent({ clientX: 172, clientY: 122 }, bounds);

  assert.deepEqual(eventToPdfPoint(event, viewport), { x: 72, y: 720 });
});

test("scrolling the page changes which PDF point a fixed pointer is over", () => {
  const viewport = viewportAtZoom(1);
  const stillPointer = { clientX: 172, clientY: 122 };

  const scrolled = pageRect(100, -250, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);
  assert.deepEqual(
    eventToPdfPoint(pointerEvent(stillPointer, scrolled), viewport),
    { x: 72, y: 420 },
  );

  const followed = pointerEvent({ clientX: 172, clientY: -178 }, scrolled);
  assert.deepEqual(eventToPdfPoint(followed, viewport), { x: 72, y: 720 });
});

test("zooming in makes the same PDF point twice as far across the screen", () => {
  const viewport = viewportAtZoom(2);
  const bounds = pageRect(0, 0, PAGE_WIDTH_PT * 2, PAGE_HEIGHT_PT * 2);

  assert.deepEqual(
    eventToPdfPoint(
      pointerEvent({ clientX: 144, clientY: 144 }, bounds),
      viewport,
    ),
    { x: 72, y: 720 },
  );

  assert.deepEqual(
    eventToPdfPoint(
      pointerEvent({ clientX: 72, clientY: 72 }, bounds),
      viewport,
    ),
    { x: 36, y: 756 },
  );
});

test("the page's measured size, not the viewport's, sets the scale", () => {
  // A CSS transform (the smooth-zoom preview) can leave the element drawn at a
  // different size than the viewport it was rendered for, and the element on
  // screen is what the pointer is over.
  const viewport = viewportAtZoom(1);
  const halfSize = pageRect(0, 0, PAGE_WIDTH_PT / 2, PAGE_HEIGHT_PT / 2);

  assert.deepEqual(
    eventToPdfPoint(
      pointerEvent({ clientX: 36, clientY: 36 }, halfSize),
      viewport,
    ),
    { x: 72, y: 720 },
  );
});

test("each axis is scaled by its own dimension", () => {
  const viewport = viewportAtZoom(1);
  const squeezed = pageRect(0, 0, PAGE_WIDTH_PT / 2, PAGE_HEIGHT_PT);

  assert.deepEqual(
    eventToPdfPoint(
      pointerEvent({ clientX: 36, clientY: 72 }, squeezed),
      viewport,
    ),
    { x: 72, y: 720 },
  );
});

test("a pointer dragged off the page is clamped to the page", () => {
  const viewport = viewportAtZoom(1);
  const bounds = pageRect(100, 50, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);

  const event = pointerEvent({ clientX: 900, clientY: 10 }, bounds);
  assert.deepEqual(eventToPdfPoint(event, viewport), {
    x: PAGE_WIDTH_PT,
    y: PAGE_HEIGHT_PT,
  });

  const other = pointerEvent({ clientX: 20, clientY: 5000 }, bounds);
  assert.deepEqual(eventToPdfPoint(other, viewport), { x: 0, y: 0 });
});

test("every coalesced sample is mapped, in order, so fast strokes keep their shape", () => {
  const viewport = viewportAtZoom(1);
  const bounds = pageRect(100, 50, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);

  const event = pointerEvent({ clientX: 244, clientY: 194 }, bounds, [
    { clientX: 172, clientY: 122 },
    { clientX: 208, clientY: 158 },
    { clientX: 244, clientY: 194 },
  ]);

  assert.deepEqual(eventToPdfPoints(event, viewport), [
    { x: 72, y: 720 },
    { x: 108, y: 684 },
    { x: 144, y: 648 },
  ]);
  assert.deepEqual(eventToPdfPoint(event, viewport), { x: 144, y: 648 });
});

test("a coalesced batch that stops short of the event gets the event appended", () => {
  const viewport = viewportAtZoom(1);
  const bounds = pageRect(100, 50, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);

  const event = pointerEvent({ clientX: 244, clientY: 194 }, bounds, [
    { clientX: 172, clientY: 122 },
  ]);

  assert.deepEqual(eventToPdfPoints(event, viewport), [
    { x: 72, y: 720 },
    { x: 144, y: 648 },
  ]);
});

test("a browser without coalesced events still yields the one delivered sample", () => {
  const viewport = viewportAtZoom(1);
  const bounds = pageRect(100, 50, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);
  const event = pointerEvent({ clientX: 172, clientY: 122 }, bounds);

  assert.deepEqual(eventToPdfPoints(event, viewport), [{ x: 72, y: 720 }]);
});

test("an event on a child element resolves against its page, not the child", () => {
  const viewport = viewportAtZoom(1);
  const bounds = pageRect(100, 50, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);
  const event = pointerEventInsidePage({ clientX: 172, clientY: 122 }, bounds);

  assert.deepEqual(eventToPdfPointFromElement(event, viewport), {
    x: 72,
    y: 720,
  });
  assert.deepEqual(eventToPdfPointsFromElement(event, viewport), [
    { x: 72, y: 720 },
  ]);
});

test("an event with no page above it yields no points rather than a bogus one", () => {
  const viewport = viewportAtZoom(1);
  const orphan = pointerEventInsidePage({ clientX: 172, clientY: 122 }, null);

  assert.deepEqual(eventToPdfPointsFromElement(orphan, viewport), []);
  assert.deepEqual(eventToPdfPointFromElement(orphan, viewport), {
    x: 0,
    y: 0,
  });
});

test("eventToViewportPoint stops at page pixels and does not flip the y axis", () => {
  const viewport = viewportAtZoom(1);
  const bounds = pageRect(100, 50, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);
  const event = pointerEvent({ clientX: 172, clientY: 122 }, bounds);

  assert.deepEqual(eventToViewportPoint(event, viewport), { x: 72, y: 72 });
});

test("clientPointToViewportPoint is the shared first half of both", () => {
  const viewport = viewportAtZoom(2);
  const bounds = pageRect(100, -250, PAGE_WIDTH_PT * 2, PAGE_HEIGHT_PT * 2);

  assert.deepEqual(clientPointToViewportPoint(244, 74, bounds, viewport), {
    x: 144,
    y: 324,
  });
});

const textRect = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
) =>
  ({
    viewportRect: { x, y, width, height },
    text: id,
  }) as unknown as TextHitRect;

test("nearestTextHitRect picks the closest run the pointer is within reach of", () => {
  const rects = [
    textRect("first", 0, 0, 100, 12),
    textRect("second", 0, 40, 100, 12),
  ];
  const tolerance = { x: 20, y: 20 };

  assert.equal(
    nearestTextHitRect({ x: 50, y: 6 }, rects, tolerance)?.text,
    "first",
  );
  assert.equal(
    nearestTextHitRect({ x: 50, y: 30 }, rects, tolerance)?.text,
    "second",
  );
});

test("nearestTextHitRect refuses a run further away than the tolerance", () => {
  const rects = [textRect("first", 0, 0, 100, 12)];

  assert.ok(nearestTextHitRect({ x: 50, y: 20 }, rects, { x: 20, y: 20 }));
  assert.equal(
    nearestTextHitRect({ x: 50, y: 20 }, rects, { x: 20, y: 4 }),
    null,
  );
  assert.equal(
    nearestTextHitRect({ x: 200, y: 6 }, rects, { x: 20, y: 20 }),
    null,
  );
});
