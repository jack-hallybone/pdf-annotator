import assert from "node:assert/strict";
import { test } from "node:test";
import { act, renderHook } from "@testing-library/react";
import { useLatestRef } from "../src/useLatestRef";

// The contract worth pinning is the timing: the write happens in an effect, so
// `.current` still holds the previous value while the render that supplied the
// new one is running.

test("exposes the latest value after the render commits", () => {
  const { result, rerender } = renderHook(
    (value: number) => useLatestRef(value),
    {
      initialProps: 1,
    },
  );

  assert.equal(result.current.current, 1);
  rerender(2);
  assert.equal(result.current.current, 2);
});

test("the ref still holds the previous value DURING the render", () => {
  const seenDuringRender: number[] = [];
  const { rerender } = renderHook(
    (value: number) => {
      const ref = useLatestRef(value);
      seenDuringRender.push(ref.current);
      return ref;
    },
    { initialProps: 1 },
  );

  rerender(2);
  rerender(3);

  assert.deepEqual(seenDuringRender, [1, 1, 2]);
});

test("a caller may assign the ref itself to close the deferral window", () => {
  const { result, rerender } = renderHook(
    (value: number) => useLatestRef(value),
    {
      initialProps: 1,
    },
  );

  act(() => {
    result.current.current = 99;
  });
  assert.equal(result.current.current, 99);

  rerender(2);
  assert.equal(result.current.current, 2);
});

test("an unchanged value leaves the ref alone", () => {
  const { result, rerender } = renderHook(
    (value: number) => useLatestRef(value),
    {
      initialProps: 7,
    },
  );

  act(() => {
    result.current.current = 42;
  });
  rerender(7);
  assert.equal(result.current.current, 42);
});
