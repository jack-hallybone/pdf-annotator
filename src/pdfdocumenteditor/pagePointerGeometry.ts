// Where a page sits in the scroll viewport, how big it is on screen, and how a
// pointer event maps back to a point in PDF user space.
import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import { viewportPointToPdfPoint } from "./pdfGeometry";
import type { TextLayerRect } from "./textLayerGeometry";
import type { PageDisplaySize, PageViewport } from "./types";
import { clamp } from "./viewerConfig";

export type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type TextHitRect = TextLayerRect & { viewportRect: ViewportRect };
type VisiblePageBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export function useVisiblePageBounds(
  pageRef: RefObject<HTMLDivElement | null>,
  viewport: PageViewport,
) {
  const [bounds, setBounds] = useState<VisiblePageBounds>(() =>
    fullPageBounds(viewport),
  );

  useLayoutEffect(() => {
    let animationFrame = 0;

    const updateBounds = () => {
      animationFrame = 0;
      const nextBounds = visiblePageBounds(pageRef.current, viewport);
      setBounds((current) =>
        sameVisiblePageBounds(current, nextBounds) ? current : nextBounds,
      );
    };

    const scheduleUpdate = () => {
      if (animationFrame) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateBounds);
    };

    updateBounds();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    const observedPage = pageRef.current;
    const observedHost = observedPage?.closest(".pdfdocumenteditor");
    const observer = observedPage ? new ResizeObserver(scheduleUpdate) : null;
    if (observedPage) {
      observer?.observe(observedPage);
    }
    if (observedHost && observedHost !== observedPage) {
      observer?.observe(observedHost);
    }

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      observer?.disconnect();
    };
  }, [pageRef, viewport]);

  return bounds;
}

function visiblePageBounds(
  pageElement: HTMLDivElement | null,
  viewport: PageViewport,
): VisiblePageBounds {
  if (!pageElement) {
    return fullPageBounds(viewport);
  }

  const margin = 4;
  const pageRect = pageElement.getBoundingClientRect();
  const scaleX = viewport.width / Math.max(1, pageRect.width);
  const scaleY = viewport.height / Math.max(1, pageRect.height);
  const maxRight = Math.max(margin, viewport.width - margin);
  const maxBottom = Math.max(margin, viewport.height - margin);
  const hostRect = pageElement
    .closest(".pdfdocumenteditor")
    ?.getBoundingClientRect() ?? {
    bottom: window.innerHeight,
    left: 0,
    right: window.innerWidth,
    top: 0,
  };
  let left = clamp(
    (hostRect.left - pageRect.left) * scaleX + margin,
    margin,
    maxRight,
  );
  let right = clamp(
    (hostRect.right - pageRect.left) * scaleX - margin,
    margin,
    maxRight,
  );
  let top = clamp(
    (hostRect.top - pageRect.top) * scaleY + margin,
    margin,
    maxBottom,
  );
  let bottom = clamp(
    (hostRect.bottom - pageRect.top) * scaleY - margin,
    margin,
    maxBottom,
  );

  if (right <= left) {
    left = margin;
    right = maxRight;
  }

  if (bottom <= top) {
    top = margin;
    bottom = maxBottom;
  }

  return { bottom, left, right, top };
}

function fullPageBounds(viewport: PageViewport): VisiblePageBounds {
  const margin = 4;
  return {
    bottom: Math.max(margin, viewport.height - margin),
    left: margin,
    right: Math.max(margin, viewport.width - margin),
    top: margin,
  };
}

function sameVisiblePageBounds(
  left: VisiblePageBounds,
  right: VisiblePageBounds,
) {
  return (
    Math.abs(left.bottom - right.bottom) < 0.5 &&
    Math.abs(left.left - right.left) < 0.5 &&
    Math.abs(left.right - right.right) < 0.5 &&
    Math.abs(left.top - right.top) < 0.5
  );
}

export function viewportDisplaySize(viewport: PageViewport): PageDisplaySize {
  return {
    height: viewport.height,
    width: viewport.width,
  };
}

