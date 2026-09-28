import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import "./rendererAssetStubs";
import type { TabbedAppHostAdapter } from "../src/tabbedapp/fileHost";

// pdf.js's browser entry touches these while it is evaluated, even with nothing rendering to a canvas (see documentModelHarness.tsx); jsdom has none of the three.
class FakeImageData {}
class FakePath2D {}
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const globals = globalThis as {
  ImageData?: unknown;
  Path2D?: unknown;
  ResizeObserver?: unknown;
  __PRODUCT_NAME__?: string;
};
globals.ImageData ??= FakeImageData;
globals.Path2D ??= FakePath2D;
globals.ResizeObserver ??= FakeResizeObserver;
// Vite's `define` build-time replacement, absent under the plain Node runner.
globals.__PRODUCT_NAME__ ??= "PDF Annotator";

// TabbedAppShell pulls in the document editor's stylesheet through a long import chain; rendererAssetStubs' hook has to be registered first, so this import is dynamic.
const { TabbedAppShell } = await import("../src/tabbedapp/TabbedAppShell");

function hostAdapter(): TabbedAppHostAdapter {
  return {
    pickPdfDocuments: async () => ({ documents: [] }),
  };
}

// Files, not text or a link: this is the shape whose default handling is a browser navigation, exactly what a locked shell must not fall through to.
function fileDrag() {
  return {
    types: ["Files"],
    files: [new File([], "dropped.pdf", { type: "application/pdf" })],
  };
}

// A document mid-load locks the shell the same way a mid-save does - both just set shellLocked - so a loader that never resolves holds the lock open for the whole test with no race to win.
function lockedInitialDocument() {
  return {
    source: {
      kind: "loader" as const,
      name: "locked.pdf",
      loadBytes: () => new Promise<Uint8Array>(() => {}),
    },
  };
}

async function renderLockedShell() {
  const { container } = render(
    <TabbedAppShell
      fileAdapter={hostAdapter()}
      initialDocuments={[lockedInitialDocument()]}
    />,
  );

  const shell = container.querySelector(".tabbedapp-shell");
  assert.ok(shell, "the shell root did not render");
  await waitFor(() => assert.equal(shell.getAttribute("data-busy"), "true"), {
    timeout: 10_000,
  });

  return { container, shell };
}

test("a file dragged over a locked shell is refused by this app, not the browser", async () => {
  const { container, shell } = await renderLockedShell();

  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    const event = createEvent[type](shell, { dataTransfer: fileDrag() });
    fireEvent(shell, event);
    assert.equal(
      event.defaultPrevented,
      true,
      `${type} did not prevent the browser's own navigation while locked`,
    );
  }

  // Locked means locked: the drop must still be a no-op, not merely prevented - it must not have opened the file or shown the drop overlay.
  assert.equal(
    container.querySelectorAll(".tabbedapp-document-tab").length,
    1,
    "the locked drop opened another tab",
  );
  assert.equal(
    container.querySelector(".tabbedapp-drop-backdrop"),
    null,
    "the locked shell still reacted to the drag visually",
  );
});
