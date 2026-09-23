import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { useRef } from "react";
import { act, render, cleanup } from "@testing-library/react";
import { useFocusTrap } from "../src/tabbedapp/useFocusTrap";

// The hook filters its focusable list by getBoundingClientRect, and jsdom has no
// layout, so an all-zero rect for everything would leave the list empty and make
// every test here pass for the wrong reason.
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: Element,
  ) {
    const zero = (this as HTMLElement).dataset?.zeroSize !== undefined;
    const size = zero ? 0 : 20;
    return {
      width: size,
      height: size,
      top: 0,
      left: 0,
      right: size,
      bottom: size,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  cleanup();
});

// `mounted` is deliberately separate from `active`: a dialog on screen but not
// trapping is the only arrangement that tells "the hook respects the active
// flag" apart from "the container ref happens to be null".
function Dialog({
  active,
  mounted = active,
  withFallback = false,
  leading = null,
  extra = null,
}: {
  active: boolean;
  mounted?: boolean;
  withFallback?: boolean;
  leading?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(containerRef, active, withFallback ? fallbackRef : undefined);

  return (
    <>
      <button type="button" data-testid="outside">
        Outside
      </button>
      <button type="button" ref={fallbackRef} data-testid="fallback">
        Fallback
      </button>
      {mounted ? (
        <div ref={containerRef} role="dialog" aria-modal="true">
          {leading}
          <button type="button" data-testid="first">
            First
          </button>
          {extra}
          <button type="button" data-testid="last">
            Last
          </button>
        </div>
      ) : null}
    </>
  );
}

const tab = (shiftKey = false) => {
  const event = new window.KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
};

const testId = () =>
  (document.activeElement as HTMLElement | null)?.dataset.testid ?? null;

test("focus moves into the dialog when it opens", () => {
  render(<Dialog active />);
  assert.equal(testId(), "first");
});

test("Tab off the last control wraps to the first", () => {
  const { getByTestId } = render(<Dialog active />);
  act(() => getByTestId("last").focus());

  const event = tab();
  assert.equal(event.defaultPrevented, true, "the trap must take the Tab");
  assert.equal(testId(), "first");
});

test("Shift+Tab off the first control wraps to the last", () => {
  const { getByTestId } = render(<Dialog active />);
  act(() => getByTestId("first").focus());

  const event = tab(true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(testId(), "last");
});

test("focus that has escaped the dialog is pulled back in", () => {
  const { getByTestId } = render(<Dialog active />);
  act(() => getByTestId("outside").focus());

  tab();
  assert.equal(testId(), "first");
});

test("Tab between interior controls is not intercepted", () => {
  const { getByTestId } = render(
    <Dialog
      active
      extra={
        <button type="button" data-testid="middle">
          Middle
        </button>
      }
    />,
  );
  act(() => getByTestId("middle").focus());

  const event = tab();
  assert.equal(event.defaultPrevented, false);
});

// The zero-sized control goes at the edge of the list, not the middle: in the
// middle the wrap targets are the first and last visible controls either way, so
// it would pass against a hook with no visibility filter at all.
test("a control with no layout is not a place Tab can land", () => {
  const { getByTestId } = render(
    <Dialog
      active
      leading={
        <button type="button" data-testid="hidden" data-zero-size="">
          Hidden
        </button>
      }
    />,
  );

  assert.equal(testId(), "first");

  act(() => getByTestId("last").focus());
  tab();
  assert.equal(testId(), "first", "Tab wrapped onto a control with no layout");
});

test("focus returns to whatever had it when the dialog closes", () => {
  const { getByTestId, rerender } = render(<Dialog active={false} />);
  act(() => getByTestId("outside").focus());

  rerender(<Dialog active />);
  assert.equal(testId(), "first");

  rerender(<Dialog active={false} />);
  assert.equal(testId(), "outside");
});

// The control that opened the dialog is gone by the time it closes - a menu item
// whose menu closed with it - and without the fallback focus lands on <body>.
test("focus falls back when the opener has left the document", () => {
  const { rerender } = render(<Dialog active={false} withFallback />);

  const opener = document.createElement("button");
  document.body.append(opener);
  act(() => opener.focus());

  rerender(<Dialog active withFallback />);
  opener.remove();

  rerender(<Dialog active={false} withFallback />);
  assert.equal(testId(), "fallback");
});

test("a departed opener and no fallback is survivable", () => {
  const { rerender } = render(<Dialog active={false} />);

  const opener = document.createElement("button");
  document.body.append(opener);
  act(() => opener.focus());

  rerender(<Dialog active />);
  opener.remove();

  assert.doesNotThrow(() => rerender(<Dialog active={false} />));
});

test("an inactive trap leaves focus and Tab alone", () => {
  const { getByTestId } = render(<Dialog active={false} mounted />);
  act(() => getByTestId("outside").focus());

  const event = tab();
  assert.equal(event.defaultPrevented, false, "an inactive trap took the Tab");
  assert.equal(testId(), "outside", "an inactive trap moved focus");
});
