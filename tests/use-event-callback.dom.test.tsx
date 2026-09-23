import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { forwardRef, memo, useEffect, useEffectEvent } from "react";
import { render } from "@testing-library/react";
import { useEventCallback } from "../src/useEventCallback";

// The same probe is mounted three ways - a plain function component, a
// `forwardRef` and a `memo` - because only the first of the three gets React's
// closure swap, and "a stable callback sees the latest value" would pass either
// way.

function probeBody(seen: number[], hook: "local" | "react") {
  return function Probe({ value }: { value: number }) {
    const fromReact = useEffectEvent(() => seen.push(value));
    const fromLocal = useEventCallback(() => seen.push(value));
    const event = hook === "react" ? fromReact : fromLocal;
    useEffect(() => {
      event();
    }, [event, value]);
    return null;
  };
}

function renderThreeTimes(Probe: (props: { value: number }) => null) {
  const Component = Probe as unknown as React.ComponentType<{ value: number }>;
  const { rerender } = render(<Component value={1} />);
  rerender(<Component value={2} />);
  rerender(<Component value={3} />);
}

test("the callback runs the latest render's closure in a plain component", () => {
  const seen: number[] = [];
  renderThreeTimes(probeBody(seen, "local"));
  assert.deepEqual(seen, [1, 2, 3]);
});

test("...and in a forwardRef component, where React's own does not", () => {
  const local: number[] = [];
  const Local = probeBody(local, "local");
  renderThreeTimes(
    forwardRef<null, { value: number }>(function Local_(props, ref) {
      void ref;
      return Local(props);
    }) as unknown as (props: { value: number }) => null,
  );
  assert.deepEqual(local, [1, 2, 3]);

  // If this ever reads [1, 2, 3], React has fixed its own hook and this whole
  // module can go.
  const fromReact: number[] = [];
  const React_ = probeBody(fromReact, "react");
  renderThreeTimes(
    forwardRef<null, { value: number }>(function React__(props, ref) {
      void ref;
      return React_(props);
    }) as unknown as (props: { value: number }) => null,
  );
  assert.deepEqual(
    fromReact,
    [1, 1, 1],
    "React's useEffectEvent now updates inside forwardRef - re-check whether " +
      "src/useEventCallback.ts is still needed",
  );
});

test("...and in a memo component, where React's own does not either", () => {
  const local: number[] = [];
  renderThreeTimes(
    memo(probeBody(local, "local")) as unknown as (props: {
      value: number;
    }) => null,
  );
  assert.deepEqual(local, [1, 2, 3]);

  const fromReact: number[] = [];
  renderThreeTimes(
    memo(probeBody(fromReact, "react")) as unknown as (props: {
      value: number;
    }) => null,
  );
  assert.deepEqual(
    fromReact,
    [1, 1, 1],
    "React's useEffectEvent now updates inside memo - re-check whether " +
      "src/useEventCallback.ts is still needed",
  );
});

// The tests above mount their own probe, so they cannot see a call site that
// switched back, and a plain function component may be wrapped in forwardRef or
// memo tomorrow.
test("nothing in src uses React's useEffectEvent", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : /\.[cm]?[jt]sx?$/i.test(entry.name)
          ? [path]
          : [];
    });

  const files = sourceFiles(srcRoot).filter(
    (path) => path !== join(srcRoot, "useEventCallback.ts"),
  );
  // A scan that found no files proves nothing, and a filter that excluded
  // everything would too.
  assert.ok(files.length > 40, `expected to scan src, saw ${files.length}`);
  assert.equal(
    sourceFiles(srcRoot).length - files.length,
    1,
    "the one exempted module is no longer there",
  );

  const offenders = files.filter((path) =>
    /\buseEffectEvent\b/.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(
    offenders.map((path) => path.slice(srcRoot.length + 1)),
    [],
    "useEffectEvent is frozen at its mount closure inside forwardRef and " +
      "memo components; use useEventCallback (src/useEventCallback.ts)",
  );
});
