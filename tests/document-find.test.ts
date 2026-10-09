import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  adjacentFindMatch,
  buildPageFindText,
  compileFindQuery,
  countFindMatches,
  findMatchBounds,
  findPageMatches,
  firstMatchFrom,
  type FindTextItem,
} from "../src/pdfdocumenteditor/documentFind";

// PDF.js's browser entry touches these while it loads, though nothing here draws.
installPdfJsGlobals();
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

// Text items as pdf.js hands them to the text layer: a line's text, and whether a line break follows it.
function line(str: string, hasEOL = true): FindTextItem {
  return { hasEOL, str, transform: [10, 0, 0, 10, 0, 0], width: 5 };
}

// What each match covers in the text layer's own characters, which are the items' strings end to end.
function found(items: Array<FindTextItem | { type: string }>, query: string) {
  const pattern = compileFindQuery(query);
  assert.ok(pattern, `"${query}" compiled to nothing`);
  const original = items
    .map((item) => ("str" in item ? item.str : ""))
    .join("");
  const matches = findPageMatches(buildPageFindText(items), pattern);
  const covered: string[] = [];
  for (let index = 0; index < matches.length; index += 2) {
    covered.push(original.slice(matches[index], matches[index + 1]));
  }
  return covered;
}

test("matching ignores case and collapses whitespace", () => {
  assert.deepEqual(
    found([line("The Quick  brown fox", false)], "quick BROWN"),
    ["Quick  brown"],
  );
  assert.deepEqual(found([line("the cat and the hat", false)], "the"), [
    "the",
    "the",
  ]);
  assert.deepEqual(found([line("a\u00a0b", false)], "a b"), ["a\u00a0b"]);
});

test("accents are ignored on both sides, precomposed or not", () => {
  assert.deepEqual(found([line("Café au lait", false)], "cafe"), ["Café"]);
  assert.deepEqual(found([line("cafe au lait", false)], "café"), ["cafe"]);
  // A separate combining accent draws over the letter before it, so ending the match on that letter covers the glyph.
  assert.deepEqual(found([line("cafe\u0301 noir", false)], "café"), ["cafe"]);
});

test("ligatures, full-width letters, curly quotes and fractions read as typed", () => {
  assert.deepEqual(found([line("e\ufb03cient", false)], "efficient"), [
    "e\ufb03cient",
  ]);
  // Half a ligature is the whole glyph: there is nothing smaller to cover.
  assert.deepEqual(found([line("e\ufb03cient", false)], "fic"), ["\ufb03c"]);
  assert.deepEqual(found([line("ＡＢＣ", false)], "abc"), ["ＡＢＣ"]);
  assert.deepEqual(found([line("don’t", false)], "don't"), ["don’t"]);
  assert.deepEqual(found([line("“quoted”", false)], '"quoted"'), ["“quoted”"]);
  assert.deepEqual(found([line("add ½ a cup", false)], "1/2"), ["½"]);
  assert.deepEqual(found([line("a𝐀b", false)], "aab"), ["a𝐀b"]);
});

test("a word hyphenated across lines is found whole, with or without its hyphen", () => {
  const items = [line("This is an exam-"), line("ple of a break", false)];
  assert.deepEqual(found(items, "example"), ["exam-ple"]);
  assert.deepEqual(found(items, "exam-ple"), ["exam-ple"]);
  // The hyphen belongs to the word on either side only when the match runs through it.
  assert.deepEqual(found(items, "exam"), ["exam"]);
  assert.deepEqual(found(items, "ple of"), ["ple of"]);
});

test("a compound broken at its own hyphen is found as written", () => {
  const items = [line("it is self-"), line("evident", false)];
  assert.deepEqual(found(items, "self-evident"), ["self-evident"]);
  assert.deepEqual(found(items, "selfevident"), ["self-evident"]);
  // Soft hyphens: invisible mid-line, and a break hyphen at a line end.
  assert.deepEqual(found([line("hy\u00adphen", false)], "hyphen"), [
    "hy\u00adphen",
  ]);
});

test("a line break reads as a space, but not after a dash or between CJK lines", () => {
  const items = [line("the quick brown"), line("fox jumps", false)];
  assert.deepEqual(found(items, "brown fox"), ["brownfox"]);
  assert.deepEqual(found(items, "brownfox"), []);
  // A dash after a space is punctuation, not a broken word.
  assert.deepEqual(found([line("before -"), line("after", false)], "- after"), [
    "-after",
  ]);
  assert.deepEqual(found([line("日本"), line("語", false)], "日本語"), [
    "日本語",
  ]);
  // pdf.js gives a break its own empty item as often as it marks the last word's.
  assert.deepEqual(
    found([line("one", false), line(""), line("two", false)], "one two"),
    ["onetwo"],
  );
});

