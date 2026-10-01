import assert from "node:assert/strict";
import { test } from "node:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { PDFDocument } from "pdf-lib";
import "./rendererAssetStubs";
import type { TabbedAppHostAdapter } from "../src/tabbedapp/fileHost";

// Same trio of shims tabbedapp-shell-drop-lock.dom.test.tsx registers: pdf.js's
// browser entry touches these while it is evaluated, even with nothing rendering
// to a canvas (see documentModelHarness.tsx); jsdom has none of the three.
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
globals.__PRODUCT_NAME__ ??= "PDF Annotator";

// TabbedAppShell pulls in the document editor's stylesheet through a long import chain; rendererAssetStubs' hook has to be registered first, so this import is dynamic.
const { TabbedAppShell } = await import("../src/tabbedapp/TabbedAppShell");

function hostAdapter(): TabbedAppHostAdapter {
  return {
    pickPdfDocuments: async () => ({ documents: [] }),
  };
}

async function onePagePdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([300, 300]);
  return pdfDoc.save({ useObjectStreams: false });
}

async function renderShellWithOpenTabs(names: string[]) {
  const bytes = await onePagePdf();
  const initialDocuments = names.map((name) => ({
    source: { bytes, kind: "bytes" as const, name },
  }));

  const { container } = render(
    <TabbedAppShell
      fileAdapter={hostAdapter()}
      initialDocuments={initialDocuments}
    />,
  );

  const shell = container.querySelector(".tabbedapp-shell");
  assert.ok(shell, "the shell root did not render");
  await waitFor(
    () => {
      assert.equal(
        container.querySelectorAll(".tabbedapp-document-tab").length,
        names.length,
      );
      assert.equal(shell.getAttribute("data-busy"), "false");
    },
    { timeout: 15_000 },
  );

  return { container, shell };
}

function openTabListMenu(container: HTMLElement) {
  const toggle = container.querySelector(".tabbedapp-tab-list-toggle");
  assert.ok(toggle, "the list-open-tabs toggle did not render");
  fireEvent.click(toggle);
  const menu = container.querySelector(".tabbedapp-tab-list-menu");
  assert.ok(menu, "the tab list menu did not open");
  return menu as HTMLElement;
}

function menuRows(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".tabbedapp-tab-list-menu-row"),
  );
}

// The shell can hold its own command lock for a moment right after several
// documents mount at once, which would swallow a click fired the instant a
// button appears - wait for the specific button to actually be enabled first.
async function clickWhenEnabled(button: HTMLButtonElement | null | undefined) {
  assert.ok(button);
  await waitFor(() => assert.equal(button.disabled, false));
  fireEvent.click(button);
}

test("closing a row from the list menu's own close button keeps the menu open, then closes it once empty", async () => {
  const { container } = await renderShellWithOpenTabs([
    "one.pdf",
    "two.pdf",
    "three.pdf",
  ]);

  openTabListMenu(container);
  let rows = menuRows(container);
  assert.equal(rows.length, 3);

  // Each row's close button has its own accessible name, distinct per document.
  const closeLabels = rows.map((row) =>
    row.querySelector(".tabbedapp-tab-close")?.getAttribute("aria-label"),
  );
  assert.deepEqual(closeLabels, [
    "Close one.pdf",
    "Close two.pdf",
    "Close three.pdf",
  ]);

  // Close the middle row from its own button.
  await clickWhenEnabled(
    rows[1].querySelector<HTMLButtonElement>(".tabbedapp-tab-close"),
  );

  await waitFor(() => {
    assert.equal(
      container.querySelectorAll(".tabbedapp-document-tab").length,
      2,
    );
  });
  assert.ok(
    container.querySelector(".tabbedapp-tab-list-menu"),
    "the menu closed after closing just one of several tabs",
  );
  rows = menuRows(container);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(
      (row) =>
        row.querySelector(".tabbedapp-tab-list-menu-item-title")?.textContent,
    ),
    ["one.pdf", "three.pdf"],
    "the wrong tab closed",
  );

  // Close the remaining two, one button click at a time; the menu stays open throughout.
  await clickWhenEnabled(
    rows[0].querySelector<HTMLButtonElement>(".tabbedapp-tab-close"),
  );
  await waitFor(() => {
    assert.equal(
      container.querySelectorAll(".tabbedapp-document-tab").length,
      1,
    );
  });
  assert.ok(
    container.querySelector(".tabbedapp-tab-list-menu"),
    "the menu closed with one tab still open",
  );

  rows = menuRows(container);
  await clickWhenEnabled(
    rows[0].querySelector<HTMLButtonElement>(".tabbedapp-tab-close"),
  );

  // Nothing left to list: the menu must close itself rather than sit open and empty.
  await waitFor(() => {
    assert.equal(
      container.querySelectorAll(".tabbedapp-document-tab").length,
      0,
    );
  });
  await waitFor(() => {
    assert.equal(container.querySelector(".tabbedapp-tab-list-menu"), null);
  });
});

test("middle-clicking a row in the list menu closes that tab and keeps the menu open", async () => {
  const { container } = await renderShellWithOpenTabs([
    "alpha.pdf",
    "beta.pdf",
  ]);

  openTabListMenu(container);
  const rows = menuRows(container);
  assert.equal(rows.length, 2);

  const firstSelectButton = rows[0].querySelector(
    ".tabbedapp-tab-list-menu-item",
  );
  assert.ok(firstSelectButton);
  // A real middle-click fires auxclick (button 1), not click - closeTabOnMiddleClick reads event.button itself.
  fireEvent(
    firstSelectButton,
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );

  await waitFor(() => {
    assert.equal(
      container.querySelectorAll(".tabbedapp-document-tab").length,
      1,
    );
  });
  assert.equal(
    container.querySelector(".tabbedapp-tab-list-menu-item-title")?.textContent,
    "beta.pdf",
    "the wrong tab closed",
  );
  assert.ok(
    container.querySelector(".tabbedapp-tab-list-menu"),
    "the menu closed after a middle-click close",
  );
});

test("arrow-key navigation in the list menu still reaches every row's select and close buttons", async () => {
  const { container } = await renderShellWithOpenTabs(["one.pdf", "two.pdf"]);

  const menu = openTabListMenu(container);
  const items = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  );
  // Two rows, each contributing its select button and its close button.
  assert.equal(items.length, 4);

  items[0].focus();
  assert.equal(document.activeElement, items[0]);

  fireEvent.keyDown(menu, { key: "ArrowDown" });
  assert.equal(document.activeElement, items[1]);

  fireEvent.keyDown(menu, { key: "ArrowDown" });
  assert.equal(document.activeElement, items[2]);

  fireEvent.keyDown(menu, { key: "End" });
  assert.equal(document.activeElement, items[items.length - 1]);

  fireEvent.keyDown(menu, { key: "Home" });
  assert.equal(document.activeElement, items[0]);
});
