import { useState } from "react";
import type {
  Dispatch,
  DragEvent as ReactDragEvent,
  RefObject,
  SetStateAction,
} from "react";

type TabDragPlacement = "before" | "after";

type TabDragState = {
  draggedId: string;
  placement: TabDragPlacement;
  targetId: string;
};

type ReorderableTab = {
  id: string;
};

type TabDragReorderParams<T extends ReorderableTab> = {
  closeTabContextMenu: () => void;
  // The shell's `useLatestRef` mirror of `shellLocked`, so this bail reads it
  // the same way the shell's own command handlers do.
  shellLockedRef: RefObject<boolean>;
  // The hook reorders the tab list but does not own it; the shell keeps the
  // documents state and lends only its setter.
  setDocuments: Dispatch<SetStateAction<T[]>>;
  tabsNavRef: RefObject<HTMLElement | null>;
};

type TabDragReorderApi = {
  dropTab: (event: ReactDragEvent<HTMLElement>) => void;
  finishTabDrag: () => void;
  handleTabbarDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  handleTabbarDrop: (event: ReactDragEvent<HTMLElement>) => void;
  startTabDrag: (
    event: ReactDragEvent<HTMLElement>,
    documentId: string,
  ) => void;
  tabDragState: TabDragState | null;
  updateTabDragTarget: (event: ReactDragEvent<HTMLElement>) => void;
};

/*
 * Tab positions are measured from the DOM rather than tracked in state,
 * because CSS lays out the tab bar's widths.
 */
export function useTabDragReorder<T extends ReorderableTab>({
  closeTabContextMenu,
  shellLockedRef,
  setDocuments,
  tabsNavRef,
}: TabDragReorderParams<T>): TabDragReorderApi {
  const [tabDragState, setTabDragState] = useState<TabDragState | null>(null);

  function startTabDrag(
    event: ReactDragEvent<HTMLElement>,
    documentId: string,
  ) {
    if (shellLockedRef.current) {
      event.preventDefault();
      return;
    }

    if (
      event.target instanceof Element &&
      event.target.closest(".tabbedapp-tab-close")
    ) {
      event.preventDefault();
      return;
    }

    closeTabContextMenu();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", documentId);
    setTabDragState({
      draggedId: documentId,
      placement: "after",
      targetId: documentId,
    });
  }

  function updateTabDragTarget(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    updateTabDragPosition(event.clientX);
  }

  function updateTabDragPosition(clientX: number) {
    if (!tabDragState) {
      return;
    }

    const tabElements = Array.from(
      tabsNavRef.current?.querySelectorAll<HTMLElement>(
        "[data-tabbedapp-tab-id]",
      ) ?? [],
    );
    let targetId = tabDragState.targetId;
    let placement = tabDragState.placement;

    const lastTab = tabElements.at(-1);
    const lastTabId = lastTab?.dataset.tabbedappTabId;
    if (lastTabId && clientX > lastTab.getBoundingClientRect().right) {
      // A single row in DOM order, so past the last tab's right edge is the
      // answer without measuring the others.
      targetId = lastTabId;
      placement = "after";
    } else {
      for (const tabElement of tabElements) {
        const tabId = tabElement.dataset.tabbedappTabId;
        if (!tabId) {
          continue;
        }

        const bounds = tabElement.getBoundingClientRect();
        if (clientX < bounds.left) {
          targetId = tabId;
          placement = "before";
          break;
        }

        if (clientX <= bounds.right) {
          targetId = tabId;
          placement =
            clientX < bounds.left + bounds.width / 2 ? "before" : "after";
          break;
        }

        targetId = tabId;
        placement = "after";
      }
    }

    if (
      tabDragState.targetId !== targetId ||
      tabDragState.placement !== placement
    ) {
      setTabDragState({
        draggedId: tabDragState.draggedId,
        placement,
        targetId,
      });
    }
  }

  function dropTab(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    reorderDocuments(
      tabDragState.draggedId,
      tabDragState.targetId,
      tabDragState.placement,
    );
    setTabDragState(null);
  }

  function handleTabbarDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateTabDragPosition(event.clientX);
  }

  function handleTabbarDrop(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    setTabDragState(null);
  }

  function finishTabDrag() {
    setTabDragState(null);
  }

  function reorderDocuments(
    draggedId: string,
    targetId: string,
    placement: TabDragPlacement,
  ) {
    if (draggedId === targetId) {
      return;
    }

    setDocuments((current) => {
      const fromIndex = current.findIndex(
        (document) => document.id === draggedId,
      );
      const targetIndex = current.findIndex(
        (document) => document.id === targetId,
      );
      if (fromIndex < 0 || targetIndex < 0) {
        return current;
      }

      const nextDocuments = [...current];
      const [draggedDocument] = nextDocuments.splice(fromIndex, 1);
      let insertIndex = targetIndex + (placement === "after" ? 1 : 0);
      // The removal above shifted everything after `fromIndex` down by one, so
      // an insertion point past it has to come down with them.
      if (fromIndex < insertIndex) {
        insertIndex -= 1;
      }

      nextDocuments.splice(insertIndex, 0, draggedDocument);
      return nextDocuments;
    });
  }

  return {
    dropTab,
    finishTabDrag,
    handleTabbarDragOver,
    handleTabbarDrop,
    startTabDrag,
    tabDragState,
    updateTabDragTarget,
  };
}
