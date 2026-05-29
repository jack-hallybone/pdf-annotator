import { boundsForRects } from './annotationGeometry';
import {
  viewportPointToPdfPoint,
  viewportRectToPdfRect
} from './pdfGeometry';
import type { PageViewport, PdfAnnotation, PdfPoint, PdfRect } from './types';
import { clamp } from './viewerConfig';

export type TextLayerRect = {
  index: number;
  rect: PdfRect;
  text: string;
};

export function getTextLayerRects(
  textLayerElement: HTMLElement | null,
  pageElement: HTMLElement | null,
  viewport: PageViewport
): TextLayerRect[] {
  if (!textLayerElement || !pageElement) {
    return [];
  }

  const pageBounds = pageElement.getBoundingClientRect();
  const textRects: TextLayerRect[] = [];

  for (const span of Array.from(textLayerElement.querySelectorAll('span'))) {
    const textNode = Array.from(span.childNodes).find(
      (node): node is Text => node.nodeType === Node.TEXT_NODE
    );
    const text = textNode?.data ?? span.textContent ?? '';
    if (!text) {
      continue;
    }

    if (textNode) {
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const clientRects = getTextNodeClientRects(
          textNode,
          index,
          index + 1
        );

        for (const clientRect of clientRects) {
          appendTextLayerRect(
            textRects,
            character,
            clientRect,
            pageBounds,
            viewport
          );
        }
      }

      continue;
    }

    for (const clientRect of Array.from(span.getClientRects())) {
      appendTextLayerRect(
        textRects,
        text.trim(),
        clientRect,
        pageBounds,
        viewport
      );
    }
  }

  return textRects;
}

function getTextNodeClientRects(textNode: Text, start: number, end: number) {
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const rects = Array.from(range.getClientRects());
  range.detach();
  return rects;
}

function appendTextLayerRect(
  textRects: TextLayerRect[],
  text: string,
  clientRect: DOMRect,
  pageBounds: DOMRect,
  viewport: PageViewport
) {
  const left = clamp(clientRect.left - pageBounds.left, 0, viewport.width);
  const right = clamp(clientRect.right - pageBounds.left, 0, viewport.width);
  const top = clamp(clientRect.top - pageBounds.top, 0, viewport.height);
  const bottom = clamp(clientRect.bottom - pageBounds.top, 0, viewport.height);

  if (right - left < 1 || bottom - top < 1 || !text) {
    return;
  }

  textRects.push({
    index: textRects.length,
    rect: viewportRectToPdfRect(left, top, right - left, bottom - top, viewport),
    text
  });
}

export function getTextForHighlights(
  annotations: PdfAnnotation[],
  textLayerElement: HTMLElement | null,
  pageElement: HTMLElement | null,
  viewport: PageViewport
) {
  const textRects = getTextLayerRects(textLayerElement, pageElement, viewport);
  const highlights = annotations.filter(
    (annotation): annotation is Extract<PdfAnnotation, { kind: 'textHighlight' }> =>
      annotation.kind === 'textHighlight'
  );

  return highlights
    .map((highlight) => {
      const selectedTextRects = textRects.filter((textRect) =>
        highlight.rects.some((highlightRect) =>
          textRectOverlapsHighlight(textRect.rect, highlightRect)
        )
      );

      return joinTextLayerSegments(selectedTextRects);
    })
    .filter(Boolean)
    .join('\n');
}

export function joinTextLayerSegments(textRects: TextLayerRect[]) {
  if (textRects.length === 0) {
    return '';
  }

  const lines: string[][] = [[]];
  let previous = textRects[0];

  for (const textRect of textRects) {
    if (
      textRect !== previous &&
      Math.abs(rectCenterY(textRect.rect) - rectCenterY(previous.rect)) >
        Math.max(rectHeight(textRect.rect), rectHeight(previous.rect)) * 0.8
    ) {
      lines.push([]);
    }

    lines.at(-1)?.push(textRect.text);
    previous = textRect;
  }

  return lines.map((line) => line.join('')).join('\n');
}

export function textLayerSegmentsToHighlightRects(textRects: TextLayerRect[]) {
  return groupTextLayerSegmentsByLine(textRects).map((line) =>
    boundsForRects(line.map((segment) => segment.rect))
  );
}

export function textLayerSegmentsInRange(
  textRects: TextLayerRect[],
  startIndex: number,
  endIndex: number
) {
  const start = Math.min(startIndex, endIndex);
  const end = Math.max(startIndex, endIndex);
  return textRects.filter(
    (textRect) => textRect.index >= start && textRect.index <= end
  );
}

function groupTextLayerSegmentsByLine(textRects: TextLayerRect[]) {
  const lines: TextLayerRect[][] = [];

  for (const textRect of textRects) {
    const currentLine = lines.at(-1);
    const previous = currentLine?.at(-1);

    if (
      !currentLine ||
      !previous ||
      Math.abs(rectCenterY(textRect.rect) - rectCenterY(previous.rect)) >
        Math.max(rectHeight(textRect.rect), rectHeight(previous.rect)) * 0.8
    ) {
      lines.push([textRect]);
    } else {
      currentLine.push(textRect);
    }
  }

  return lines;
}

