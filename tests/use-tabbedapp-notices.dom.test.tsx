import assert from "node:assert/strict";
import { test } from "node:test";
import { act, renderHook } from "@testing-library/react";
import { useTabbedAppNotices } from "../src/tabbedapp/useTabbedAppNotices";

test("re-showing the same message refreshes instead of stacking a duplicate", () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() => result.current.showNotice("Could not save."));
  act(() => result.current.showNotice("Could not save."));

  assert.equal(result.current.notices.length, 1);
  // The refreshed notice is a new entry with a fresh id.
  assert.equal(result.current.notices[0].message, "Could not save.");
});

test("distinct messages stack in order", () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() => result.current.showNotice("First"));
  act(() => result.current.showNotice("Second"));

  assert.deepEqual(
    result.current.notices.map((notice) => notice.message),
    ["First", "Second"],
  );
});

test("reportMalformedAnnotations ignores zero and pluralises", () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() => result.current.reportMalformedAnnotations(0));
  assert.equal(result.current.notices.length, 0);

  act(() => result.current.reportMalformedAnnotations(1));
  assert.match(result.current.notices[0].message, /^1 annotation could not/);

  act(() => result.current.reportMalformedAnnotations(3));
  assert.match(result.current.notices[1].message, /^3 annotations could not/);
});

// The tone decides how insistently a screen reader announces it - `danger`
// renders role="alert" and interrupts - and a file that merely arrived with an
// annotation we cannot draw has broken nothing of the reader's.
test("a malformed-annotation report warns rather than alarms", () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() => result.current.reportMalformedAnnotations(1));
  assert.equal(result.current.notices[0].tone, "warning");
});

// A message about something that did not happen has to still be there when the
// reader looks back at the screen.
test("a danger notice stays until it is dismissed", async () => {
  // A short default, so "never expires" is distinguishable from "expires in ten
  // seconds" without the test taking ten seconds.
  const { result } = renderHook(() =>
    useTabbedAppNotices({ defaultDurationMs: 20 }),
  );

  act(() => result.current.showNotice("Could not save.", { tone: "danger" }));
  act(() => result.current.showNotice("Just so you know", { tone: "warning" }));
  assert.equal(result.current.notices.length, 2);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.deepEqual(
    result.current.notices.map((notice) => notice.tone),
    ["danger"],
    "the danger notice should outlive the warning that shared its default",
  );

  act(() => result.current.dismissNotice(result.current.notices[0].id));
  assert.equal(result.current.notices.length, 0);
});

test("an explicit duration still overrides the tone default", async () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() =>
    result.current.showNotice("Urgent but brief", {
      tone: "danger",
      durationMs: 20,
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  assert.equal(result.current.notices.length, 0);
});

// Hovering or tabbing into the stack pauses every countdown, so a notice cannot
// disappear out from under whoever is reading it.
test("pausing holds a notice past its duration, and resuming releases it", async () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() => result.current.showNotice("Held", { durationMs: 30 }));
  act(() => result.current.pauseNoticeTimers());

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.equal(
    result.current.notices.length,
    1,
    "a paused notice expired anyway",
  );

  act(() => result.current.resumeNoticeTimers());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  assert.equal(
    result.current.notices.length,
    0,
    "a resumed notice never expired",
  );
});

// A notice raised while the pointer is already on the stack would otherwise be
// the one message that ignores the pause.
test("a notice raised while paused does not start counting down", async () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() => result.current.pauseNoticeTimers());
  act(() =>
    result.current.showNotice("Arrived during a hover", { durationMs: 20 }),
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.equal(result.current.notices.length, 1);
});

test("auto-dismiss timer removes the notice when it elapses", async () => {
  const { result } = renderHook(() => useTabbedAppNotices());

  act(() => result.current.showNotice("Temporary", { durationMs: 20 }));
  assert.equal(result.current.notices.length, 1);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.equal(result.current.notices.length, 0);
});
