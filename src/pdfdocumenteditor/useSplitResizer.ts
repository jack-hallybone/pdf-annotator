import { useRef, type Dispatch, type SetStateAction } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export type SplitAxis = "row" | "column";

// Keeps either side of a split from being dragged down to a sliver too
// narrow to read.
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
const SPLIT_RATIO_KEYBOARD_STEP = 0.05;

export function clampSplitRatio(ratio: number) {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

// Drives the draggable, keyboard-operable divider between two panes sharing
// a split - the primary pane's share is `ratio`, the other takes the rest.
// Shared because a host splitting two different documents and the core
// mirroring one document into two views both need the identical control.
export function useSplitResizer({
  axis,
  disabled = false,
  ratio,
  setRatio,
}: {
  axis: SplitAxis;
  disabled?: boolean;
  ratio: number;
  setRatio: Dispatch<SetStateAction<number>>;
}) {
  const dragRef = useRef<{
    containerSize: number;
    pointerId: number;
    startPosition: number;
    startRatio: number;
  } | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled) {
      return;
    }

    const container = event.currentTarget.parentElement;
    const rect = container?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const containerSize = axis === "row" ? rect.width : rect.height;
    if (containerSize <= 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      containerSize,
      pointerId: event.pointerId,
      startPosition: axis === "row" ? event.clientX : event.clientY,
      startRatio: ratio,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const position = axis === "row" ? event.clientX : event.clientY;
    const delta = (position - drag.startPosition) / drag.containerSize;
    setRatio(clampSplitRatio(drag.startRatio + delta));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const decreaseKey = axis === "row" ? "ArrowLeft" : "ArrowUp";
    const increaseKey = axis === "row" ? "ArrowRight" : "ArrowDown";

    if (event.key === decreaseKey) {
      setRatio((current) =>
        clampSplitRatio(current - SPLIT_RATIO_KEYBOARD_STEP),
      );
    } else if (event.key === increaseKey) {
      setRatio((current) =>
        clampSplitRatio(current + SPLIT_RATIO_KEYBOARD_STEP),
      );
    } else if (event.key === "Home") {
      setRatio(MIN_SPLIT_RATIO);
    } else if (event.key === "End") {
      setRatio(MAX_SPLIT_RATIO);
    } else {
      return;
    }

    event.preventDefault();
  }

  return {
    ariaValueMax: Math.round(MAX_SPLIT_RATIO * 100),
    ariaValueMin: Math.round(MIN_SPLIT_RATIO * 100),
    ariaValueNow: Math.round(ratio * 100),
    handleKeyDown,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}