export function displaySizeFromElement(
  element: HTMLElement | null,
): PageDisplaySize | null {
  if (!element) {
    return null;
  }

  const bounds = element.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) {
    return null;
  }

  return {
    height: bounds.height,
    width: bounds.width,
  };
}

export function displaySizesMatch(
  left: PageDisplaySize,
  right: PageDisplaySize,
) {
  return (
    Math.abs(left.height - right.height) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5
  );
}

export function eventToPdfPoint(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: PageViewport,
) {
  return eventToPdfPoints(event, viewport).at(-1) ?? { x: 0, y: 0 };
}

export function eventToPdfPoints(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: PageViewport,
) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return pointerSamples(event).map((sample) =>
    viewportPointToPdfPoint(
      ...clientPointToViewportTuple(
        sample.clientX,
        sample.clientY,
        bounds,
        viewport,
      ),
      viewport,
    ),
  );
}

export function eventToPdfPointFromElement(
  event: React.PointerEvent<Element>,
  viewport: PageViewport,
) {
  return eventToPdfPointsFromElement(event, viewport).at(-1) ?? { x: 0, y: 0 };
}

export function eventToPdfPointsFromElement(
  event: React.PointerEvent<Element>,
  viewport: PageViewport,
) {
  const pageElement = (event.currentTarget as Element).closest(
    ".pdfdocumenteditor-page",
  );
  const bounds = pageElement?.getBoundingClientRect();

  if (!bounds) {
    return [];
  }

  return pointerSamples(event).map((sample) =>
    viewportPointToPdfPoint(
      ...clientPointToViewportTuple(
        sample.clientX,
        sample.clientY,
        bounds,
        viewport,
      ),
      viewport,
    ),
  );
}

export function eventToViewportPoint(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: PageViewport,
) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const sample = pointerSamples(event).at(-1) ?? event.nativeEvent;
  return clientPointToViewportPoint(
    sample.clientX,
    sample.clientY,
    bounds,
    viewport,
  );
}

function clientPointToViewportTuple(
  clientX: number,
  clientY: number,
  bounds: DOMRect,
  viewport: PageViewport,
): [number, number] {
  const point = clientPointToViewportPoint(clientX, clientY, bounds, viewport);
  return [point.x, point.y];
}

export function clientPointToViewportPoint(
  clientX: number,
  clientY: number,
  bounds: DOMRect,
  viewport: PageViewport,
) {
  const scaleX = viewport.width / Math.max(1, bounds.width);
  const scaleY = viewport.height / Math.max(1, bounds.height);
  return {
    x: clamp((clientX - bounds.left) * scaleX, 0, viewport.width),
    y: clamp((clientY - bounds.top) * scaleY, 0, viewport.height),
  };
}

function pointerSamples(event: React.PointerEvent<Element>) {
  const nativeEvent = event.nativeEvent;
  const coalesced =
    typeof nativeEvent.getCoalescedEvents === "function"
      ? nativeEvent.getCoalescedEvents()
      : [];
  const samples = coalesced.length > 0 ? [...coalesced] : [nativeEvent];
  const last = samples.at(-1);
  if (
    !last ||
    last.clientX !== nativeEvent.clientX ||
    last.clientY !== nativeEvent.clientY
  ) {
    samples.push(nativeEvent);
  }
  return samples;
}

export function nearestTextHitRect(
  point: { x: number; y: number },
  hitRects: TextHitRect[],
  tolerance: { x: number; y: number },
) {
  let best: TextHitRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const textRect of hitRects) {
    const rect = textRect.viewportRect;
    const dx =
      point.x < rect.x
        ? rect.x - point.x
        : point.x > rect.x + rect.width
          ? point.x - (rect.x + rect.width)
          : 0;
    const dy =
      point.y < rect.y
        ? rect.y - point.y
        : point.y > rect.y + rect.height
          ? point.y - (rect.y + rect.height)
          : 0;

    if (dx > tolerance.x || dy > tolerance.y) {
      continue;
    }

    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = textRect;
    }
  }

  return best;
}

export function releasePointer(event: React.PointerEvent, pointerId: number) {
  try {
    (event.target as Element).releasePointerCapture?.(pointerId);
  } catch {
    // Capture may already have ended if the pointer left the element.
  }
}
