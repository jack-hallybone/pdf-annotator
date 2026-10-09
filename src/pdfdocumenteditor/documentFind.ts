import type { PdfRect } from "./types";

/* Find in document, minus the DOM and pdf.js. A page's text is folded once - lower case, accents dropped, ligatures and curly quotes spelt out, runs of whitespace collapsed - and every query is folded the same way, so matching is a plain search of the folded text, mapped back afterwards onto the characters the page's text layer draws. */

/** The fields of a pdf.js text item this reads. Marked-content items (`{ type }`, no `str`) are skipped, as the text layer skips them. */
export type FindTextItem = {
  hasEOL: boolean;
  str: string;
  transform: number[];
  width: number;
};

/** One page's text, folded for matching, with the way back to the text layer's own characters. */
export type PageFindText = {
  /** Each item's six transform numbers and its advance width, for placing a match on a page that is not drawn yet. */
  itemGeometry: Float32Array;
  /** Where each text item starts in the text layer's characters, which are the items' strings end to end. */
  itemStarts: Int32Array;
  originalLength: number;
  // Folded characters in runs that step through the original one character at a time; a ligature, a collapsed space or a line break starts a new run. The width is how many original characters each folded one stands for: 0 for the space a line break becomes.
  runOrigins: Int32Array;
  runStarts: Int32Array;
  runWidths: Uint8Array;
  text: string;
};

/** A page's matches as [start, end) pairs of text-layer character offsets, end to end. */
export type PageFindMatches = Int32Array;

export type FindMatchPosition = {
  matchIndex: number;
  pageIndex: number;
};

// Stands in for a hyphen that ends a line, which is usually a word broken in two: a query matches straight through it ("example" in "exam-" / "ple") or takes it as the hyphen it may be ("self-evident" in "self-" / "evident"). Never present in folded text otherwise, since a real soft hyphen folds to it too.
const BREAK_HYPHEN = "\u00ad";
const COMBINING_MARKS = /\p{M}/gu;
const WHITESPACE = /\s/u;
// pdf.js's own find joins these across a line break without a space, since CJK text has none between words.
const CJK = /[\p{Ideographic}\u3040-\u30ff]/u;
const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|/-]/g;
const NO_MATCHES: PageFindMatches = new Int32Array(0);

const ASCII_FOLDS = Array.from({ length: 128 }, (_, code) => {
  if (code >= 65 && code <= 90) {
    return String.fromCharCode(code + 32);
  }
  if (code === 32 || (code >= 9 && code <= 13)) {
    return " ";
  }
  return code < 32 || code === 127 ? "" : String.fromCharCode(code);
});

// What compatibility decomposition leaves alone but a reader types differently. Applied after it, so the non-breaking hyphen arrives here as U+2010 and ½ as 1, U+2044, 2. Escaped, since most look like an ASCII character or like nothing at all.
const SPECIAL_FOLDS = new Map([
  // Soft hyphen; hyphen.
  ["\u00ad", BREAK_HYPHEN],
  ["\u2010", "-"],
  // Quotation marks: curly, low and reversed, single and double.
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201a", "'"],
  ["\u201b", "'"],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["\u201e", '"'],
  ["\u201f", '"'],
  // Fraction slash.
  ["\u2044", "/"],
  // Final sigma, as a capital sigma lower-cases to the other.
  ["\u03c2", "\u03c3"],
  // Zero-width space, non-joiner and joiner; word joiner; byte order mark.
  ["\u200b", ""],
  ["\u200c", ""],
  ["\u200d", ""],
  ["\u2060", ""],
  ["\ufeff", ""],
]);

const nonAsciiFolds = new Map<string, string>();

/** One code point as find compares it; possibly empty, possibly several characters (a ligature). */
export function foldCharacter(character: string) {
  if (character.length === 1 && character.charCodeAt(0) < 128) {
    return ASCII_FOLDS[character.charCodeAt(0)];
  }

  let folded = nonAsciiFolds.get(character);
  if (folded === undefined) {
    folded = "";
    // NFKD spells out ligatures and full-width forms and splits accents off, so dropping marks is what makes "cafe" find "café".
    for (const part of character
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .toLowerCase()) {
      folded += SPECIAL_FOLDS.get(part) ?? (WHITESPACE.test(part) ? " " : part);
    }
    nonAsciiFolds.set(character, folded);
  }
  return folded;
}

