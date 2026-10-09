import assert from "node:assert/strict";
import { test } from "node:test";
import { createRef, type ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { FindBar } from "../src/tabbedapp/components/FindBar";
import { TabbedAppNoticeStack } from "../src/tabbedapp/components/TabbedAppNotices";

// The bar rides in the notice stack, which holds its notices while focus is among them so that a reader has time for one; someone searching is not reading them.
test("focus in the find bar leaves the notices counting down", () => {
  let pauses = 0;
  render(
    <TabbedAppNoticeStack
      notices={[{ id: 1, message: "Saved." }]}
      onDismissNotice={() => {}}
      onPauseTimers={() => {
        pauses += 1;
      }}
      onResumeTimers={() => {}}
    >
      <Bar />
    </TabbedAppNoticeStack>,
  );

  screen.getByRole("textbox", { name: "Find in document" }).focus();
  assert.equal(pauses, 0);

  // A notice's own button still holds them.
  screen.getByRole("button", { name: "Dismiss notification" }).focus();
  assert.equal(pauses, 1);
});

test("the key that ends an IME composition is left to it, by the bar and the document's shortcuts alike", () => {
  const keys: string[] = [];
  render(
    <Bar
      onClose={() => keys.push("close")}
      onNext={() => keys.push("next")}
      onPrevious={() => keys.push("previous")}
    />,
  );
  const field = screen.getByRole("textbox", { name: "Find in document" });
  // The document's shortcuts listen on the window, where Escape takes focus out of the field.
  const reachedWindow: string[] = [];
  const listenAsShortcuts = (event: KeyboardEvent) => {
    reachedWindow.push(event.key);
  };
  window.addEventListener("keydown", listenAsShortcuts);

  fireEvent.keyDown(field, { isComposing: true, key: "Enter" });
  fireEvent.keyDown(field, { isComposing: true, key: "Escape" });
  // Safari ends the composition before its key arrives, and marks the key only by this.
  fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
  window.removeEventListener("keydown", listenAsShortcuts);
  assert.deepEqual(keys, []);
  assert.deepEqual(reachedWindow, []);

  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(field, { key: "Escape" });
  assert.deepEqual(keys, ["next", "previous", "close"]);
});

function Bar(props: Partial<ComponentProps<typeof FindBar>>) {
  return (
    <FindBar
      inputRef={createRef<HTMLInputElement>()}
      onClose={() => {}}
      onNext={() => {}}
      onPrevious={() => {}}
      onQueryChange={() => {}}
      query="harbour"
      results={{ complete: true, current: 1, total: 5 }}
      {...props}
    />
  );
}
