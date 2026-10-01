import assert from "node:assert/strict";
import { test } from "node:test";
import { fireEvent, render } from "@testing-library/react";
import { DocumentPaneErrorBoundary } from "../src/tabbedapp/DocumentPaneErrorBoundary";

function Thrower(): never {
  throw new Error("boom");
}

// React still logs a caught error to the console by design (getDerivedState FromError does not suppress that) - expected noise from these two tests, not a sign either one is wrong.

test("a render error in the document pane is caught, not left to take the whole shell down with it", () => {
  const { container } = render(
    <DocumentPaneErrorBoundary
      onCloseDocument={() => {}}
      onViewCrash={() => {}}
    >
      <Thrower />
    </DocumentPaneErrorBoundary>,
  );

  assert.ok(
    container.querySelector(".tabbedapp-document-pane-error"),
    "the boundary's fallback pane did not render",
  );
  assert.match(container.textContent ?? "", /failed to load/);
});

test("Close this tab, in the fallback, hands the closure back to the caller", () => {
  let closed = 0;
  const { getByRole } = render(
    <DocumentPaneErrorBoundary
      onCloseDocument={() => (closed += 1)}
      onViewCrash={() => {}}
    >
      <Thrower />
    </DocumentPaneErrorBoundary>,
  );

  fireEvent.click(getByRole("button", { name: "Close this tab" }));
  assert.equal(closed, 1);
});

test("a Reload page control is offered alongside it", () => {
  const { getByRole } = render(
    <DocumentPaneErrorBoundary
      onCloseDocument={() => {}}
      onViewCrash={() => {}}
    >
      <Thrower />
    </DocumentPaneErrorBoundary>,
  );

  assert.ok(getByRole("button", { name: "Reload page" }));
});

test("a child that does not throw renders normally, with no fallback in sight", () => {
  const { container, getByText } = render(
    <DocumentPaneErrorBoundary
      onCloseDocument={() => {}}
      onViewCrash={() => {}}
    >
      <p>All is well.</p>
    </DocumentPaneErrorBoundary>,
  );

  assert.ok(getByText("All is well."));
  assert.equal(container.querySelector(".tabbedapp-document-pane-error"), null);
});

// The shell has only the tab's parked copy left once the view is gone, and needs telling it is out of date.
test("a crash is reported to the caller, once", () => {
  let crashes = 0;
  render(
    <DocumentPaneErrorBoundary
      onCloseDocument={() => {}}
      onViewCrash={() => (crashes += 1)}
    >
      <Thrower />
    </DocumentPaneErrorBoundary>,
  );

  assert.equal(crashes, 1);
});
