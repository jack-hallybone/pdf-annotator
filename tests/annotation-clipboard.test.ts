import assert from "node:assert/strict";
import test from "node:test";
import {
  hasAnnotationClipboard,
  readAnnotationPaste,
  writeAnnotationClipboard,
} from "../src/pdfdocumenteditor/annotationClipboard";
import { annotationBounds } from "../src/pdfdocumenteditor/annotationGeometry";
import type { PdfAnnotation, PdfRect } from "../src/pdfdocumenteditor/types";

// A paste mints an annotation rather than making a second reference to one:
// `sourceId` names one dictionary in the file, so two annotations carrying the
// same one means an edit landing on two objects, or a removal taking the copy
// with the original.

const A4: PdfRect = { x1: 0, x2: 595, y1: 0, y2: 842 };
const POSTCARD: PdfRect = { x1: 0, x2: 288, y1: 0, y2: 432 };

test("a pasted annotation is a new annotation, not a second reference to one", () => {
  const original = highlightAt({ x1: 100, x2: 200, y1: 700, y2: 720 });
  const token = writeAnnotationClipboard([original]);

  const [pasted] = readAnnotationPaste(token, {
    pageBounds: A4,
    pageIndex: 3,
  });

  assert.notEqual(pasted.id, original.id);
  assert.equal(pasted.sourceId, undefined);
  assert.equal(
    pasted.kind === "textHighlight" && pasted.coveredText,
    undefined,
  );
  assert.equal(pasted.pageIndex, 3);
  assert.equal(original.sourceId, "direct:0:0");
  assert.equal(original.pageIndex, 0);
});

test("a pasted group moves as one and keeps every property but its identity", () => {
  const first = highlightAt({ x1: 100, x2: 200, y1: 700, y2: 720 });
  const second = highlightAt({ x1: 260, x2: 300, y1: 500, y2: 540 });
  const token = writeAnnotationClipboard([first, second]);

  const pasted = readAnnotationPaste(token, { pageBounds: A4, pageIndex: 0 });

  const deltas = pasted.map((annotation, index) => {
    const from = annotationBounds([first, second][index]);
    const to = annotationBounds(annotation);
    return { x: to.x1 - from.x1, y: to.y1 - from.y1 };
  });
  assert.deepEqual(deltas[0], deltas[1]);
  assert.notDeepEqual(deltas[0], { x: 0, y: 0 });
  assert.deepEqual(
    pasted.map((annotation) => [
      annotation.kind,
      annotation.kind === "textHighlight" ? annotation.comment : null,
    ]),
    [
      ["textHighlight", "keep me"],
      ["textHighlight", "keep me"],
    ],
  );
});

test("a paste lands inside the target page, however small it is", () => {
  const wide = highlightAt({ x1: 400, x2: 580, y1: 20, y2: 60 });
  const token = writeAnnotationClipboard([wide]);

  const [pasted] = readAnnotationPaste(token, {
    pageBounds: POSTCARD,
    pageIndex: 0,
  });

  const bounds = annotationBounds(pasted);
  assert.ok(
    bounds.x1 >= POSTCARD.x1 &&
      bounds.x2 <= POSTCARD.x2 &&
      bounds.y1 >= POSTCARD.y1 &&
      bounds.y2 <= POSTCARD.y2,
    `pasted bounds ${JSON.stringify(bounds)} left the page`,
  );
});

test("pasting one clip repeatedly stacks nothing", () => {
  const token = writeAnnotationClipboard([
    highlightAt({ x1: 100, x2: 200, y1: 700, y2: 720 }),
  ]);

  const positions = [0, 1, 2].map(
    () =>
      annotationBounds(
        readAnnotationPaste(token, { pageBounds: A4, pageIndex: 0 })[0],
      ).x1,
  );

  assert.equal(new Set(positions).size, positions.length);
});

test("a token this window did not write names nothing", () => {
  writeAnnotationClipboard([
    highlightAt({ x1: 100, x2: 200, y1: 700, y2: 720 }),
  ]);

  assert.equal(hasAnnotationClipboard(crypto.randomUUID()), false);
  assert.deepEqual(
    readAnnotationPaste(crypto.randomUUID(), {
      pageBounds: A4,
      pageIndex: 0,
    }),
    [],
  );
  assert.equal(hasAnnotationClipboard(""), false);
});

function highlightAt(rect: PdfRect): PdfAnnotation {
  return {
    color: [1, 0.9, 0.2],
    comment: "keep me",
    coveredText: "the words underneath",
    id: crypto.randomUUID(),
    kind: "textHighlight",
    opacity: 0.4,
    pageIndex: 0,
    quadPoints: [
      [rect.x1, rect.y2, rect.x2, rect.y2, rect.x1, rect.y1, rect.x2, rect.y1],
    ],
    rects: [rect],
    sourceId: "direct:0:0",
  };
}
