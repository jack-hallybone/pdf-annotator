import assert from "node:assert/strict";
import { test } from "node:test";
import { useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import type {
  PageViewport,
  PdfAnnotation,
  PdfPoint,
  ToolSettings,
} from "../src/pdfdocumenteditor/types";
import "./rendererAssetStubs";

// The hook reaches pdfRender through inkRendering, so this import has to be
// dynamic: it must run after the stubs the side-effect import above registers.
const { useEraserGesture } =
  await import("../src/pdfdocumenteditor/useEraserGesture");

type EraseChanges = {
  deleteIds: string[];
  pathUpdates: { annotationId: string; paths: PdfPoint[][] }[];
};

// An identity viewport: PDF and viewport coordinates coincide, so the
// drag-distance threshold below is 5 PDF units, matching the 5px it is defined as.
const viewport = {
  convertToPdfPoint: (x: number, y: number) => [x, y],
  userUnit: 1,
} as unknown as PageViewport;

const toolSettings = { eraserWidth: 16 } as unknown as ToolSettings;

function inkAnnotation(
  id: string,
  paths: PdfPoint[][],
  kind: "draw" | "freehandHighlight" = "draw",
): PdfAnnotation {
  return {
    id,
    kind,
    pageIndex: 0,
    paths,
    color: [0, 0, 0],
    opacity: 1,
    width: 2,
    comment: "",
  } as PdfAnnotation;
}

function noteAnnotation(id: string): PdfAnnotation {
  return {
    id,
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 0, y1: 0, x2: 20, y2: 20 },
    text: "",
    color: [1, 1, 0],
  } as PdfAnnotation;
}

const LINE = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
];

type HarnessOptions = {
  annotations?: PdfAnnotation[];
  canvasInkAnnotations?: PdfAnnotation[];
  onEraseAnnotations?: (changes: EraseChanges) => void;
  readOnly?: boolean;
  showSynchronizedAnnotations?: boolean;
};

// Canvases are never attached, so every paint path bails at its own null-canvas
// guard: what these pin down is the gesture state machine and its batching.
function renderEraser(options: HarnessOptions = {}) {
  const annotations = options.annotations ?? [];
  return renderHook(
    (props: HarnessOptions) => {
      const prepaintedInkAnnotationIdsRef = useRef<Set<string>>(new Set());
      const suppressNextContextMenuRef = useRef(false);
      const api = useEraserGesture({
        annotations: props.annotations ?? annotations,
        canvasInkAnnotations:
          props.canvasInkAnnotations ??
          (props.annotations ?? annotations).filter(
            (annotation) =>
              annotation.kind === "draw" ||
              annotation.kind === "freehandHighlight",
          ),
        displaySize: { height: 800, width: 600 },
        highlightInkCanvasRef: { current: null },
        inkCanvasRef: { current: null },
        onEraseAnnotations: props.onEraseAnnotations ?? (() => undefined),
        prepaintedInkAnnotationIdsRef,
        previewColor: () => "rgb(0, 0, 0)",
        readOnly: props.readOnly ?? false,
        scale: 1,
        showSynchronizedAnnotations: props.showSynchronizedAnnotations ?? false,
        suppressNextContextMenuRef,
        toolSettings,
        viewport,
      });
      return { api, prepaintedInkAnnotationIdsRef, suppressNextContextMenuRef };
    },
    { initialProps: options },
  );
}

test("isErasing tracks the gesture lifetime", () => {
  const { result } = renderEraser();
  assert.equal(result.current.api.isErasing(), false);
  act(() =>
    result.current.api.begin(
      { x: 0, y: 0 },
      {
        requireMovement: false,
        scope: "all",
      },
    ),
  );
  assert.equal(result.current.api.isErasing(), true);
  act(() => result.current.api.end());
  assert.equal(result.current.api.isErasing(), false);
});

test("a non-ink hit commits immediately, without waiting for pointer-up", () => {
  const changes: EraseChanges[] = [];
  const { result } = renderEraser({
    annotations: [noteAnnotation("note")],
    onEraseAnnotations: (change) => changes.push(change),
  });

  act(() =>
    result.current.api.begin(
      { x: 10, y: 10 },
      {
        requireMovement: false,
        scope: "all",
      },
    ),
  );

  assert.deepEqual(changes, [{ deleteIds: ["note"], pathUpdates: [] }]);
});

test("ink deletions are batched and committed once, at gesture end", () => {
  const changes: EraseChanges[] = [];
  const { result } = renderEraser({
    annotations: [inkAnnotation("ink", [LINE])],
    onEraseAnnotations: (change) => changes.push(change),
  });

  act(() =>
    result.current.api.begin(
      { x: 50, y: 0 },
      {
        requireMovement: false,
        scope: "all",
      },
    ),
  );
  act(() => result.current.api.appendPoints([{ x: 60, y: 0 }]));
  assert.deepEqual(changes, []);

  act(() => result.current.api.end());
  assert.deepEqual(changes, [{ deleteIds: ["ink"], pathUpdates: [] }]);
});

test("erasing part of a stroke reports remaining paths, not a delete", () => {
  const changes: EraseChanges[] = [];
  const near = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ];
  const far = [
    { x: 100, y: 0 },
    { x: 110, y: 0 },
  ];
  const { result } = renderEraser({
    annotations: [inkAnnotation("ink", [near, far])],
    onEraseAnnotations: (change) => changes.push(change),
  });

  act(() =>
    result.current.api.begin(
      { x: 5, y: 0 },
      {
        requireMovement: false,
        scope: "all",
      },
    ),
  );
  act(() => result.current.api.end());

  assert.deepEqual(changes, [
    { deleteIds: [], pathUpdates: [{ annotationId: "ink", paths: [far] }] },
  ]);
});