test("marked-content items are skipped without shifting offsets", () => {
  assert.deepEqual(
    found(
      [
        { type: "beginMarkedContent" },
        line("Hello", false),
        { type: "endMarkedContent" },
        line(" world", false),
      ],
      "hello world",
    ),
    ["Hello world"],
  );
});

test("a query is literal text, and an empty one is no query", () => {
  assert.deepEqual(found([line("1+1=2 (yes) a.b axb", false)], "(yes)"), [
    "(yes)",
  ]);
  assert.deepEqual(found([line("a.b axb", false)], "a.b"), ["a.b"]);
  assert.equal(compileFindQuery(""), null);
  assert.equal(compileFindQuery("   "), null);
  assert.equal(compileFindQuery("\u00ad"), null);
});

test("a match is placed on the page from its item's position and advance", () => {
  const pageText = buildPageFindText([
    {
      hasEOL: false,
      str: "abcdefghij",
      transform: [12, 0, 0, 12, 100, 700],
      width: 120,
    },
  ]);
  assert.deepEqual(findMatchBounds(pageText, 2, 4), {
    x1: 124,
    x2: 148,
    y1: 697,
    y2: 712,
  });
  assert.equal(findMatchBounds(pageText, 10, 12), null);
});

test("n of m counts in page order and steps on, wrapping, only past pages already read", () => {
  const matchesByPage = new Map([
    [1, new Int32Array([0, 3, 10, 13])],
    [4, new Int32Array([5, 8])],
  ]);
  const allRead = new Uint8Array([1, 1, 1, 1, 1, 1]);

  assert.deepEqual(countFindMatches(matchesByPage, null), {
    current: 0,
    total: 3,
  });
  assert.deepEqual(
    countFindMatches(matchesByPage, { matchIndex: 0, pageIndex: 4 }),
    { current: 3, total: 3 },
  );

  const first = { matchIndex: 0, pageIndex: 1 };
  const second = adjacentFindMatch(first, 1, matchesByPage, allRead);
  assert.deepEqual(second, { matchIndex: 1, pageIndex: 1 });
  const third = adjacentFindMatch(second!, 1, matchesByPage, allRead);
  assert.deepEqual(third, { matchIndex: 0, pageIndex: 4 });
  assert.deepEqual(adjacentFindMatch(third!, 1, matchesByPage, allRead), first);
  assert.deepEqual(adjacentFindMatch(first, -1, matchesByPage, allRead), third);

  // Page 3 is still unread, so what follows page 1's last match is not known yet.
  const partlyRead = new Uint8Array([1, 1, 1, 0, 1, 1]);
  assert.equal(adjacentFindMatch(second!, 1, matchesByPage, partlyRead), null);

  const only = new Map([[2, new Int32Array([0, 1])]]);
  const onlyMatch = { matchIndex: 0, pageIndex: 2 };
  assert.deepEqual(adjacentFindMatch(onlyMatch, 1, only, allRead), onlyMatch);
});

test("a search starts from the first match at or after where the reader is", () => {
  const matches = new Int32Array([0, 3, 10, 13, 20, 23]);
  assert.equal(firstMatchFrom(matches, 0), 0);
  assert.equal(firstMatchFrom(matches, 10), 1);
  assert.equal(firstMatchFrom(matches, 11), 2);
  assert.equal(firstMatchFrom(matches, 21), -1);
});

// The cases above hand-build the items; this one checks pdf.js really does mark line ends the way they assume.
test("pdf.js's own items for a hyphenated line are found whole", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 300]);
  page.drawText("Searching a long docu-", { font, size: 12, x: 40, y: 240 });
  page.drawText("ment should feel instant.", { font, size: 12, x: 40, y: 224 });
  const loadingTask = getDocument({
    data: await pdf.save(),
    disableFontFace: true,
    useSystemFonts: false,
  });

  try {
    const doc = await loadingTask.promise;
    const content = await (
      await doc.getPage(1)
    ).getTextContent({
      disableNormalization: true,
      includeMarkedContent: true,
    });
    const original = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("");
    const matches = findPageMatches(
      buildPageFindText(content.items),
      compileFindQuery("Document should")!,
    );
    assert.equal(original.slice(matches[0], matches[1]), "docu-ment should");
  } finally {
    await loadingTask.destroy();
  }
});

function installPdfJsGlobals() {
  class FakeDOMMatrix {}
  class FakeImageData {}
  class FakePath2D {}
  const globals = globalThis as {
    DOMMatrix?: unknown;
    ImageData?: unknown;
    Path2D?: unknown;
  };
  globals.DOMMatrix ??= FakeDOMMatrix;
  globals.ImageData ??= FakeImageData;
  globals.Path2D ??= FakePath2D;
}
