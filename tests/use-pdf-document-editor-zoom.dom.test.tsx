import assert from "node:assert/strict";
import { test } from "node:test";
import { useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { usePdfDocumentEditorZoom } from "../src/pdfdocumenteditor/usePdfDocumentEditorZoom";
import type { LoadedPage } from "../src/pdfdocumenteditor/types";

// An empty, container-less host: the scroll anchoring and fit paths
// early-return without a container, leaving the scale arithmetic and clamping.
function useZoomHarness() {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const pagesRef = useRef<LoadedPage[]>([]);
  return usePdfDocumentEditorZoom({
    scrollContainerRef,
    pagesRef,
    pages: [],
    pageSize: null,
    activePageIndex: 0,
  });
}

const ACTUAL_SIZE = 1.75;
const MIN = 0.2;
const MAX = 6;

test("starts at the actual-size zoom", () => {
  const { result } = renderHook(() => useZoomHarness());
  assert.equal(result.current.scale, ACTUAL_SIZE);
});

test("updateZoom adds a delta", () => {
  const { result } = renderHook(() => useZoomHarness());
  act(() => result.current.updateZoom(0.25));
  assert.equal(Number(result.current.scale.toFixed(2)), 2.0);
});

test("updateZoom clamps at both ends", () => {
  const { result } = renderHook(() => useZoomHarness());
  act(() => result.current.updateZoom(100));
  assert.equal(result.current.scale, MAX);
  act(() => result.current.updateZoom(-100));
  assert.equal(result.current.scale, MIN);
});

test("setZoom clamps out-of-range values", () => {
  const { result } = renderHook(() => useZoomHarness());
  act(() => result.current.setZoom(999));
  assert.equal(result.current.scale, MAX);
  act(() => result.current.setZoom(-999));
  assert.equal(result.current.scale, MIN);
});

test("resetZoom returns to actual size", () => {
  const { result } = renderHook(() => useZoomHarness());
  act(() => result.current.setZoom(3));
  assert.equal(result.current.scale, 3);
  act(() => result.current.resetZoom());
  assert.equal(result.current.scale, ACTUAL_SIZE);
});

test("setScale sets the raw value without clamping (restore/reset path)", () => {
  const { result } = renderHook(() => useZoomHarness());
  // setScale is the direct setter used by session restore; it does not clamp.
  act(() => result.current.setScale(4.2));
  assert.equal(result.current.scale, 4.2);
});

test("fit helpers are safe no-ops without a scroll container", () => {
  const { result } = renderHook(() => useZoomHarness());
  act(() => result.current.setZoom(2));
  act(() => {
    result.current.fitZoomToPageWidth();
    result.current.fitZoomToPageHeight();
  });
  // No container/page metrics available, so scale is unchanged.
  assert.equal(result.current.scale, 2);
});