test("requireMovement holds the erase until the drag passes the threshold", () => {
  const changes: EraseChanges[] = [];
  const { result } = renderEraser({
    annotations: [noteAnnotation("note")],
    onEraseAnnotations: (change) => changes.push(change),
  });

  act(() =>
    result.current.api.begin(
      { x: 10, y: 10 },
      {
        requireMovement: true,
        scope: "all",
      },
    ),
  );
  assert.deepEqual(changes, []);
  assert.equal(result.current.suppressNextContextMenuRef.current, false);

  act(() => result.current.api.appendPoints([{ x: 12, y: 10 }]));
  assert.deepEqual(changes, []);
  assert.equal(result.current.suppressNextContextMenuRef.current, false);

  act(() => result.current.api.appendPoints([{ x: 18, y: 10 }]));
  assert.deepEqual(changes, [{ deleteIds: ["note"], pathUpdates: [] }]);
  assert.equal(result.current.suppressNextContextMenuRef.current, true);
});

test("a scoped gesture ignores annotations outside its scope", () => {
  const changes: EraseChanges[] = [];
  const { result } = renderEraser({
    annotations: [inkAnnotation("highlight", [LINE], "freehandHighlight")],
    onEraseAnnotations: (change) => changes.push(change),
  });

  act(() =>
    result.current.api.begin(
      { x: 50, y: 0 },
      {
        requireMovement: false,
        scope: "draw",
      },
    ),
  );
  act(() => result.current.api.end());
  assert.deepEqual(changes, []);
});

test("readOnly erases nothing", () => {
  const changes: EraseChanges[] = [];
  const { result } = renderEraser({
    annotations: [noteAnnotation("note"), inkAnnotation("ink", [LINE])],
    onEraseAnnotations: (change) => changes.push(change),
    readOnly: true,
  });

  act(() =>
    result.current.api.begin(
      { x: 10, y: 10 },
      {
        requireMovement: false,
        scope: "all",
      },
    ),
  );
  act(() => result.current.api.appendPoints([{ x: 50, y: 0 }]));
  act(() => result.current.api.end());
  assert.deepEqual(changes, []);
});

test("a second gesture starts from a clean slate", () => {
  const changes: EraseChanges[] = [];
  const { result } = renderEraser({
    annotations: [inkAnnotation("ink", [LINE])],
    onEraseAnnotations: (change) => changes.push(change),
  });

  const eraseThroughIt = () => {
    act(() =>
      result.current.api.begin(
        { x: 50, y: 0 },
        {
          requireMovement: false,
          scope: "all",
        },
      ),
    );
    act(() => result.current.api.end());
  };

  eraseThroughIt();
  eraseThroughIt();
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1], { deleteIds: ["ink"], pathUpdates: [] });
});

test("findCanvasBackedInkAnnotationAtPoint returns the topmost hit", () => {
  const { result } = renderEraser({
    annotations: [
      inkAnnotation("under", [LINE]),
      inkAnnotation("over", [LINE]),
    ],
  });

  assert.equal(
    result.current.api.findCanvasBackedInkAnnotationAtPoint({ x: 50, y: 0 })
      ?.id,
    "over",
  );
  assert.equal(
    result.current.api.findCanvasBackedInkAnnotationAtPoint({ x: 50, y: 400 }),
    null,
  );
});

test("hit testing walks canvasInkAnnotations, not the page annotations", () => {
  const ink = inkAnnotation("selected-ink", [LINE]);
  const { result } = renderEraser({
    annotations: [ink],
    canvasInkAnnotations: [],
  });

  assert.equal(
    result.current.api.findCanvasBackedInkAnnotationAtPoint({ x: 50, y: 0 }),
    null,
  );
});

test("prepainting marks the annotation so the ink layer skips repainting it", () => {
  const annotation = inkAnnotation("ink", [LINE]);
  const { result } = renderEraser({ showSynchronizedAnnotations: true });

  act(() => result.current.api.prepaintCommittedInkAnnotation(annotation));
  assert.deepEqual(
    [...result.current.prepaintedInkAnnotationIdsRef.current],
    ["ink"],
  );

  act(() =>
    result.current.api.prepaintCommittedInkAnnotation(noteAnnotation("note")),
  );
  assert.deepEqual(
    [...result.current.prepaintedInkAnnotationIdsRef.current],
    ["ink"],
  );
});

test("unmounting mid-gesture flushes the queued erases to the newest handler", () => {
  const first: EraseChanges[] = [];
  const second: EraseChanges[] = [];
  const options: HarnessOptions = {
    annotations: [inkAnnotation("ink", [LINE])],
    onEraseAnnotations: (change) => first.push(change),
  };
  const { result, rerender, unmount } = renderEraser(options);

  act(() =>
    result.current.api.begin(
      { x: 50, y: 0 },
      {
        requireMovement: false,
        scope: "all",
      },
    ),
  );
  assert.deepEqual(first, []);

  // The cleanup effect never re-subscribes, so without a mirror it would hold the
  // first render's flush and send the queued erase to `first`.
  rerender({
    ...options,
    onEraseAnnotations: (change: EraseChanges) => second.push(change),
  });
  unmount();

  assert.deepEqual(first, []);
  assert.deepEqual(second, [{ deleteIds: ["ink"], pathUpdates: [] }]);
});
