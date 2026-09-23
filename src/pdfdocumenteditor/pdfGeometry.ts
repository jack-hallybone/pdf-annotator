import type { PageViewport, PdfPoint, PdfRect } from "./types";
import { inkPathCommands } from "./annotationGeometry";

export function pdfRectToViewportRect(rect: PdfRect, viewport: PageViewport) {
  // The min/abs below keeps the result correct when page rotation flips an
  // axis.
  const [x1, y1] = viewport.convertToViewportPoint(rect.x1, rect.y1);
  const [x2, y2] = viewport.convertToViewportPoint(rect.x2, rect.y2);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);

  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

// Content with its own visual "up" must spin with the page's rotation, not
// just slide to the rotated bounding box.
export function annotationContentTransform(
  rect: { height: number; width: number; x: number; y: number },
  viewport: PageViewport,
  extraRotation = 0,
) {
  // `rect` carries only the page's rotation, so recovering the local content
  // size must undo that alone, not the combined angle, or the content resizes
  // every time `extraRotation` changes instead of spinning in place.
  const pageRotation = ((viewport.rotation % 360) + 360) % 360;
  const pageSwapped = pageRotation === 90 || pageRotation === 270;
  const localWidth = pageSwapped ? rect.height : rect.width;
  const localHeight = pageSwapped ? rect.width : rect.height;
  const rotation = (((viewport.rotation + extraRotation) % 360) + 360) % 360;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;

  return {
    localWidth,
    localHeight,
    transform: `translate(${centerX} ${centerY}) rotate(${rotation}) translate(${-localWidth / 2} ${-localHeight / 2})`,
  };
}

export function pathToViewportD(path: PdfPoint[], viewport: PageViewport) {
  return inkPathCommands(path)
    .map((command) => {
      const [x, y] = viewport.convertToViewportPoint(
        command.point.x,
        command.point.y,
      );
      if (command.type === "move") {
        return `M ${x} ${y}`;
      }

      if (command.type === "line") {
        return `L ${x} ${y}`;
      }

      const [control1X, control1Y] = viewport.convertToViewportPoint(
        command.control1.x,
        command.control1.y,
      );
      const [control2X, control2Y] = viewport.convertToViewportPoint(
        command.control2.x,
        command.control2.y,
      );
      return `C ${control1X} ${control1Y} ${control2X} ${control2Y} ${x} ${y}`;
    })
    .join(" ");
}

export function viewportPointToPdfPoint(
  x: number,
  y: number,
  viewport: PageViewport,
): PdfPoint {
  const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
  return { x: pdfX, y: pdfY };
}

export function viewportRectToPdfRect(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: PageViewport,
): PdfRect {
  const topLeft = viewportPointToPdfPoint(x, y, viewport);
  const bottomRight = viewportPointToPdfPoint(x + width, y + height, viewport);

  return {
    x1: Math.min(topLeft.x, bottomRight.x),
    y1: Math.min(topLeft.y, bottomRight.y),
    x2: Math.max(topLeft.x, bottomRight.x),
    y2: Math.max(topLeft.y, bottomRight.y),
  };
}

export function pdfArrayRectToViewportRect(
  rect: number[],
  viewport: PageViewport,
) {
  return pdfRectToViewportRect(
    {
      x1: rect[0],
      y1: rect[1],
      x2: rect[2],
      y2: rect[3],
    },
    viewport,
  );
}