/** `items` is a pdf.js text content's items, which must be read with `disableNormalization` (and `includeMarkedContent` is harmless) so that they match the text layer character for character. */
export function buildPageFindText(
  items: ReadonlyArray<FindTextItem | { type: string }>,
): PageFindText {
  const folded: string[] = [];
  const runStarts: number[] = [];
  const runOrigins: number[] = [];
  const runWidths: number[] = [];
  const itemStarts: number[] = [];
  const itemGeometry: number[] = [];
  let original = 0;
  let previous = "";
  let last = "";

  function emit(character: string, origin: number, width: number) {
    if (character === " " && (last === " " || last === "")) {
      return;
    }

    const run = runStarts.length - 1;
    if (
      run < 0 ||
      width !== 1 ||
      runWidths[run] !== 1 ||
      origin !== runOrigins[run] + folded.length - runStarts[run]
    ) {
      runStarts.push(folded.length);
      runOrigins.push(origin);
      runWidths.push(width);
    }
    folded.push(character);
    previous = last;
    last = character;
  }

  for (const item of items) {
    if (!("str" in item)) {
      continue;
    }

    itemStarts.push(original);
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
    itemGeometry.push(a, b, c, d, e, f, item.width);

    let offset = 0;
    for (const character of item.str) {
      const foldedCharacter = foldCharacter(character);
      const origin = original + offset;
      // Same length: one folded character per original one, so each keeps its own place. Otherwise every folded character stands for the whole original, as both letters of a ligature do.
      const oneToOne = foldedCharacter.length === character.length;
      for (let unit = 0; unit < foldedCharacter.length; unit += 1) {
        emit(
          foldedCharacter[unit],
          oneToOne ? origin + unit : origin,
          oneToOne ? 1 : character.length,
        );
      }
      offset += character.length;
    }
    original += item.str.length;

    if (!item.hasEOL) {
      continue;
    }

    if (last === "-" && previous !== "" && previous !== " ") {
      folded[folded.length - 1] = BREAK_HYPHEN;
      last = BREAK_HYPHEN;
    } else if (
      last !== "" &&
      last !== " " &&
      last !== BREAK_HYPHEN &&
      !CJK.test(last)
    ) {
      // The line break itself has no character in the text layer, so the space it becomes takes up none.
      emit(" ", original, 0);
    }
  }

  return {
    itemGeometry: Float32Array.from(itemGeometry),
    itemStarts: Int32Array.from(itemStarts),
    originalLength: original,
    runOrigins: Int32Array.from(runOrigins),
    runStarts: Int32Array.from(runStarts),
    runWidths: Uint8Array.from(runWidths),
    text: folded.join(""),
  };
}

/** Null when there is nothing to look for. Matches whatever case and accents the page uses, and a line-end hyphen as either a hyphen or nothing. */
export function compileFindQuery(query: string) {
  const characters: string[] = [];
  for (const character of query) {
    for (const part of foldCharacter(character)) {
      if (
        part === BREAK_HYPHEN ||
        (part === " " && (characters.length === 0 || characters.at(-1) === " "))
      ) {
        continue;
      }
      characters.push(part);
    }
  }

  if (characters.at(-1) === " ") {
    characters.pop();
  }
  if (characters.length === 0) {
    return null;
  }

  return new RegExp(
    characters
      .map((character) =>
        character === "-"
          ? `[-${BREAK_HYPHEN}]`
          : character.replace(REGEXP_SPECIAL, "\\$&"),
      )
      .join(`${BREAK_HYPHEN}?`),
    "g",
  );
}

export function findPageMatches(
  pageText: PageFindText,
  pattern: RegExp,
): PageFindMatches {
  const bounds: number[] = [];
  pattern.lastIndex = 0;
  for (
    let match = pattern.exec(pageText.text);
    match;
    match = pattern.exec(pageText.text)
  ) {
    const lastIndex = match.index + match[0].length - 1;
    const lastRun = runAt(pageText, lastIndex);
    bounds.push(
      originAt(pageText, runAt(pageText, match.index), match.index),
      originAt(pageText, lastRun, lastIndex) + pageText.runWidths[lastRun],
    );
  }

  return bounds.length > 0 ? Int32Array.from(bounds) : NO_MATCHES;
}

