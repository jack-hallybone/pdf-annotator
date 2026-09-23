import assert from "node:assert/strict";
import { test } from "node:test";
import { act, renderHook } from "@testing-library/react";
import type {
  PageViewport,
  ToolSettings,
} from "../src/pdfdocumenteditor/types";
import "./rendererAssetStubs";

// The hook reaches pdfRender through inkRendering, so this import has to be
// dynamic: it must run after the stubs the side-effect import above registers.
const { useDraftInk } = await import("../src/pdfdocumenteditor/useDraftInk");

// The hook's canvases are never attached here, so every paint path bails at its
// own null-canvas guard and what is left under test is the draft state machine
// PdfPageView's handlers branch on.

// The draft path only ever reads viewport.userUnit.
const viewport = { userUnit: 1 } as PageViewport;

const toolSettings = {
  drawColor: [0, 0, 0],
  drawOpacity: 1,
  drawWidth: 2,
  eraserWidth: 16,
  highlightColor: [1, 1, 0],
  highlightOpacity: 0.4,
  highlightWidth: 12,
  noteColor: [1, 0.9, 0.3],
  textColor: [0, 0, 0],
  textFontSize: 12,
  textOpacity: 1,
} as unknown as ToolSettings;

function renderDraftInk() {
  return renderHook(() =>
    useDraftInk({
      displaySize: { height: 800, width: 600 },
      scale: 1,
      toolSettings,
      viewport,
    }),
  );
}

test("begin records the kind and origin captured at pointerdown", () => {
  const { result } = renderDraftInk();
  act(() =>
    result.current.begin("freehandHighlight", "pageDiv", { x: 1, y: 2 }),
  );

  const draft = result.current.current();
  assert.equal(draft?.kind, "freehandHighlight");
  assert.equal(draft?.origin, "pageDiv");
  assert.deepEqual(draft?.path, [{ x: 1, y: 2 }]);
});

test("begin replaces an unfinished draft rather than merging into it", () => {
  const { result } = renderDraftInk();
  act(() => result.current.begin("draw", "svg", { x: 0, y: 0 }));
  act(() => result.current.append([{ x: 50, y: 50 }]));
  act(() =>
    result.current.begin("freehandHighlight", "pageDiv", { x: 9, y: 9 }),
  );

  const draft = result.current.current();
  assert.equal(draft?.kind, "freehandHighlight");
  assert.deepEqual(draft?.path, [{ x: 9, y: 9 }]);
});

test("append extends the live path and returns it", () => {
  const { result } = renderDraftInk();
  act(() => result.current.begin("draw", "svg", { x: 0, y: 0 }));

  let returned: { x: number; y: number }[] = [];
  act(() => {
    returned = result.current.append([
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ]);
  });

  assert.deepEqual(returned, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ]);
  assert.equal(returned, result.current.current()?.path);
});

test("append drops samples closer together than the capture spacing", () => {
  const { result } = renderDraftInk();
  act(() => result.current.begin("draw", "svg", { x: 0, y: 0 }));
  act(() => result.current.append([{ x: 0.0001, y: 0 }]));

  assert.deepEqual(result.current.current()?.path, [{ x: 0, y: 0 }]);
});

test("append without a draft is a no-op and returns an empty path", () => {
  const { result } = renderDraftInk();
  let returned: { x: number; y: number }[] = [];
  act(() => {
    returned = result.current.append([{ x: 5, y: 5 }]);
  });

  assert.deepEqual(returned, []);
  assert.equal(result.current.current(), null);
});

test("end clears the draft and is safe to call twice", () => {
  const { result } = renderDraftInk();
  act(() => result.current.begin("draw", "svg", { x: 0, y: 0 }));
  act(() => result.current.end());
  assert.equal(result.current.current(), null);
  act(() => result.current.end());
  assert.equal(result.current.current(), null);
});

test("ending a gesture cancels the pending repaint frame", () => {
  const scheduled: number[] = [];
  const cancelled: number[] = [];
  const realRequest = window.requestAnimationFrame;
  const realCancel = window.cancelAnimationFrame;
  let nextHandle = 1;
  window.requestAnimationFrame = () => {
    const handle = nextHandle++;
    scheduled.push(handle);
    return handle;
  };
  window.cancelAnimationFrame = (handle: number) => {
    cancelled.push(handle);
  };

  try {
    const { result } = renderDraftInk();
    act(() => result.current.begin("draw", "svg", { x: 0, y: 0 }));
    assert.equal(scheduled.length, 1);
    act(() => result.current.append([{ x: 40, y: 0 }]));
    assert.equal(scheduled.length, 1);
    act(() => result.current.end());
    assert.deepEqual(cancelled, scheduled);
  } finally {
    window.requestAnimationFrame = realRequest;
    window.cancelAnimationFrame = realCancel;
  }
});

test("unmounting mid-stroke cancels the pending repaint frame", () => {
  const scheduled: number[] = [];
  const cancelled: number[] = [];
  const realRequest = window.requestAnimationFrame;
  const realCancel = window.cancelAnimationFrame;
  let nextHandle = 1;
  window.requestAnimationFrame = () => {
    const handle = nextHandle++;
    scheduled.push(handle);
    return handle;
  };
  window.cancelAnimationFrame = (handle: number) => {
    cancelled.push(handle);
  };

  try {
    const { result, unmount } = renderDraftInk();
    act(() => result.current.begin("draw", "svg", { x: 0, y: 0 }));
    unmount();
    assert.deepEqual(cancelled, scheduled);
  } finally {
    window.requestAnimationFrame = realRequest;
    window.cancelAnimationFrame = realCancel;
  }
});
