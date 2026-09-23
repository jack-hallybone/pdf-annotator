import assert from "node:assert/strict";
import { test } from "node:test";
import { useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { act, renderHook } from "@testing-library/react";
import { useTabDragReorder } from "../src/tabbedapp/useTabDragReorder";

type Doc = { id: string };

// The hook decides placement by measuring the real tab elements and jsdom has no
// layout, where an all-zero rect would collapse "before" and "after" into one
// answer, so the fixture hands each tab an explicit rect.
const TAB_WIDTH = 100;

function buildTabsNav(ids: string[]) {
  const nav = document.createElement("nav");
  ids.forEach((id, index) => {
    const tab = document.createElement("div");
    tab.dataset.tabbedappTabId = id;
    const left = index * TAB_WIDTH;
    tab.getBoundingClientRect = () =>
      ({
        left,
        right: left + TAB_WIDTH,
        width: TAB_WIDTH,
        top: 0,
        bottom: 30,
        height: 30,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    nav.append(tab);
  });
  return nav;
}

type FakeDragEvent = ReactDragEvent<HTMLElement> & {
  defaultPrevented: boolean;
  transferred: Record<string, string>;
};

function dragEvent(clientX = 0, target: EventTarget | null = null) {
  const event = {
    clientX,
    target,
    defaultPrevented: false,
    transferred: {} as Record<string, string>,
    dataTransfer: {
      dropEffect: "none",
      effectAllowed: "none",
      setData(format: string, value: string) {
        event.transferred[format] = value;
      },
    },
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return event as unknown as FakeDragEvent;
}

function useHarness(nav: HTMLElement, ids: string[], locked = false) {
  const tabsNavRef = useRef<HTMLElement | null>(nav);
  const shellLockedRef = useRef(locked);
  const contextMenuClosesRef = useRef(0);
  const [documents, setDocuments] = useState<Doc[]>(() =>
    ids.map((id) => ({ id })),
  );
  const drag = useTabDragReorder<Doc>({
    closeTabContextMenu: () => {
      contextMenuClosesRef.current += 1;
    },
    shellLockedRef,
    setDocuments,
    tabsNavRef,
  });
  return { ...drag, contextMenuClosesRef, documents, shellLockedRef };
}

function renderDragHook(ids = ["a", "b", "c"], locked = false) {
  const nav = buildTabsNav(ids);
  return renderHook(() => useHarness(nav, ids, locked));
}

function documentOrder(documents: Doc[]) {
  return documents.map((document) => document.id);
}

test("starting a drag marks the dragged tab as its own target", () => {
  const { result } = renderDragHook();
  const event = dragEvent();

  act(() => result.current.startTabDrag(event, "b"));

  assert.deepEqual(result.current.tabDragState, {
    draggedId: "b",
    placement: "after",
    targetId: "b",
  });
  assert.equal(event.dataTransfer.effectAllowed, "move");
  assert.equal(event.transferred["text/plain"], "b");
  assert.equal(result.current.contextMenuClosesRef.current, 1);
});

test("a locked shell refuses to start a drag", () => {
  const { result } = renderDragHook(["a", "b", "c"], true);
  const event = dragEvent();

  act(() => result.current.startTabDrag(event, "b"));

  assert.equal(result.current.tabDragState, null);
  assert.equal(event.defaultPrevented, true);
});

test("a drag begun on the close button is not a reorder", () => {
  const { result } = renderDragHook();
  const closeButton = document.createElement("button");
  closeButton.className = "tabbedapp-tab-close";
  const event = dragEvent(0, closeButton);

  act(() => result.current.startTabDrag(event, "b"));

  assert.equal(result.current.tabDragState, null);
  assert.equal(event.defaultPrevented, true);
});

test("dragging over a tab picks the nearer half as the drop side", () => {
  const { result } = renderDragHook();
  act(() => result.current.startTabDrag(dragEvent(), "a"));

  act(() => result.current.updateTabDragTarget(dragEvent(120)));
  assert.deepEqual(result.current.tabDragState, {
    draggedId: "a",
    placement: "before",
    targetId: "b",
  });

  act(() => result.current.updateTabDragTarget(dragEvent(180)));
  assert.deepEqual(result.current.tabDragState, {
    draggedId: "a",
    placement: "after",
    targetId: "b",
  });
});

test("dragging over the tab bar past the last tab lands after it", () => {
  const { result } = renderDragHook();
  act(() => result.current.startTabDrag(dragEvent(), "a"));

  const event = dragEvent(999);
  act(() => result.current.handleTabbarDragOver(event));

  assert.deepEqual(result.current.tabDragState, {
    draggedId: "a",
    placement: "after",
    targetId: "c",
  });
  assert.equal(event.dataTransfer.dropEffect, "move");
});

test("dropping after the last tab moves the dragged tab to the end", () => {
  const { result } = renderDragHook();

  act(() => result.current.startTabDrag(dragEvent(), "a"));
  act(() => result.current.updateTabDragTarget(dragEvent(280)));
  act(() => result.current.dropTab(dragEvent(280)));

  assert.deepEqual(documentOrder(result.current.documents), ["b", "c", "a"]);
  assert.equal(result.current.tabDragState, null);
});

test("dropping before an earlier tab moves the dragged tab back", () => {
  const { result } = renderDragHook();

  act(() => result.current.startTabDrag(dragEvent(), "c"));
  act(() => result.current.updateTabDragTarget(dragEvent(20)));
  act(() => result.current.dropTab(dragEvent(20)));

  assert.deepEqual(documentOrder(result.current.documents), ["c", "a", "b"]);
});

// Both cases below move a tab rightwards, the only direction where removing the
// dragged tab shifts the insertion point: without the index correction the tab
// lands one slot further along than the indicator promised.
test("dropping one place to the right lands where the indicator was", () => {
  const { result } = renderDragHook();

  act(() => result.current.startTabDrag(dragEvent(), "a"));
  act(() => result.current.updateTabDragTarget(dragEvent(180)));
  assert.deepEqual(result.current.tabDragState, {
    draggedId: "a",
    placement: "after",
    targetId: "b",
  });
  act(() => result.current.dropTab(dragEvent(180)));

  assert.deepEqual(documentOrder(result.current.documents), ["b", "a", "c"]);
});

test("dropping into the slot a tab already occupies keeps the order", () => {
  const { result } = renderDragHook();

  act(() => result.current.startTabDrag(dragEvent(), "b"));
  act(() => result.current.updateTabDragTarget(dragEvent(220)));
  assert.deepEqual(result.current.tabDragState, {
    draggedId: "b",
    placement: "before",
    targetId: "c",
  });
  act(() => result.current.dropTab(dragEvent(220)));

  assert.deepEqual(documentOrder(result.current.documents), ["a", "b", "c"]);
});

test("dropping a tab onto itself is a no-op", () => {
  const { result } = renderDragHook();

  act(() => result.current.startTabDrag(dragEvent(), "b"));
  const event = dragEvent(150);
  act(() => result.current.dropTab(event));

  assert.deepEqual(documentOrder(result.current.documents), ["a", "b", "c"]);
  assert.equal(result.current.tabDragState, null);
  assert.equal(event.defaultPrevented, true);
});

test("dropping on the tab bar ends the drag without reordering", () => {
  const { result } = renderDragHook();

  act(() => result.current.startTabDrag(dragEvent(), "a"));
  act(() => result.current.updateTabDragTarget(dragEvent(280)));
  act(() => result.current.handleTabbarDrop(dragEvent(280)));

  assert.equal(result.current.tabDragState, null);
  assert.deepEqual(documentOrder(result.current.documents), ["a", "b", "c"]);
});

test("drag handlers ignore events when no drag is in progress", () => {
  const { result } = renderDragHook();
  const over = dragEvent(150);
  const drop = dragEvent(150);

  act(() => {
    result.current.updateTabDragTarget(over);
    result.current.dropTab(drop);
    result.current.handleTabbarDragOver(over);
    result.current.handleTabbarDrop(drop);
  });

  assert.equal(over.defaultPrevented, false);
  assert.equal(drop.defaultPrevented, false);
  assert.deepEqual(documentOrder(result.current.documents), ["a", "b", "c"]);
});
