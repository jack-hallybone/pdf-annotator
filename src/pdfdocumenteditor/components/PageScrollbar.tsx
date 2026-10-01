import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  nextTrackPage,
  scrollbarThumb,
  scrollOffsetForThumb,
  steadiedPointer,
  THUMB_WOBBLE_SLACK,
  TRACK_REPEAT_DELAY_MS,
  TRACK_REPEAT_INTERVAL_MS,
  type ScrollbarMetrics,
  type ScrollbarThumb,
} from "../pageScrollbar";
import { useRenderLatestRef } from "../useRenderLatestRef";

type Gesture =
  | {
      grab: number;
      held: number;
      kind: "drag";
      pointerId: number;
      slack: number;
      trackStart: number;
    }
  | {
      direction: -1 | 1;
      kind: "page";
      pointer: number;
      pointerId: number;
      target: number;
      timer: number;
      trackStart: number;
    };

/* Chrome's own step for one line of wheel, for a wheel that counts in lines rather than pixels. */
const WHEEL_LINE_PX = 40;

// One of the page column's two scrollbars, drawn by the app so a held pen can be steadied (see pageScrollbar.ts). It sits beside the scroller, not in it, so it takes the room the browser's own bar did.
export function PageScrollbar({
  axis,
  contentRef,
  measureKey,
  onOverflowChange,
  scrollerRef,
}: {
  axis: "x" | "y";
  contentRef: RefObject<HTMLElement | null>;
  // A new value measures again, for a layout change no observer sees.
  measureKey: unknown;
  onOverflowChange?: (overflows: boolean) => void;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const metricsRef = useRef<ScrollbarMetrics | null>(null);
  const thumbGeometryRef = useRef<ScrollbarThumb | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const onOverflowChangeRef = useRenderLatestRef(onOverflowChange);
  const vertical = axis === "y";

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const bar = barRef.current;
    const thumb = thumbRef.current;
    if (!scroller || !bar || !thumb) {
      return;
    }

    let frame = 0;
    let overflows: boolean | null = null;
    // Writes the thumb's style directly rather than through state, so scrolling never re-renders the viewport.
    const measure = () => {
      frame = 0;
      const metrics = {
        contentLength: vertical ? scroller.scrollHeight : scroller.scrollWidth,
        trackLength: vertical ? bar.clientHeight : bar.clientWidth,
        viewportLength: vertical ? scroller.clientHeight : scroller.clientWidth,
      };
      const geometry = scrollbarThumb(
        metrics,
        vertical ? scroller.scrollTop : scroller.scrollLeft,
      );
      metricsRef.current = metrics;
      thumbGeometryRef.current = geometry;
      thumb.hidden = !geometry;
      if (geometry) {
        thumb.style.transform = `translate${vertical ? "Y" : "X"}(${geometry.offset}px)`;
        thumb.style[vertical ? "height" : "width"] = `${geometry.length}px`;
      }

      // Read off the scroller, not the thumb: a bar hidden for want of overflow has no track to measure.
      const nextOverflows = metrics.contentLength > metrics.viewportLength;
      if (nextOverflows !== overflows) {
        overflows = nextOverflows;
        onOverflowChangeRef.current?.(nextOverflows);
      }
    };
    const scheduleMeasure = () => {
      frame ||= window.requestAnimationFrame(measure);
    };

    measure();
    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroller);
    observer.observe(bar);
    if (contentRef.current) {
      observer.observe(contentRef.current);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", scheduleMeasure);
      observer.disconnect();
    };
  }, [contentRef, measureKey, onOverflowChangeRef, scrollerRef, vertical]);

  useEffect(
    () => () => {
      const gesture = gestureRef.current;
      if (gesture?.kind === "page") {
        window.clearTimeout(gesture.timer);
      }
    },
    [],
  );

  const along = (point: { x: number; y: number }) =>
    vertical ? point.y : point.x;

  function scrollTo(offset: number, behavior: ScrollBehavior) {
    scrollerRef.current?.scrollTo({
      [vertical ? "top" : "left"]: offset,
      behavior,
    });
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const scroller = scrollerRef.current;
    const thumb = thumbGeometryRef.current;
    if (event.button !== 0 || gestureRef.current || !scroller || !thumb) {
      return;
    }

    // As on the browser's own bar, a press leaves focus where it was, so scrolling does not end an edit in progress.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const trackStart = along(event.currentTarget.getBoundingClientRect());
    const pointer = along({ x: event.clientX, y: event.clientY }) - trackStart;

    if (pointer >= thumb.offset && pointer <= thumb.offset + thumb.length) {
      gestureRef.current = {
        grab: pointer - thumb.offset,
        held: pointer,
        kind: "drag",
        pointerId: event.pointerId,
        slack: event.pointerType === "mouse" ? 0 : THUMB_WOBBLE_SLACK,
        trackStart,
      };
      event.currentTarget.dataset.dragging = "true";
      return;
    }

    const press: Extract<Gesture, { kind: "page" }> = {
      direction: pointer < thumb.offset ? -1 : 1,
      kind: "page",
      pointer,
      pointerId: event.pointerId,
      target: vertical ? scroller.scrollTop : scroller.scrollLeft,
      timer: 0,
      trackStart,
    };
    gestureRef.current = press;
    // Pages toward the pointer until the thumb reaches it, then waits there in case the pointer moves on.
    const page = () => {
      const metrics = metricsRef.current;
      const next =
        metrics &&
        nextTrackPage(metrics, press.target, press.direction, press.pointer);
      if (next !== null) {
        press.target = next;
        scrollTo(next, "smooth");
      }
    };
    page();
    press.timer = window.setTimeout(function repeat() {
      page();
      press.timer = window.setTimeout(repeat, TRACK_REPEAT_INTERVAL_MS);
    }, TRACK_REPEAT_DELAY_MS);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const pointer =
      along({ x: event.clientX, y: event.clientY }) - gesture.trackStart;
    if (gesture.kind === "page") {
      gesture.pointer = pointer;
      return;
    }

    const held = steadiedPointer(gesture.held, pointer, gesture.slack);
    const metrics = metricsRef.current;
    // Nothing is written while the held position stands still, so a wobble inside the slack cannot nudge the pages by a rounding.
    if (held === gesture.held || !metrics) {
      return;
    }

    gesture.held = held;
    scrollTo(scrollOffsetForThumb(metrics, held - gesture.grab), "instant");
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    if (gesture.kind === "page") {
      window.clearTimeout(gesture.timer);
    }
    gestureRef.current = null;
    delete event.currentTarget.dataset.dragging;
  }

  // Outside the scroller, a wheel over the bar would scroll nothing; over the browser's own bar it scrolled the pages.
  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const scroller = scrollerRef.current;
    // Ctrl or Cmd with the wheel is zoom, which the viewport handles.
    if (!scroller || event.ctrlKey || event.metaKey) {
      return;
    }

    const unit = (extent: number) =>
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? extent
          : 1;
    scroller.scrollBy({
      behavior: "instant",
      left: event.deltaX * unit(scroller.clientWidth),
      top: event.deltaY * unit(scroller.clientHeight),
    });
  }

  return (
    <div
      aria-hidden="true"
      className={`pdfdocumenteditor-scrollbar pdfdocumenteditor-scrollbar--${axis}`}
      onContextMenu={(event) => event.preventDefault()}
      onLostPointerCapture={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onWheel={handleWheel}
      ref={barRef}
    >
      <div className="pdfdocumenteditor-scrollbar-thumb" ref={thumbRef} />
    </div>
  );
}
