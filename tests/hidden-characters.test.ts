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
  strippedLiveText,
} from "../src/pdfdocumenteditor/untrustedText";

// A sweep, because the defect was a list: a test that enumerates the characters it thinks are dangerous is that defect wearing a test's clothes, so this one lists none and asks the engine about every code point.
const INVISIBLE =
  /^[\p{Bidi_Control}\p{Join_Control}\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u;

// The one code point no property reaches: a sweep over all 0x110000 found exactly one that paints nothing and is in none of them, and it is not whitespace either, so nothing that trims or collapses `\s` touches it.
const BLANK_GLYPH = "\u2800";

const LAST_CODE_POINT = 0x10ffff;

// The one list here, and a decided one: what a note's text is made of though it paints nothing. A line break and a tab lay it out (a carriage return is normalised to a line break before the strip runs), ZWNJ and ZWJ join letters and emoji, variation selectors pick a form, tag characters spell a flag. Everything else the sweep finds still has to go.
const KEPT_IN_NOTE_TEXT =
  /^(?:\t|\n|\r|\u200c|\u200d|[\ufe00-\ufe0f]|[\u{e0020}-\u{e007f}]|[\u{e0100}-\u{e01ef}])$/u;

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
  // A sweep that matched nothing would pass every assertion below on an implementation that strips nothing at all.
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

test("no invisible code point reaches a string a reader sees, unless the text is made of it", () => {
  // Direction is never the text's own: a bidi control kept here would be the spoofing the strip exists to stop.
  assert.deepEqual(
    INVISIBLE_CHARACTERS.filter(
      (char) => KEPT_IN_NOTE_TEXT.test(char) && /\p{Bidi_Control}/u.test(char),
    ).map(name),
    [],
    "a bidi control is on the kept list",
  );

  const survivors: string[] = [];
  const lost: string[] = [];
  for (const char of INVISIBLE_CHARACTERS) {
    const keeps = KEPT_IN_NOTE_TEXT.test(char);
    const expected = keeps ? `a${char === "\r" ? "\n" : char}b` : "ab";
    // A title is one line, so a kept line break or tab collapses to a space there.
    const expectedLine = keeps && /\s/.test(char) ? "a b" : expected;
    if (
      strippedDocumentText(`a${char}b`) !== expected ||
      strippedLiveText(`a${char}b`) !== expected ||
      boundedDocumentText(`a${char}b`, 100) !== expected ||
      boundedDocumentLine(`a${char}b`, 100) !== expectedLine
    ) {
      (keeps ? lost : survivors).push(char);
    }
  }
  assert.deepEqual(
    survivors.map(name),
    [],
    "an invisible code point reached the annotations sidebar",
  );
  assert.deepEqual(
    lost.map(name),
    [],
    "a character the text is made of was stripped out of it",
  );
});

// Each of these lost a character to the rule before it had exceptions, and read differently for it: a Persian word its ZWNJ, a Sinhala conjunct and an emoji family their ZWJs, a heart its emoji presentation, an ideograph its variant, a flag its tag characters, a table its tabs.
test("text that needs its joiners, selectors, tag characters and tabs keeps them", () => {
  for (const value of [
    "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
    "\u0dc1\u0dca\u200d\u0dbb\u0dd3",
    "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
    "\u2764\ufe0f",
    "\u845b\u{e0100}",
    "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}",
    "Qty\t5\nPrice\t20",
  ]) {
    assert.equal(strippedDocumentText(value), value, JSON.stringify(value));
    assert.equal(strippedLiveText(value), value, JSON.stringify(value));
  }
});

// strippedLiveText backs a controlled textarea's onChange (the sticky note popover): it must strip the same characters as strippedDocumentText, but never trim, or a space or newline the reader just typed at the end of the text would disappear before a next word or line could follow it.
test("the live variant strips the same characters but never trims", () => {
  assert.equal(strippedLiveText("  hello  "), "  hello  ");
  assert.equal(
    strippedLiveText("line one\nline two\n"),
    "line one\nline two\n",
  );
  assert.equal(strippedLiveText(42), "");
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
