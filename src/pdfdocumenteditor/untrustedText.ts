/* The one place text out of a PDF, or typed by a reader and written into one, is bounded and stripped, both directions being untrusted. */
import { stripHiddenCharacters } from "../hiddenCharacters";

/* What is removed is a set of Unicode properties, not a list of characters: every invisible code point lets two different strings paint the same row. */

// The exceptions are a list, of what text is made of though it paints nothing: a line break and a tab lay a note out, ZWNJ and ZWJ join letters (Persian, Indic scripts) and emoji, variation selectors pick an emoji's or an ideograph's form, and tag characters spell a flag. Bidi controls and every other invisible still go.
export const KEPT_IN_TEXT =
  /\t|\n|\u200c|\u200d|[\ufe00-\ufe0f]|[\u{e0020}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/u;

/** At most `maxLength` characters; a non-string reads as absent. */
export function boundedDocumentText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return "";
  }

  return stripHiddenCharacters(value.replace(/\r\n?/g, "\n"), KEPT_IN_TEXT)
    .slice(0, maxLength)
    .trim();
}

/** The same, collapsed to one line. */
export function boundedDocumentLine(value: unknown, maxLength: number) {
  return boundedDocumentText(value, maxLength).replace(/\s+/g, " ").trim();
}

/** The character rules without a length bound, for text that is the annotation rather than a note about it: cutting it short deletes the reader's content. */
export function strippedDocumentText(value: unknown) {
  return boundedDocumentText(value, Number.POSITIVE_INFINITY);
}

/** The character rules alone: no length bound, and no trim either. For a controlled input's onChange, where the string is still being composed and a trailing space or newline the reader just typed is not yet "trailing" - trimming on every keystroke would delete it before a next word could follow. The untrimmed length is a live editor's own concern, not this module's; the boundary that matters here is what a save trims, and that still runs through strippedDocumentText. */
export function strippedLiveText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return stripHiddenCharacters(value.replace(/\r\n?/g, "\n"), KEPT_IN_TEXT);
}
