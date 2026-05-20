import type { PageViewport, PdfPoint, PdfRect } from './types';

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

export function pathToViewportD(path: PdfPoint[], viewport: PageViewport) {
  return path
    .map((point, index) => {
      const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
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
