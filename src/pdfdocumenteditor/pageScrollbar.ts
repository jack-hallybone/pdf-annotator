// Geometry for the page column's own scrollbars (components/PageScrollbar.tsx). The browser's were replaced because on a long document one pixel of thumb travel moves the pages a hundred or more, so the tremor of a pen tip held on the thumb shook the pages up and down.

import { clamp } from "./viewerConfig";

/* CSS px a pen or finger held on the thumb may wobble without moving it. Past that the thumb follows, trailing by this much. A mouse gets none: it does not wobble when held, so its drags stay exact. */
export const THUMB_WOBBLE_SLACK = 4;

/* Long enough to catch with a pen on any document. */
export const MIN_THUMB_LENGTH = 32;

/* Chrome's own step for a press on the track: seven eighths of the view, so the edge of the old view stays in sight. */
export const TRACK_PAGE_FRACTION = 0.875;

/* Chrome's timing for a press held on the track: the wait before it repeats, then the time between repeats. */
export const TRACK_REPEAT_DELAY_MS = 250;
export const TRACK_REPEAT_INTERVAL_MS = 50;

export type ScrollbarMetrics = {
  contentLength: number;
  trackLength: number;
  viewportLength: number;
};

export type ScrollbarThumb = { length: number; offset: number };

/** Where the thumb sits for `scrollOffset`, or null when there is nothing to scroll. */
export function scrollbarThumb(
  { contentLength, trackLength, viewportLength }: ScrollbarMetrics,
  scrollOffset: number,
): ScrollbarThumb | null {
  const scrollRange = contentLength - viewportLength;
  if (scrollRange <= 0 || trackLength <= 0) {
    return null;
  }

  const length = clamp(
    (trackLength * viewportLength) / contentLength,
    Math.min(MIN_THUMB_LENGTH, trackLength),
    trackLength,
  );
  return {
    length,
    offset: (trackLength - length) * clamp(scrollOffset / scrollRange, 0, 1),
  };
}

/** The scroll offset that puts the thumb's leading edge at `thumbOffset`, the inverse of scrollbarThumb: a dragged thumb stays under the pointer, as the browser's own does. */
export function scrollOffsetForThumb(
  metrics: ScrollbarMetrics,
  thumbOffset: number,
) {
  const thumb = scrollbarThumb(metrics, 0);
  const travel = thumb ? metrics.trackLength - thumb.length : 0;
  return travel > 0
    ? clamp(thumbOffset / travel, 0, 1) *
        (metrics.contentLength - metrics.viewportLength)
    : 0;
}

/** A held pointer's position with its wobble taken out. It moves only once the pointer strays more than `slack` from it, and then trails by `slack`, so wobble narrower than twice the slack settles after at most one small move. */
export function steadiedPointer(held: number, pointer: number, slack: number) {
  if (pointer > held + slack) {
    return pointer - slack;
  }
  if (pointer < held - slack) {
    return pointer + slack;
  }
  return held;
}

/** The next page for a press held on the track at `pointer`, or null once the thumb has reached it. `from` is where the paging so far is headed, not where an animation has got to. */
export function nextTrackPage(
  metrics: ScrollbarMetrics,
  from: number,
  direction: -1 | 1,
  pointer: number,
) {
  const thumb = scrollbarThumb(metrics, from);
  if (
    !thumb ||
    (direction < 0
      ? thumb.offset <= pointer
      : thumb.offset + thumb.length >= pointer)
  ) {
    return null;
  }

  return clamp(
    from + direction * metrics.viewportLength * TRACK_PAGE_FRACTION,
    0,
    metrics.contentLength - metrics.viewportLength,
  );
}