function runAt(pageText: PageFindText, index: number) {
  const { runStarts } = pageText;
  let low = 0;
  let high = runStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (runStarts[middle] <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function originAt(pageText: PageFindText, run: number, index: number) {
  return pageText.runOrigins[run] + index - pageText.runStarts[run];
}

/** Roughly where a match sits on its page, in PDF units: each item's advance is shared evenly between its characters, which is close enough to scroll to. */
export function findMatchBounds(
  pageText: PageFindText,
  start: number,
  end: number,
): PdfRect | null {
  const { itemGeometry, itemStarts, originalLength } = pageText;
  let bounds: PdfRect | null = null;

  for (let item = 0; item < itemStarts.length; item += 1) {
    const itemStart = itemStarts[item];
    const itemEnd =
      item + 1 < itemStarts.length ? itemStarts[item + 1] : originalLength;
    if (itemStart >= end) {
      break;
    }
    if (itemEnd <= start || itemEnd <= itemStart) {
      continue;
    }

    const length = itemEnd - itemStart;
    const from = (Math.max(start, itemStart) - itemStart) / length;
    const to = (Math.min(end, itemEnd) - itemStart) / length;
    const [a, b, c, d, e, f, width] = itemGeometry.subarray(
      item * 7,
      item * 7 + 7,
    );
    // Along the baseline and up from it, in the item's own text matrix, so rotated text is placed too.
    const advance = Math.hypot(a, b) || 1;
    const fontHeight = Math.hypot(c, d);
    const alongX = (a / advance) * width;
    const alongY = (b / advance) * width;
    const upX = fontHeight > 0 ? c / fontHeight : 0;
    const upY = fontHeight > 0 ? d / fontHeight : 1;
    for (const along of [from, to]) {
      // A descender's depth below the baseline, a capital's height above it.
      for (const up of [-0.25 * fontHeight, fontHeight]) {
        const x = e + alongX * along + upX * up;
        const y = f + alongY * along + upY * up;
        bounds = bounds
          ? {
              x1: Math.min(bounds.x1, x),
              x2: Math.max(bounds.x2, x),
              y1: Math.min(bounds.y1, y),
              y2: Math.max(bounds.y2, y),
            }
          : { x1: x, x2: x, y1: y, y2: y };
      }
    }
  }

  return bounds;
}

/** The first match starting at or after `offset`, or -1. */
export function firstMatchFrom(matches: PageFindMatches, offset: number) {
  for (let index = 0; index < matches.length; index += 2) {
    if (matches[index] >= offset) {
      return index / 2;
    }
  }
  return -1;
}

/** One match on from `from` in document order, wrapping at either end; null while a page it would have to look past is still unread. */
export function adjacentFindMatch(
  from: FindMatchPosition,
  direction: 1 | -1,
  matchesByPage: ReadonlyMap<number, PageFindMatches>,
  readPages: Uint8Array,
): FindMatchPosition | null {
  const onPage = (matchesByPage.get(from.pageIndex)?.length ?? 0) / 2;
  const matchIndex = from.matchIndex + direction;
  if (matchIndex >= 0 && matchIndex < onPage) {
    return { matchIndex, pageIndex: from.pageIndex };
  }

  const pageCount = readPages.length;
  for (let step = 1; step <= pageCount; step += 1) {
    const pageIndex =
      (((from.pageIndex + direction * step) % pageCount) + pageCount) %
      pageCount;
    if (!readPages[pageIndex]) {
      return null;
    }

    const matches = matchesByPage.get(pageIndex);
    if (matches && matches.length > 0) {
      return {
        matchIndex: direction > 0 ? 0 : matches.length / 2 - 1,
        pageIndex,
      };
    }
  }

  return null;
}

/** "n" and "m" of "n of m": `current` is 1-based, and 0 with no current match. */
export function countFindMatches(
  matchesByPage: ReadonlyMap<number, PageFindMatches>,
  current: FindMatchPosition | null,
) {
  let total = 0;
  let before = 0;
  for (const [pageIndex, matches] of matchesByPage) {
    total += matches.length / 2;
    if (current && pageIndex < current.pageIndex) {
      before += matches.length / 2;
    }
  }

  return {
    current: current ? before + current.matchIndex + 1 : 0,
    total,
  };
}
