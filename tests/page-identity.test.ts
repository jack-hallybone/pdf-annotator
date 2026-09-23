import assert from "node:assert/strict";
import test from "node:test";
import {
  UNCHANGED_PAGE_ORDER,
  composePageMappings,
  pageMappingFor,
  pageOrderChangeOfOperation,
  remapAnnotationsAcrossPageEdit,
  remapPageSetAcrossPageEdit,
  remapRemovedSourcesAcrossPageEdit,
  restatedSourceIdAcrossPages,
} from "../src/pdfdocumenteditor/pageIdentity";
import type { PdfPageMapping } from "../src/pdfdocumenteditor/pageIdentity";
import { remapHistoryAnnotationSources } from "../src/pdfdocumenteditor/historyStack";
import type { WrittenAnnotationSources } from "../src/pdfdocumenteditor/pdfWriter";
import type {
  PdfDocumentEditorHistorySnapshot,
  PdfDocumentEditorHistoryEntry,
} from "../src/pdfdocumenteditor/PdfDocumentEditor";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import type { PdfDocumentEditorViewSnapshot } from "../src/pdfdocumenteditor/viewSnapshot";

// `direct:<page>:<index>` names an annotation dictionary by where it sits, so a
// page edit moves the very thing it names.

function note(id: string, pageIndex: number, sourceId?: string): PdfAnnotation {
  return {
    color: [1, 0.9, 0],
    id,
    kind: "stickyNote",
    pageIndex,
    rect: { x1: 10, x2: 30, y1: 10, y2: 30 },
    sourceId,
    text: id,
  };
}

function sourceIds(annotations: PdfAnnotation[]) {
  return annotations.map((annotation) => [
    annotation.pageIndex,
    annotation.sourceId,
  ]);
}

function pageRow(mapping: PdfPageMapping, pageIndexes: number[]) {
  return {
    backward: pageIndexes.map((pageIndex) => mapping.backward(pageIndex)),
    forward: pageIndexes.map((pageIndex) => mapping.forward(pageIndex)),
  };
}

test("each page-order change maps pages both ways", () => {
  assert.deepEqual(pageRow(UNCHANGED_PAGE_ORDER, [0, 1, 2]), {
    backward: [0, 1, 2],
    forward: [0, 1, 2],
  });

  assert.deepEqual(pageRow(pageMappingFor({ type: "keep" }), [0, 1, 2]), {
    backward: [0, 1, 2],
    forward: [0, 1, 2],
  });

  assert.deepEqual(
    pageRow(
      pageMappingFor({ count: 1, startIndex: 1, type: "remove" }),
      [0, 1, 2, 3],
    ),
    { backward: [0, 2, 3, 4], forward: [0, null, 1, 2] },
  );

  assert.deepEqual(
    pageRow(
      pageMappingFor({ atIndex: 1, count: 2, type: "insert" }),
      [0, 1, 2, 3],
    ),
    { backward: [0, null, null, 1], forward: [0, 3, 4, 5] },
  );

  assert.deepEqual(
    pageRow(pageMappingFor({ indexA: 0, indexB: 1, type: "swap" }), [0, 1, 2]),
    { backward: [1, 0, 2], forward: [1, 0, 2] },
  );
});

test("a stored history operation says what it does to page numbers", () => {
  assert.deepEqual(
    pageOrderChangeOfOperation({
      deltaDegrees: -90,
      pageIndex: 2,
      type: "rotatePage",
    }),
    { type: "keep" },
  );
  assert.deepEqual(
    pageOrderChangeOfOperation({
      atIndex: 1,
      copiedNames: new Map(),
      pageCount: 2,
      pagesBytes: new Uint8Array(),
      type: "insertPages",
    }),
    { atIndex: 1, count: 2, type: "insert" },
  );
  assert.deepEqual(
    pageOrderChangeOfOperation({
      count: 3,
      startIndex: 4,
      type: "removePages",
    }),
    { count: 3, startIndex: 4, type: "remove" },
  );
  assert.deepEqual(
    pageOrderChangeOfOperation({
      direction: -1,
      pageIndex: 3,
      type: "movePage",
    }),
    { indexA: 3, indexB: 2, type: "swap" },
  );
});