export function textRectOverlapsHighlight(
  textRect: PdfRect,
  highlightRect: PdfRect
) {
  const overlap = rectOverlapArea(textRect, highlightRect);
  const denominator = Math.min(rectArea(textRect), rectArea(highlightRect));
  if (overlap <= 0 || denominator <= 0) {
    return false;
  }

  return overlap / denominator > 0.18;
}

function rectOverlapArea(a: PdfRect, b: PdfRect) {
  const left = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
  const right = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
  const bottom = Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
  const top = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
  return Math.max(0, right - left) * Math.max(0, top - bottom);
}

function rectArea(rect: PdfRect) {
  return (
    Math.max(0, Math.abs(rect.x2 - rect.x1)) *
    Math.max(0, Math.abs(rect.y2 - rect.y1))
  );
}

function rectCenterY(rect: PdfRect) {
  return (rect.y1 + rect.y2) / 2;
}

function rectHeight(rect: PdfRect) {
  return Math.abs(rect.y2 - rect.y1);
}

export function distanceToRect(point: PdfPoint, rect: PdfRect) {
  const x = clamp(point.x, Math.min(rect.x1, rect.x2), Math.max(rect.x1, rect.x2));
  const y = clamp(point.y, Math.min(rect.y1, rect.y2), Math.max(rect.y1, rect.y2));
  return Math.hypot(point.x - x, point.y - y);
}

export function nearestTextRectIndex(
  textRects: TextLayerRect[],
  point: PdfPoint
) {
  let bestIndex = textRects[0]?.index ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const textRect of textRects) {
    const distance = distanceToRect(point, textRect.rect);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = textRect.index;
    }
  }

  return bestIndex;
}

export function getSelectedTextRects(
  selection: Selection,
  pageElement: HTMLElement,
  textLayerElement: HTMLElement | null,
  viewport: PageViewport
) {
  const pageBounds = pageElement.getBoundingClientRect();
  const selectedRanges = Array.from({ length: selection.rangeCount }, (_, i) =>
    selection.getRangeAt(i)
  );
  const selectedTextSpans = textLayerElement
    ? Array.from(textLayerElement.querySelectorAll('span')).filter((span) =>
        selectedRanges.some((range) => rangeIntersectsNode(range, span))
      )
    : [];
  const spanClientRects = selectedTextSpans.flatMap((span) =>
    Array.from(span.getClientRects())
  );
  const rangeClientRects = selectedRanges.flatMap((range) =>
    Array.from(range.getClientRects())
  );
  const sourceRects =
    spanClientRects.length > 0
      ? intersectClientRects(spanClientRects, rangeClientRects)
      : rangeClientRects;
  const rects: PdfRect[] = [];
  const quadPoints: number[][] = [];

  for (const clientRect of dedupeClientRects(sourceRects)) {
    const left = clamp(clientRect.left - pageBounds.left, 0, viewport.width);
    const right = clamp(clientRect.right - pageBounds.left, 0, viewport.width);
    const top = clamp(clientRect.top - pageBounds.top, 0, viewport.height);
    const bottom = clamp(
      clientRect.bottom - pageBounds.top,
      0,
      viewport.height
    );

    if (right - left < 2 || bottom - top < 2) {
      continue;
    }

    const topLeft = viewportPointToPdfPoint(left, top, viewport);
    const topRight = viewportPointToPdfPoint(right, top, viewport);
    const bottomLeft = viewportPointToPdfPoint(left, bottom, viewport);
    const bottomRight = viewportPointToPdfPoint(right, bottom, viewport);

    rects.push({
      x1: Math.min(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x),
      y1: Math.min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y),
      x2: Math.max(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x),
      y2: Math.max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y)
    });
    quadPoints.push([
      topLeft.x,
      topLeft.y,
      topRight.x,
      topRight.y,
      bottomLeft.x,
      bottomLeft.y,
      bottomRight.x,
      bottomRight.y
    ]);
  }

  return { rects, quadPoints };
}

function rangeIntersectsNode(range: Range, node: Node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function intersectClientRects(baseRects: DOMRect[], maskRects: DOMRect[]) {
  if (maskRects.length === 0) {
    return baseRects;
  }

  const intersections: DOMRect[] = [];

  for (const base of baseRects) {
    for (const mask of maskRects) {
      const left = Math.max(base.left, mask.left);
      const right = Math.min(base.right, mask.right);
      const top = Math.max(base.top, mask.top);
      const bottom = Math.min(base.bottom, mask.bottom);

      if (right - left >= 1 && bottom - top >= 1) {
        intersections.push(new DOMRect(left, top, right - left, bottom - top));
      }
    }
  }

  return intersections.length > 0 ? intersections : baseRects;
}

function dedupeClientRects(rects: DOMRect[]) {
  const seen = new Set<string>();
  return rects.filter((rect) => {
    const key = [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.right),
      Math.round(rect.bottom)
    ].join(':');

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
