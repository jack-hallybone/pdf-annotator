import type { PdfRect } from './types';
import { clamp } from './viewerConfig';

export const FREE_TEXT_LINE_HEIGHT = 1.25;

export const FREE_TEXT_MAX_WIDTH = 512;
const FREE_TEXT_EMPTY_WIDTH = 96;
export const FREE_TEXT_MIN_WIDTH = 28;
const FREE_TEXT_WIDTH_BUFFER = 10;
const FREE_TEXT_HEIGHT_BUFFER = 4;
const AVERAGE_CHARACTER_WIDTH = 0.54;

type FreeTextLayoutOptions = {
  layoutWidth?: number;
};

export function resizeFreeTextRect(
  rect: PdfRect,
  text: string,
  fontSize: number,
  options: FreeTextLayoutOptions = {}
) {
  const { height, width } = freeTextContentSize(text, fontSize, options);
  const left = Math.min(rect.x1, rect.x2);
  const top = Math.max(rect.y1, rect.y2);

  return {
    x1: left,
    y1: top - height,
    x2: left + width,
    y2: top
  };
}

export function freeTextContentRect(
  rect: PdfRect,
  text: string,
  fontSize: number,
  options: FreeTextLayoutOptions = {}
) {
  const { height, width } = freeTextContentSize(text, fontSize, options);
  const x1 = Math.min(rect.x1, rect.x2);
  const y2 = Math.max(rect.y1, rect.y2);
  const maxWidth = Math.abs(rect.x2 - rect.x1);
  const maxHeight = Math.abs(rect.y2 - rect.y1);

  return {
    x1,
    y1: y2 - Math.min(height, maxHeight),
    x2: x1 + Math.min(width, maxWidth),
    y2
  };
}

export function freeTextVisualLines(
  text: string,
  fontSize: number,
  layoutWidth: number
) {
  const sourceLines = text.trim().length === 0 ? [''] : text.split(/\r?\n/);
  const contentWidth = Math.max(
    layoutWidth - FREE_TEXT_WIDTH_BUFFER,
    fontSize
  );
  const maxCharactersPerLine = Math.max(
    1,
    Math.floor(contentWidth / (fontSize * AVERAGE_CHARACTER_WIDTH))
  );

  return sourceLines.flatMap((line) => wrapLine(line, maxCharactersPerLine));
}

function freeTextContentSize(
  text: string,
  fontSize: number,
  { layoutWidth }: FreeTextLayoutOptions
) {
  const empty = text.trim().length === 0;
  const lines = empty ? ['Text...'] : text.split(/\r?\n/);
  const longestLineLength = Math.max(
    1,
    ...lines.map((line) => line.trimEnd().length)
  );
  const measuredWidth = clamp(
    lineWidth(longestLineLength, fontSize) + FREE_TEXT_WIDTH_BUFFER,
    empty ? FREE_TEXT_EMPTY_WIDTH : FREE_TEXT_MIN_WIDTH,
    FREE_TEXT_MAX_WIDTH
  );
  const width =
    layoutWidth === undefined
      ? measuredWidth
      : clamp(layoutWidth, FREE_TEXT_MIN_WIDTH, FREE_TEXT_MAX_WIDTH);
  const shouldWrap =
    layoutWidth !== undefined || measuredWidth >= FREE_TEXT_MAX_WIDTH;
  const visualLineCount = shouldWrap
    ? freeTextVisualLines(text, fontSize, width).length
    : lines.length;
  const lineHeight = fontSize * FREE_TEXT_LINE_HEIGHT;
  const height = Math.max(
    lineHeight + FREE_TEXT_HEIGHT_BUFFER,
    visualLineCount * lineHeight + FREE_TEXT_HEIGHT_BUFFER
  );

  return { height, width };
}

function lineWidth(characterCount: number, fontSize: number) {
  return Math.max(1, characterCount) * fontSize * AVERAGE_CHARACTER_WIDTH;
}

function wrapLine(line: string, maxCharactersPerLine: number) {
  if (line.length === 0) {
    return [''];
  }

  const wrapped: string[] = [];
  for (let index = 0; index < line.length; index += maxCharactersPerLine) {
    wrapped.push(line.slice(index, index + maxCharactersPerLine));
  }

  return wrapped;
}
