import assert from "node:assert/strict";
import { test } from "node:test";
import { fireEvent, render } from "@testing-library/react";
import "./rendererAssetStubs";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";

// The panel reads one constant from the document editor's barrel, which pulls in a stylesheet the Node runner cannot load; rendererAssetStubs answers that, and its hooks are only registered once this module's body runs.
const { AnnotationsPanel } =
  await import("../src/tabbedapp/components/AnnotationsPanel");
const { EMPTY_ANNOTATION_FILTER, annotationListRows } =
  await import("../src/tabbedapp/annotationList");
type AnnotationListFilter =
  import("../src/tabbedapp/annotationList").AnnotationListFilter;
type AnnotationListRow =
  import("../src/tabbedapp/annotationList").AnnotationListRow;

// A sticky note's own text is unbounded in the model, so the bound is on the render and is asserted through the real panel, because a panel that painted the annotation's own text would leave `annotationListRows` perfectly correct and unread.
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

// What the list shows is what is copied: a row a filter hides stays out of the copy, and the order is the list's, by page.
test("Copy as Markdown hands over the rows the list shows, in its order", () => {
  const rows = annotationListRows(
    new Map([
      [1, [highlight("p2-yellow", 1, 700, YELLOW)]],
      [
        0,
        [
          highlight("p1-green", 0, 700, GREEN),
          highlight("p1-yellow", 0, 600, YELLOW),
        ],
      ],
    ]),
  );
  const copied: string[][] = [];
  const { getByRole } = render(
    <Panel
      filter={{ bookmarkedOnly: false, colorKeys: ["#ffe633"] }}
      onCopyMarkdown={(visible) => copied.push(visible.map((row) => row.id))}
      rows={rows}
    />,
  );

  fireEvent.click(getByRole("button", { name: "Copy as Markdown" }));

  assert.deepEqual(copied, [["p1-yellow", "p2-yellow"]]);
});

// Until every page has been read the list can be short, and a copy of it would quietly miss marks.
test("Copy as Markdown waits until every page's annotations are in", () => {
  const rows = annotationListRows(
    new Map([[0, [highlight("a", 0, 700, YELLOW)]]]),
  );
  const { getByRole } = render(<Panel complete={false} rows={rows} />);

  const button = getByRole("button", { name: "Copy as Markdown" });
  assert.ok(button instanceof HTMLButtonElement);
  assert.equal(button.disabled, true);
});

function Panel({
  complete = true,
  filter = EMPTY_ANNOTATION_FILTER,
  onCopyMarkdown = () => {},
  rows,
}: {
  complete?: boolean;
  filter?: AnnotationListFilter;
  onCopyMarkdown?: (rows: AnnotationListRow[]) => void;
  rows: AnnotationListRow[];
}) {
  return (
    <AnnotationsPanel
      complete={complete}
      filter={filter}
      onChangeFilter={() => {}}
      onCopyMarkdown={onCopyMarkdown}
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

const YELLOW: [number, number, number] = [1, 0.9, 0.2];
const GREEN: [number, number, number] = [0.2, 0.7, 0.3];

function highlight(
  id: string,
  pageIndex: number,
  top: number,
  color: [number, number, number],
): PdfAnnotation {
  return {
    color,
    comment: "",
    coveredText: id,
    id,
    kind: "textHighlight",
    opacity: 0.4,
    pageIndex,
    quadPoints: [[72, top, 152, top, 72, top - 12, 152, top - 12]],
    rects: [{ x1: 72, x2: 152, y1: top - 12, y2: top }],
  };
}