test("composing two edits maps through both, and stops at a page neither has", () => {
  const composed = composePageMappings(
    pageMappingFor({ count: 1, startIndex: 0, type: "remove" }),
    pageMappingFor({ atIndex: 0, count: 1, type: "insert" }),
  );

  assert.deepEqual(pageRow(composed, [0, 1, 2]), {
    backward: [null, 1, 2],
    forward: [null, 1, 2],
  });
});

test("only a positional identity moves, and one whose page went cannot be restated", () => {
  const deletePage1 = pageMappingFor({
    count: 1,
    startIndex: 1,
    type: "remove",
  });

  assert.equal(
    restatedSourceIdAcrossPages("direct:2:3", deletePage1),
    "direct:1:3",
  );
  assert.equal(
    restatedSourceIdAcrossPages("direct:1:0", deletePage1),
    "unresolved:shifted:1:0",
  );
  assert.equal(restatedSourceIdAcrossPages("50R", deletePage1), "50R");
  assert.equal(
    restatedSourceIdAcrossPages("a-name-in-the-file", deletePage1),
    "a-name-in-the-file",
  );
  assert.equal(
    restatedSourceIdAcrossPages("unresolved:ambiguous:2:0", deletePage1),
    "unresolved:ambiguous:2:0",
  );
});

test("annotations move with their pages and carry their restated identities", () => {
  const annotations = [
    note("keep", 0, "direct:0:0"),
    note("on-the-deleted-page", 1, "direct:1:0"),
    note("shifted", 2, "direct:2:0"),
    note("app-made", 2),
    note("orphaned-identity", 2, "direct:1:1"),
  ];

  assert.deepEqual(
    sourceIds(
      remapAnnotationsAcrossPageEdit(
        annotations,
        pageMappingFor({ count: 1, startIndex: 1, type: "remove" }),
      ),
    ),
    [
      [0, "direct:0:0"],
      [1, "direct:1:0"],
      [1, undefined],
      [1, "unresolved:shifted:1:1"],
    ],
  );

  assert.deepEqual(
    sourceIds(
      remapAnnotationsAcrossPageEdit(
        annotations,
        pageMappingFor({ atIndex: 1, count: 1, type: "insert" }),
      ),
    ),
    [
      [0, "direct:0:0"],
      [2, "direct:2:0"],
      [3, "direct:3:0"],
      [3, undefined],
      [3, "direct:2:1"],
    ],
  );

  assert.equal(
    remapAnnotationsAcrossPageEdit(annotations, UNCHANGED_PAGE_ORDER),
    annotations,
  );
});

test("a removal whose page went is dropped, not carried forward", () => {
  assert.deepEqual(
    remapRemovedSourcesAcrossPageEdit(
      ["direct:0:0", "direct:1:0", "direct:2:1", "an-app-id"],
      pageMappingFor({ count: 1, startIndex: 1, type: "remove" }),
    ),
    ["direct:0:0", "direct:1:1", "an-app-id"],
  );

  assert.deepEqual(
    remapRemovedSourcesAcrossPageEdit(
      ["direct:1:0"],
      pageMappingFor({ indexA: 1, indexB: 2, type: "swap" }),
    ),
    ["direct:2:0"],
  );
});

test("a page set loses the pages the edit removed", () => {
  assert.deepEqual(
    Array.from(
      remapPageSetAcrossPageEdit(
        new Set([0, 1, 2]),
        pageMappingFor({ count: 1, startIndex: 1, type: "remove" }),
      ),
    ),
    [0, 1],
  );
  assert.deepEqual(
    Array.from(
      remapPageSetAcrossPageEdit(
        new Set([0, 1, 2]),
        pageMappingFor({ atIndex: 1, count: 2, type: "insert" }),
      ),
    ),
    [0, 3, 4],
  );
});

