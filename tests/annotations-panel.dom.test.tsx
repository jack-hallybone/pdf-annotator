import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "@testing-library/react";
import "./rendererAssetStubs";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";

// The panel reads one constant from the document editor's barrel, which pulls in a
// stylesheet the Node runner cannot load; rendererAssetStubs answers that, and
// its hooks are only registered once this module's body runs.
const { AnnotationsPanel } =
  await import("../src/tabbedapp/components/AnnotationsPanel");
const { EMPTY_ANNOTATION_FILTER, annotationListRows } =
  await import("../src/tabbedapp/annotationList");

// A sticky note's own text is unbounded in the model, so the bound is on the
// render and is asserted through the real panel, because a panel that painted
// the annotation's own text would leave `annotationListRows` perfectly correct
// and unread.
test("a note far longer than a row can show is not put into the DOM whole", () => {
  const long = `start ${"x".repeat(100_000)} end`;
  const rows = annotationListRows(new Map([[0, [note("long", long)]]]));
  const { container } = render(<Panel rows={rows} />);

  const quote = container.querySelector(".annotation-row-quote");
  const painted = quote?.textContent ?? "";

  assert.ok(painted.length > 0, "the row painted nothing at all");
  assert.ok(
    painted.length < long.length,
    `the row painted all ${long.length} characters`,
  );
  assert.equal(painted, long.slice(0, painted.length));
  assert.ok(
    (container.textContent ?? "").length < long.length,
    "the note reached the DOM somewhere other than the quote",
  );
});

test("rendering the row leaves the annotation's own text alone", () => {
  const long = "y".repeat(100_000);
  const annotation = note("long", long);
  render(<Panel rows={annotationListRows(new Map([[0, [annotation]]]))} />);

  assert.equal(annotation.text, long);
});

function Panel({ rows }: { rows: ReturnType<typeof annotationListRows> }) {
  return (
    <AnnotationsPanel
      complete
      filter={EMPTY_ANNOTATION_FILTER}
      onChangeFilter={() => {}}
      onRevealAnnotation={() => {}}
      onSetBookmarked={() => {}}
      onSetComment={() => {}}
      readOnly={false}
      rows={rows}
      selectedAnnotationIds={[]}
    />
  );
}

function note(
  id: string,
  text: string,
): Extract<PdfAnnotation, { kind: "stickyNote" }> {
  return {
    color: [1, 0.9, 0],
    id,
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 700, y2: 720 },
    text,
  };
}
