import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationColorCounts,
  annotationListRows,
  filterAnnotationRows,
  prunedAnnotationFilter,
  toggleColorFilter,
} from "../src/tabbedapp/annotationList";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";

// The annotations panel's data, away from the browser: what order the list is
// in, which rows a filter keeps, and which swatches the filter row offers.

function highlight(
  id: string,
  pageIndex: number,
  top: number,
  left: number,
  color: [number, number, number],
  extra: Partial<Extract<PdfAnnotation, { kind: "textHighlight" }>> = {},
): PdfAnnotation {
  return {
    color,
    comment: "",
    id,
    kind: "textHighlight",
    opacity: 0.4,
    pageIndex,
    quadPoints: [
      [left, top, left + 80, top, left, top - 12, left + 80, top - 12],
    ],
    rects: [{ x1: left, x2: left + 80, y1: top - 12, y2: top }],
    ...extra,
  };
}

const YELLOW: [number, number, number] = [1, 0.9, 0.2];
const GREEN: [number, number, number] = [0.2, 0.7, 0.3];

// The order a file stores annotations in is the order the producing tool wrote
// them, so a reader working down a page gets a list that jumps around it, and
// PDF y grows upward.
test("rows run by page, then down the page, then across it", () => {
  const byPage = new Map<number, PdfAnnotation[]>([
    [
      1,
      [
        highlight("p1-low", 1, 200, 72, YELLOW),
        highlight("p1-high", 1, 700, 72, YELLOW),
      ],
    ],
    [
      0,
      [
        highlight("p0-right", 0, 500, 300, YELLOW),
        highlight("p0-left", 0, 500, 72, YELLOW),
        highlight("p0-top", 0, 740, 72, YELLOW),
      ],
    ],
  ]);

  assert.deepEqual(
    annotationListRows(byPage).map((row) => row.id),
    ["p0-top", "p0-left", "p0-right", "p1-high", "p1-low"],
  );
});

test("swatches are the colours actually in the document, most used first", () => {
  const rows = annotationListRows(
    new Map([
      [
        0,
        [
          highlight("a", 0, 700, 72, YELLOW),
          highlight("b", 0, 600, 72, GREEN),
          highlight("c", 0, 500, 72, YELLOW),
        ],
      ],
    ]),
  );

  assert.deepEqual(
    annotationColorCounts(rows).map(({ colorKey, count }) => [colorKey, count]),
    [
      ["#ffe633", 2],
      ["#33b34d", 1],
    ],
  );
});

test("colour and star filters narrow the list, and no colours means every colour", () => {
  const rows = annotationListRows(
    new Map([
      [
        0,
        [
          highlight("a", 0, 700, 72, YELLOW, { bookmarked: true }),
          highlight("b", 0, 600, 72, GREEN),
          highlight("c", 0, 500, 72, YELLOW),
        ],
      ],
    ]),
  );

  assert.equal(
    filterAnnotationRows(rows, { bookmarkedOnly: false, colorKeys: [] }).length,
    3,
  );
  assert.deepEqual(
    filterAnnotationRows(rows, {
      bookmarkedOnly: false,
      colorKeys: ["#ffe633"],
    }).map((row) => row.id),
    ["a", "c"],
  );
  assert.deepEqual(
    filterAnnotationRows(rows, { bookmarkedOnly: true, colorKeys: [] }).map(
      (row) => row.id,
    ),
    ["a"],
  );
  // A star is a flag on an annotation, so it composes with the colour filter
  // instead of being a parallel kind that could not be filtered beside anything.
  assert.deepEqual(
    filterAnnotationRows(rows, {
      bookmarkedOnly: true,
      colorKeys: ["#33b34d"],
    }),
    [],
  );
});

test("toggling a swatch adds it and toggling again removes it", () => {
  const empty = { bookmarkedOnly: false, colorKeys: [] };
  const one = toggleColorFilter(empty, "#ffe633");
  assert.deepEqual(one.colorKeys, ["#ffe633"]);
  assert.deepEqual(toggleColorFilter(one, "#ffe633").colorKeys, []);
});

// Filtering to green and then deleting the last green mark takes the swatch with
// it, leaving an empty list and no control to switch the filter back off.
test("a filter for a colour no longer in the document is dropped", () => {
  const rows = annotationListRows(
    new Map([[0, [highlight("a", 0, 700, 72, YELLOW)]]]),
  );
  const pruned = prunedAnnotationFilter(
    { bookmarkedOnly: false, colorKeys: ["#33b34d", "#ffe633"] },
    rows,
  );

  assert.deepEqual(pruned.colorKeys, ["#ffe633"]);
  assert.equal(filterAnnotationRows(rows, pruned).length, 1);
});

test("an image stamp has no colour, and a colour filter excludes it", () => {
  const stamp: PdfAnnotation = {
    comment: "",
    heightPx: 10,
    id: "stamp",
    imageData: "",
    kind: "imageStamp",
    mimeType: "image/png",
    pageIndex: 0,
    rect: { x1: 10, x2: 60, y1: 10, y2: 60 },
    widthPx: 10,
  };
  const rows = annotationListRows(
    new Map([[0, [stamp, highlight("a", 0, 700, 72, YELLOW)]]]),
  );

  assert.equal(rows.find((row) => row.id === "stamp")?.colorKey, "");
  assert.equal(annotationColorCounts(rows).length, 1);
  assert.deepEqual(
    filterAnnotationRows(rows, {
      bookmarkedOnly: false,
      colorKeys: ["#ffe633"],
    }).map((row) => row.id),
    ["a"],
  );
});

// /Contents used to hold the text an annotation covers, and a comment shown in
// the quote column would mean a reader's own note reading as page text.
test("the comment and the covered text stay separate", () => {
  const rows = annotationListRows(
    new Map([
      [
        0,
        [
          highlight("a", 0, 700, 72, YELLOW, {
            comment: "check this claim",
            coveredText: "the page said something",
          }),
        ],
      ],
    ]),
  );

  assert.equal(rows[0].quote, "the page said something");
  assert.equal(rows[0].comment, "check this claim");
  assert.equal(rows[0].commentable, true);
});