// A structural entry restores the document its own operation produces, so
// reading the writer's report at its numbers hands an undo entry the answer
// meant for a different page.
test("a save reads each history entry in the written file's page numbering", () => {
  const sources: WrittenAnnotationSources = new Map([
    ["direct:0:0", { kind: "moved", sourceId: "direct:0:1" }],
    ["direct:0:1", { kind: "moved", sourceId: "direct:0:0" }],
    ["direct:1:0", { kind: "moved", sourceId: "direct:1:0" }],
  ]);

  const entries: PdfDocumentEditorHistoryEntry[] = [
    {
      annotations: [note("before-the-page-edit", 1, "direct:1:0")],
      kind: "annotations",
    },
    documentEntry({
      annotations: [
        note("was-page-1", 1, "direct:1:0"),
        note("was-page-1-second", 1, "direct:1:1"),
        note("was-page-2", 2, "direct:2:0"),
      ],
      cleanAnnotations: [note("was-page-1", 1, "direct:1:0")],
      operation: {
        atIndex: 0,
        copiedNames: new Map(),
        pageCount: 1,
        pagesBytes: new Uint8Array(),
        type: "insertPages",
      },
      removedAnnotationSourceIds: ["direct:1:1"],
    }),
  ];

  const remapped = remapHistoryAnnotationSources(entries, sources);
  const documentEntryAfter = remapped[1];
  assert.equal(documentEntryAfter.kind, "document");
  assert.deepEqual(sourceIds(documentEntryAfter.snapshot.annotations), [
    [1, "direct:1:1"],
    [1, "direct:1:0"],
    [2, "direct:2:0"],
  ]);
  assert.deepEqual(sourceIds(documentEntryAfter.snapshot.cleanAnnotations), [
    [1, "direct:1:1"],
  ]);
  assert.deepEqual(documentEntryAfter.snapshot.removedAnnotationSourceIds, [
    "direct:1:0",
  ]);

  const annotationEntryAfter = remapped[0];
  assert.equal(annotationEntryAfter.kind, "annotations");
  assert.deepEqual(sourceIds(annotationEntryAfter.annotations), [
    [1, "direct:1:1"],
  ]);
});

test("a save cannot follow a report into a page the entry's document has not got", () => {
  const sources: WrittenAnnotationSources = new Map([
    ["direct:0:0", { kind: "moved", sourceId: "direct:0:0" }],
  ]);
  const entries: PdfDocumentEditorHistoryEntry[] = [
    documentEntry({
      annotations: [
        note("on-the-restored-page", 0, "direct:0:0"),
        note("on-the-written-page", 1, "direct:1:0"),
      ],
      operation: {
        atIndex: 0,
        copiedNames: new Map(),
        pageCount: 1,
        pagesBytes: new Uint8Array(),
        type: "insertPages",
      },
    }),
  ];

  const [remapped] = remapHistoryAnnotationSources(entries, sources);
  assert.equal(remapped.kind, "document");
  assert.deepEqual(sourceIds(remapped.snapshot.annotations), [
    [0, "direct:0:0"],
    [1, "direct:1:0"],
  ]);
});

const STUB_VIEW: PdfDocumentEditorViewSnapshot = {
  activePageIndex: 0,
  scale: 1,
};

function documentEntry(
  snapshot: Partial<PdfDocumentEditorHistorySnapshot> &
    Pick<PdfDocumentEditorHistorySnapshot, "annotations" | "operation">,
): PdfDocumentEditorHistoryEntry {
  return {
    kind: "document",
    snapshot: {
      cleanAnnotations: [],
      cleanSignatureRefreshEnabled: true,
      cleanWorkSignature: "",
      importedAnnotationPageIndexes: [],
      managedAnnotationPageIndexes: [],
      pdfFingerprint: "",
      removedAnnotationSourceIds: [],
      shouldImportAnnotations: true,
      ...snapshot,
    },
    view: STUB_VIEW,
  };
}
