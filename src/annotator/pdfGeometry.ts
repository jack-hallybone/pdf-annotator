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
