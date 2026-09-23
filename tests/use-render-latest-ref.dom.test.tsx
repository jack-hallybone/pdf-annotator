import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderHook } from "@testing-library/react";
import { useLatestRef } from "../src/useLatestRef";
import { useRenderLatestRef } from "../src/pdfdocumenteditor/useRenderLatestRef";

// This hook writes during render while its sibling `useLatestRef` catches up a
// commit later, and a test that only rerenders and then reads cannot tell them
// apart, because rerendering flushes effects.

test("the ref is already current DURING the render that supplied the value", () => {
  const seenDuringRender: number[] = [];
  const { rerender } = renderHook(
    (value: number) => {
      const ref = useRenderLatestRef(value);
      seenDuringRender.push(ref.current);
      return ref;
    },
    { initialProps: 1 },
  );

  rerender(2);
  rerender(3);

  assert.deepEqual(seenDuringRender, [1, 2, 3]);
});

test("it does not share useLatestRef timing", () => {
  const duringRenderFromRenderHook: number[] = [];
  const duringRenderFromEffectHook: number[] = [];
  const { rerender } = renderHook(
    (value: number) => {
      duringRenderFromRenderHook.push(useRenderLatestRef(value).current);
      duringRenderFromEffectHook.push(useLatestRef(value).current);
    },
    { initialProps: 1 },
  );

  rerender(2);
  rerender(3);

  // Both hooks agree on the first render and disagree from then on, so making
  // either one match the other fails here rather than shipping as a silent
  // one-commit lag.
  assert.deepEqual(duringRenderFromRenderHook, [1, 2, 3]);
  assert.deepEqual(duringRenderFromEffectHook, [1, 1, 2]);
});

test("the ref still holds the newest value after the commit", () => {
  const { result, rerender } = renderHook(
    (value: number) => useRenderLatestRef(value),
    {
      initialProps: 1,
    },
  );

  assert.equal(result.current.current, 1);
  rerender(2);
  assert.equal(result.current.current, 2);
});

test("an unchanged value is still rewritten, so nothing survives a re-render", () => {
  const { result, rerender } = renderHook(
    (value: number) => useRenderLatestRef(value),
    {
      initialProps: 7,
    },
  );

  result.current.current = 42;
  rerender(7);
  assert.equal(result.current.current, 7);
});

test("PdfPageView mirrors through the render-time hook, not the deferred one", () => {
  // The swap that breaks the component's own guarantee is invisible: `useLatestRef`
  // has the same signature, a near-identical name and no type or lint difference,
  // and nothing renderable under jsdom observes the lag, so the choice is pinned
  // at the source level instead.
  const source = readFileSync(
    fileURLToPath(
      new URL("../src/pdfdocumenteditor/PdfPageView.tsx", import.meta.url),
    ),
    "utf8",
  );

  assert.match(source, /useRenderLatestRef/);
  assert.doesNotMatch(
    source,
    /useLatestRef/,
    "PdfPageView mirrors are read by stable callbacks and once-registered " +
      "window listeners; the effect-deferred hook would hand them the " +
      "previous render",
  );
});
