import type { PageViewport, PdfPoint, PdfRect } from './types';
import { inkPathCommands } from './annotationGeometry';

export function pdfRectToViewportRect(rect: PdfRect, viewport: PageViewport) {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
    rect.x1,
    rect.y1,
    rect.x2,
    rect.y2
  ]);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);

  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

// Annotation kinds whose content has its own visual "up" (image pixels, text
// baselines) need to spin with the page's rotation, not just slide to the
// rotated bounding box - `pdfRectToViewportRect` alone only repositions/resizes
// that box. This returns the local (unrotated) dimensions to lay the content
// out at, plus the transform that places and spins it to match `rect`.
// `extraRotation` layers a per-annotation clockwise spin (freeText/imageStamp's
// own `rotation` field) on top of the page's - both pivot on the same on-screen
// center, so they compose by simple addition.
export function annotationContentTransform(
  rect: { height: number; width: number; x: number; y: number },
  viewport: PageViewport,
  extraRotation = 0
) {
  // `rect` only ever has the PAGE's rotation baked in (it comes from
  // `pdfRectToViewportRect`, unaware of `extraRotation`), so recovering the
  // fixed local content size must undo only that, not the combined angle -
  // otherwise the content's own dimensions would incorrectly shift every
  // time `extraRotation` changes instead of just spinning in place.
  const pageRotation = ((viewport.rotation % 360) + 360) % 360;
  const pageSwapped = pageRotation === 90 || pageRotation === 270;
  const localWidth = pageSwapped ? rect.height : rect.width;
  const localHeight = pageSwapped ? rect.width : rect.height;
  const rotation = ((viewport.rotation + extraRotation) % 360 + 360) % 360;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;

  return {
    localWidth,
    localHeight,
    transform: `translate(${centerX} ${centerY}) rotate(${rotation}) translate(${-localWidth / 2} ${-localHeight / 2})`
  };
}

export function pathToViewportD(path: PdfPoint[], viewport: PageViewport) {
  return inkPathCommands(path)
    .map((command) => {
      const [x, y] = viewport.convertToViewportPoint(
        command.point.x,
        command.point.y
      );
      if (command.type === 'move') {
        return `M ${x} ${y}`;
      }

      if (command.type === 'line') {
        return `L ${x} ${y}`;
      }

      const [control1X, control1Y] = viewport.convertToViewportPoint(
        command.control1.x,
        command.control1.y
      );
      const [control2X, control2Y] = viewport.convertToViewportPoint(
        command.control2.x,
        command.control2.y
      );
      return `C ${control1X} ${control1Y} ${control2X} ${control2Y} ${x} ${y}`;
    })
    .join(' ');
}

export function viewportPointToPdfPoint(
  x: number,
  y: number,
  viewport: PageViewport
): PdfPoint {
  const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
  return { x: pdfX, y: pdfY };
}

export function viewportRectToPdfRect(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: PageViewport
): PdfRect {
  const topLeft = viewportPointToPdfPoint(x, y, viewport);
  const bottomRight = viewportPointToPdfPoint(x + width, y + height, viewport);

  return {
    x1: Math.min(topLeft.x, bottomRight.x),
    y1: Math.min(topLeft.y, bottomRight.y),
    x2: Math.max(topLeft.x, bottomRight.x),
    y2: Math.max(topLeft.y, bottomRight.y)
  };
}

export function pdfArrayRectToViewportRect(
  rect: number[],
  viewport: PageViewport
) {
  return pdfRectToViewportRect(
    {
      x1: rect[0],
      y1: rect[1],
      x2: rect[2],
      y2: rect[3]
    },
    viewport
  );
}

export function pointsToSvg(points: PdfPoint[], viewport: PageViewport) {
  return points
    .map((point) => viewport.convertToViewportPoint(point.x, point.y).join(','))
    .join(' ');
}

export function quadPointsToPolygons(quadPoints?: number[], rect?: number[]) {
  if (quadPoints?.length) {
    return Array.from({ length: Math.floor(quadPoints.length / 8) }, (_, i) => {
      const offset = i * 8;
      return [
        { x: quadPoints[offset], y: quadPoints[offset + 1] },
        { x: quadPoints[offset + 2], y: quadPoints[offset + 3] },
        { x: quadPoints[offset + 6], y: quadPoints[offset + 7] },
        { x: quadPoints[offset + 4], y: quadPoints[offset + 5] }
      ];
    });
  }

  if (!rect) {
    return [];
  }

  return [
    [
      { x: rect[0], y: rect[3] },
      { x: rect[2], y: rect[3] },
      { x: rect[2], y: rect[1] },
      { x: rect[0], y: rect[1] }
    ] satisfies PdfPoint[]
  ];
}
