import assert from "node:assert/strict";
import test from "node:test";

import { stripHiddenCharacters } from "../src/hiddenCharacters";
import {
  displayableFileName,
  pdfFileNameFromStem,
  safePdfFileName,
} from "../src/fileNames";
import {
  boundedDocumentLine,
  boundedDocumentText,
  strippedDocumentText,
} from "../src/pdfdocumenteditor/untrustedText";

// A sweep, because the defect was a list: a test that enumerates the characters
// it thinks are dangerous is that defect wearing a test's clothes, so this one
// lists none and asks the engine about every code point.
const INVISIBLE =
  /^[\p{Bidi_Control}\p{Join_Control}\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u;

// The one code point no property reaches: a sweep over all 0x110000 found
// exactly one that paints nothing and is in none of them, and it is not
// whitespace either, so nothing that trims or collapses `\s` touches it.
const BLANK_GLYPH = "\u2800";

const LAST_CODE_POINT = 0x10ffff;

// A line break is content in a note, and a carriage return is normalised to one
// before the strip runs.
const KEPT_IN_NOTE_TEXT = new Map([
  ["\n", "a\nb"],
  ["\r", "a\nb"],
]);

function invisibleCodePoints() {
  const points: string[] = [];
  for (let codePoint = 0; codePoint <= LAST_CODE_POINT; codePoint += 1) {
    const char = String.fromCodePoint(codePoint);
    if (INVISIBLE.test(char) || char === BLANK_GLYPH) {
      points.push(char);
    }
  }
  return points;
}

function name(char: string) {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

const INVISIBLE_CHARACTERS = invisibleCodePoints();

test("the sweep sees the whole class, or it proves nothing", () => {
  // A sweep that matched nothing would pass every assertion below on an
  // implementation that strips nothing at all.
  assert.ok(
    INVISIBLE_CHARACTERS.length > 5000,
    `expected Unicode's invisibles, saw ${INVISIBLE_CHARACTERS.length}`,
  );
  assert.ok(
    INVISIBLE_CHARACTERS.includes("؜"),
    "U+061C ARABIC LETTER MARK is not in the swept class",
  );
  assert.ok(
    INVISIBLE_CHARACTERS.includes(BLANK_GLYPH),
    "U+2800 BRAILLE PATTERN BLANK is not in the swept class",
  );
});

test("no invisible code point survives the shared strip", () => {
  const survivors = INVISIBLE_CHARACTERS.filter(
    (char) => stripHiddenCharacters(`a${char}b`) !== "ab",
  );
  assert.deepEqual(
    survivors.map(name),
    [],
    "an invisible code point survived stripHiddenCharacters",
  );
});

test("no invisible code point reaches a string a reader sees", () => {
  const survivors: string[] = [];
  for (const char of INVISIBLE_CHARACTERS) {
    const kept = KEPT_IN_NOTE_TEXT.get(char);
    const expected = kept ?? "ab";
    if (
      strippedDocumentText(`a${char}b`) !== expected ||
      boundedDocumentText(`a${char}b`, 100) !== expected ||
      boundedDocumentLine(`a${char}b`, 100) !== (kept ? "a b" : "ab")
    ) {
      survivors.push(char);
    }
  }
  assert.deepEqual(
    survivors.map(name),
    [],
    "an invisible code point reached the annotations sidebar",
  );
});

test("no invisible code point reaches a filename or a title a reader sees", () => {
  const survivors: string[] = [];
  for (const char of INVISIBLE_CHARACTERS) {
    if (
      safePdfFileName(`a${char}b`) !== "a_b.pdf" ||
      pdfFileNameFromStem(`a${char}b`) !== "a b.pdf" ||
      displayableFileName(`a${char}b`) !== "ab"
    ) {
      survivors.push(char);
    }
  }
  assert.deepEqual(
    survivors.map(name),
    [],
    "an invisible code point reached a download filename or a document title",
  );
});

test("visible text is left exactly as it was", () => {
  for (const value of [
    "Pay 100 to ACME",
    "المبلغ 100 USD",
    "quarterly report (final).pdf",
    "Ünïcödé — em dash, ½, ﬁ",
    "日本語のメモ",
    "😀 base emoji",
  ]) {
    assert.equal(strippedDocumentText(value), value, value);
  }
  assert.equal(safePdfFileName("Ünïcödé"), "Ünïcödé.pdf");
});
