/*
 * The one place text out of a PDF, or typed by a reader and written into one,
 * is bounded and stripped, both directions being untrusted.
 */
import { stripHiddenCharacters } from "../hiddenCharacters";

/*
 * What is removed is a set of Unicode properties, not a list of characters:
 * every invisible code point lets two different strings paint the same row.
 */

const KEPT_CONTROL = "\n";

/** At most `maxLength` characters; a non-string reads as absent. */
export function boundedDocumentText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return "";
  }

  return stripHiddenCharacters(value.replace(/\r\n?/g, "\n"), KEPT_CONTROL)
    .slice(0, maxLength)
    .trim();
}

/** The same, collapsed to one line. */
export function boundedDocumentLine(value: unknown, maxLength: number) {
  return boundedDocumentText(value, maxLength).replace(/\s+/g, " ").trim();
}

/**
 * The character rules without a length bound, for text that is the annotation
 * rather than a note about it: cutting it short deletes the reader's content.
 */
export function strippedDocumentText(value: unknown) {
  return boundedDocumentText(value, Number.POSITIVE_INFINITY);
}
