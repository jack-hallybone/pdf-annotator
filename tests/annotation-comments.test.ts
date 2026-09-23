import assert from "node:assert/strict";
import test from "node:test";
import { PDFBool, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import {
  MAX_ANNOTATION_COMMENT_LENGTH,
  normalizeAnnotationComment,
  withAnnotationBookmark,
  withAnnotationComment,
} from "../src/pdfdocumenteditor/annotationComments";
import { ANNOTATION_BOOKMARK_KEY } from "../src/pdfdocumenteditor/annotationBookmarkKey";
import { writePdfAnnotations } from "../src/pdfdocumenteditor/pdfWriter";
import { createWorkSignature } from "../src/pdfdocumenteditor/annotationState";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import { loadTestPdf } from "./pdfTestUtils";

// A comment is a reader's own text on its way into a PDF string, and the star
// beside it is a private key in the same dictionary, so both are tested against
// a file read structurally at the pdf-lib level.

function highlight(
  overrides: Partial<Extract<PdfAnnotation, { kind: "textHighlight" }>> = {},
) {
  return {
    color: [1, 0.9, 0.2],
    comment: "",
    id: "comment-test-highlight",
    kind: "textHighlight",
    opacity: 0.4,
    pageIndex: 0,
    quadPoints: [[72, 720, 180, 720, 72, 704, 180, 704]],
    rects: [{ x1: 72, x2: 180, y1: 704, y2: 720 }],
    ...overrides,
  } as PdfAnnotation;
}

async function blankPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]);
  return pdfDoc.save({ useObjectStreams: false });
}

async function onlyHighlightDict(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const annots = pdfDoc.getPage(0).node.Annots();
  assert.ok(annots);
  const dicts: PDFDict[] = [];
  for (let index = 0; index < annots.size(); index += 1) {
    const dict = annots.lookupMaybe(index, PDFDict);
    if (
      dict?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ===
      "Highlight"
    ) {
      dicts.push(dict);
    }
  }
  assert.equal(dicts.length, 1);
  return dicts[0];
}

function contentsText(dict: PDFDict) {
  const value = dict.get(PDFName.of("Contents"));
  if (!value) {
    return null;
  }
  const decode = (value as { decodeText?: () => string }).decodeText;
  return typeof decode === "function" ? decode.call(value) : null;
}

// A comment goes into a PDF literal string and pdf-lib's PDFString.of() escapes
// none of "(", ")" or "\", so a note as ordinary as ":)" would close the literal
// early were it not for pdfTextString's hex fallback.
test("a hostile comment survives the write intact and leaves a parsable PDF", async () => {
  const nasty =
    "close ) open ( backslash \\ null-ish \\u0007 caf\\u00e9 \\u2603 " +
    "\r\n second line";
  const output = await writePdfAnnotations(await blankPdf(), [
    highlight({ comment: nasty }),
  ]);

  const dict = await onlyHighlightDict(output);
  assert.equal(contentsText(dict), normalizeAnnotationComment(nasty));
  assert.match(contentsText(dict) ?? "", /close \) open \( backslash \\/);
  assert.equal(contentsText(dict)?.includes("\u0007"), false);
  assert.equal(contentsText(dict)?.includes("\n"), true);
});

// An unbounded /Contents: a string out of an untrusted PDF has no length limit
// at all, and would be re-encoded on every save and re-read on every open.
test("a comment is bounded before it reaches the file", async () => {
  const long = "x".repeat(MAX_ANNOTATION_COMMENT_LENGTH * 3);
  const output = await writePdfAnnotations(await blankPdf(), [
    highlight({ comment: long }),
  ]);

  const written = contentsText(await onlyHighlightDict(output));
  assert.equal(written?.length, MAX_ANNOTATION_COMMENT_LENGTH);
});

test("clearing a comment removes /Contents rather than leaving the old note", async () => {
  const withComment = await writePdfAnnotations(await blankPdf(), [
    highlight({ comment: "first thoughts" }),
  ]);
  assert.equal(
    contentsText(await onlyHighlightDict(withComment)),
    "first thoughts",
  );

  const cleared = await writePdfAnnotations(
    withComment,
    [highlight({ comment: "" })],
    {
      replaceAnnotationSourceIds: ["comment-test-highlight"],
      replacePageIndexes: [0],
    },
  );

  assert.equal(contentsText(await onlyHighlightDict(cleared)), null);
});

test("unstarring removes the private key rather than leaving it true", async () => {
  const starred = await writePdfAnnotations(await blankPdf(), [
    highlight({ bookmarked: true }),
  ]);
  const starredDict = await onlyHighlightDict(starred);
  assert.equal(
    starredDict
      .lookupMaybe(PDFName.of(ANNOTATION_BOOKMARK_KEY), PDFBool)
      ?.asBoolean(),
    true,
  );

  const unstarred = await writePdfAnnotations(
    starred,
    [highlight({ bookmarked: undefined })],
    {
      replaceAnnotationSourceIds: ["comment-test-highlight"],
      replacePageIndexes: [0],
    },
  );

  assert.equal(
    (await onlyHighlightDict(unstarred)).get(
      PDFName.of(ANNOTATION_BOOKMARK_KEY),
    ),
    undefined,
  );
});

test("starring an annotation changes the work signature", () => {
  const plain = highlight();
  const starred = withAnnotationBookmark(plain, true);
  assert.notEqual(
    createWorkSignature("f", [plain]),
    createWorkSignature("f", [starred]),
  );
  assert.equal(
    createWorkSignature("f", [plain]),
    createWorkSignature("f", [withAnnotationBookmark(starred, false)]),
  );
});

test("the text an annotation covers is not part of the work signature", () => {
  const plain = highlight();
  const withText = highlight({ coveredText: "the page says this" });
  assert.equal(
    createWorkSignature("f", [plain]),
    createWorkSignature("f", [withText]),
  );
});

test("a comment on free text is its own visible text, not a second field", () => {
  const note = {
    color: [1, 0.9, 0.2],
    id: "note-1",
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 10, x2: 30, y1: 10, y2: 30 },
    text: "original",
  } as PdfAnnotation;

  const edited = withAnnotationComment(note, "  replaced  ");
  assert.equal(edited.kind === "stickyNote" && edited.text, "replaced");
});
