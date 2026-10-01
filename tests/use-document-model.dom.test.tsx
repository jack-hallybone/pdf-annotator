import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { act, waitFor } from "@testing-library/react";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import {
  SECOND_STUB_VIEW,
  STUB_VIEW,
  mountLoadedModel,
  mountRefusedModel,
  onePagePdf,
} from "./documentModelHarness";
import type { PdfMergeFile } from "../src/pdfdocumenteditor/host";
import { UNPROVEN_PAGE_DELETE_NOTICE } from "../src/pdfdocumenteditor/pdfDocumentEditorHelpers";
import { MAX_DOCUMENT_ANNOTATION_TEXT_CHARACTERS } from "../src/pdfdocumenteditor/annotationImport";
import { MAX_PDF_FILE_BYTES } from "../src/pdfdocumenteditor/pdfFile";

// The document owner, mounted on its own with a stub viewport, on the three defects specific to the split: a parked session or undo entry folding the viewport back into the document state, a proxy committed without bumping documentVersion, and a `primaryView()` where an `eachView()` belongs.

// `fileName` is what the window title, the tab strip, the rename dialog's default and every suggested save name are built from, so the character rules belong at this one entry rather than at those four surfaces.
test("a document's name loses the characters that make it read backwards", async () => {
  const { result } = await mountLoadedModel(1, "report\u202Efdp.exe\u061C.pdf");

  assert.equal(result.current.model.fileName, "reportfdp.exe.pdf");
});

test("a name of nothing but invisible characters reads as unnamed", async () => {
  const { result } = await mountLoadedModel(1, "\u202E\u061C\u200B");

  assert.equal(result.current.model.fileName, "document.pdf");
});

test("a parked session carries the viewport beside the document, not inside it", async () => {
  const { result } = await mountLoadedModel();
  const session = result.current.model.createDocumentEditorSession();
  assert.ok(session, "no session was captured for a loaded document");

  assert.deepEqual(session.view, STUB_VIEW);

  const parked = session as Record<string, unknown>;
  for (const field of ["activePageIndex", "scale", "viewPosition"]) {
    assert.equal(
      field in parked,
      false,
      `${field} is one viewport's business and belongs under session.view`,
    );
  }
});

// Its reason was worked out when the file was opened, and a return to the tab is exactly when the wait for page 1 shows.
test("a parked tab comes back without parsing its file again to check it", async () => {
  const parked = await mountLoadedModel();
  const session = parked.result.current.model.createDocumentEditorSession();
  assert.ok(session, "no session was captured for a loaded document");
  assert.equal(session.readOnlyReason, null);
  parked.unmount();

  const load = mock.method(PDFDocument, "load");
  try {
    const { result } = await mountLoadedModel(
      1,
      undefined,
      session.pdfBytes,
      [],
      session,
    );
    assert.equal(result.current.model.readOnlyReason, null);
    assert.equal(load.mock.callCount(), 0);
  } finally {
    load.mock.restore();
  }
});

test("a structural edit is undone through a snapshot with no viewport in it", async () => {
  const { result } = await mountLoadedModel();
  const startingVersion = result.current.model.documentVersion;

  await act(async () => {
    await result.current.model.handleAddPage(0, "after", "blank");
  });
  await waitFor(
    () => {
      assert.equal(result.current.model.pages.length, 2);
    },
    { timeout: 15_000 },
  );

  const entry = result.current.model.undoStack.at(-1);
  assert.equal(entry?.kind, "document", "the page insert recorded no undo");
  if (entry?.kind !== "document") {
    return;
  }

  assert.deepEqual(entry.view, STUB_VIEW);
  const snapshot = entry.snapshot as unknown as Record<string, unknown>;
  for (const field of ["activePageIndex", "viewPosition"]) {
    assert.equal(
      field in snapshot,
      false,
      `${field} is one viewport's business and belongs on the history entry`,
    );
  }

  await act(async () => {
    await result.current.model.undoHistory();
  });
  await waitFor(
    () => {
      assert.equal(result.current.model.pages.length, 1);
    },
    { timeout: 15_000 },
  );

  // The view's residency band re-primes on this counter and on nothing else.
  assert.ok(
    result.current.model.documentVersion >= startingVersion + 2,
    `documentVersion did not advance on a proxy swap (${startingVersion} -> ` +
      `${result.current.model.documentVersion})`,
  );
});

// Nothing stops the document being taken out from under an edit, because the shell releases a document's renderer the moment it leaves view. The merge is the operation a test can drive this through: its host file picker is the one await it can hold open.
test("an edit superseded while it runs commits nothing", async () => {
  const notices: string[] = [];
  const mergeFile: PdfMergeFile = {
    bytes: await onePagePdf(),
    name: "merge.pdf",
  };
  let pickMergeFile: (file: PdfMergeFile) => void = () => {};
  const picked = new Promise<PdfMergeFile>((resolve) => {
    pickMergeFile = resolve;
  });
  const { result } = await mountLoadedModel(
    1,
    undefined,
    undefined,
    notices,
    null,
    () => picked,
  );
  const model = () => result.current.model;
  const undoDepth = model().undoStack.length;

  await act(async () => {
    const merging = model().handleMergePdf();
    // Registered after the merge is already awaiting this same promise, so it runs in the window between the merge's own check and the envelope's.
    void picked.then(() => model().releaseRenderResources());
    pickMergeFile(mergeFile);
    await merging;
  });

  assert.equal(model().pageCount, 0);
  assert.equal(model().pagesRef.current.length, 0);
  assert.equal(model().undoStack.length, undoDepth);
  assert.equal(
    model().pdfDoc === null,
    true,
    "a superseded edit committed a document over the released one",
  );
  assert.deepEqual(notices, []);
});

// A merge source never goes through readPdfFile or the main load path's own annotation-text budget check, so these hold it to the same two safety limits a file opened directly is held to, instead of skipping them.
test("a merge source bigger than the file safety limit is refused before it is merged in", async () => {
  const notices: string[] = [];
  const mergeFile: PdfMergeFile = {
    bytes: new Uint8Array(MAX_PDF_FILE_BYTES + 1),
    name: "huge.pdf",
  };
  const { result } = await mountLoadedModel(
    1,
    undefined,
    undefined,
    notices,
    null,
    () => Promise.resolve(mergeFile),
  );
  const model = () => result.current.model;
  const pageCountBefore = model().pageCount;

  await act(async () => {
    await model().handleMergePdf();
  });

  assert.equal(model().pageCount, pageCountBefore);
  assert.ok(
    notices.some((notice) => notice.includes("safety limit")),
    `expected a safety-limit notice, got: ${JSON.stringify(notices)}`,
  );
});

test("a merge source whose notes and comments are over the character safety limit is refused before it is merged in", async () => {
  const notices: string[] = [];
  const mergeFile: PdfMergeFile = {
    bytes: await hugeAnnotationTextPdf(),
    name: "huge-notes.pdf",
  };
  const { result } = await mountLoadedModel(
    1,
    undefined,
    undefined,
    notices,
    null,
    () => Promise.resolve(mergeFile),
  );
  const model = () => result.current.model;
  const pageCountBefore = model().pageCount;

  await act(async () => {
    await model().handleMergePdf();
  });

  assert.equal(model().pageCount, pageCountBefore);
  assert.ok(
    notices.some((notice) => notice.includes("safety limit")),
    `expected a safety-limit notice, got: ${JSON.stringify(notices)}`,
  );
});

async function hugeAnnotationTextPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  const hugeText = "a".repeat(MAX_DOCUMENT_ANNOTATION_TEXT_CHARACTERS + 1);
  const note = context.obj({
    Contents: PDFString.of(hugeText),
    Rect: [72, 72, 200, 200],
    Subtype: "FreeText",
    Type: "Annot",
  });
  page.node.set(PDFName.of("Annots"), context.obj([note]));
  return pdfDoc.save({ useObjectStreams: false });
}

// Two viewports at the model's own level; tests-e2e/split-view.spec.ts proves the capability end to end.
test("a document operation reaches every attached viewport", async () => {
  const { result } = await mountLoadedModel(2);
  result.current.first.bridge.current.activePageIndexRef.current = 3;
  result.current.second.bridge.current.activePageIndexRef.current = 9;

  await act(async () => {
    await result.current.model.handleAddPage(0, "after", "blank");
  });
  await waitFor(
    () => {
      assert.equal(result.current.model.pageCount, 2);
    },
    { timeout: 15_000 },
  );

  for (const view of [result.current.first, result.current.second] as const) {
    assert.equal(
      view.bridge.current.activePageIndexRef.current,
      1,
      "a viewport was not moved onto the page the edit landed on",
    );
  }
});

test("a parked session carries ONE viewport's position, not one per view", async () => {
  const { result } = await mountLoadedModel(2);
  const session = result.current.model.createDocumentEditorSession();
  assert.ok(session, "no session was captured for a loaded document");

  assert.deepEqual(session.view, STUB_VIEW);
  assert.notDeepEqual(session.view, SECOND_STUB_VIEW);
});

// Which page a description belongs to is settled by the content streams, and a stream the app cannot read leaves that open. `deleted-page-residue.test.ts` owns whether the report is right; this owns whether the app passes it on.
async function unprovableDeletePdf() {
  const pdfDoc = await PDFDocument.create();
  const { context } = pdfDoc;
  const first = pdfDoc.addPage([612, 792]);
  const second = pdfDoc.addPage([612, 792]);
  const font = context.register(
    context.obj({ BaseFont: "Helvetica", Subtype: "Type1", Type: "Font" }),
  );
  const shared = context.register(
    context.flateStream("/P <</MCID 0>> BDC BT ET EMC", {
      BBox: [0, 0, 612, 120],
      StructParents: 7,
      Subtype: "Form",
      Type: "XObject",
    }),
  );
  const resources = context.register(
    context.obj({
      Font: context.obj({ F1: font }),
      XObject: context.obj({ Fm0: shared }),
    }),
  );
  for (const [index, page] of [first, second].entries()) {
    page.node.set(PDFName.of("Resources"), resources);
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
  }
  first.node.set(
    PDFName.of("Contents"),
    context.register(
      PDFRawStream.of(
        context.obj({ Filter: "FlateDecode", Length: 5 }),
        new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
      ),
    ),
  );
  second.node.set(
    PDFName.of("Contents"),
    context.register(context.flateStream("/P <</MCID 0>> BDC BT ET EMC")),
  );

  const figure = context.register(
    context.obj({
      Alt: PDFString.of("a description of the shared drawing"),
      K: [0],
      Pg: first.ref,
      S: "Figure",
      Type: "StructElem",
    }),
  );
  const structRoot = context.register(
    context.obj({
      K: [figure],
      ParentTree: context.register(
        context.obj({
          Nums: [
            0,
            context.obj([]),
            1,
            context.obj([]),
            7,
            context.obj([figure]),
          ],
        }),
      ),
      ParentTreeNextKey: 8,
      Type: "StructTreeRoot",
    }),
  );
  context.lookup(figure, PDFDict).set(PDFName.of("P"), structRoot);
  pdfDoc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  pdfDoc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));

  return pdfDoc.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function twoPlainPagesPdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]);
  pdfDoc.addPage([612, 792]);
  return pdfDoc.save({ useObjectStreams: false });
}

for (const { bytes, name, says } of [
  {
    bytes: unprovableDeletePdf,
    name: "a page whose content cannot be read",
    says: true,
  },
  { bytes: twoPlainPagesPdf, name: "an ordinary page", says: false },
]) {
  test(`deleting ${name} ${says ? "tells the reader" : "says nothing"}`, async () => {
    const notices: string[] = [];
    const { result } = await mountLoadedModel(
      1,
      undefined,
      await bytes(),
      notices,
    );

    await act(async () => {
      await result.current.model.handleDeletePage(0);
    });
    await waitFor(() => {
      assert.equal(result.current.model.pages.length, 1);
    });

    assert.deepEqual(
      notices.filter((notice) => notice === UNPROVEN_PAGE_DELETE_NOTICE),
      says ? [UNPROVEN_PAGE_DELETE_NOTICE] : [],
      notices.join(" | "),
    );
  });
}

// A note's text is the one string here that is never shortened, so nothing else bounds what a document can put into `annotations`. A check that runs after the document is committed has already paid for the memory it refuses, and the sizes are literals, so raising the limit fails here.
async function pdfWithNoteText(characters: number) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const note = pdfDoc.context.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [10, 10, 32, 32],
    F: 4,
    Contents: PDFString.of("n".repeat(characters)),
  });
  page.node.set(
    PDFName.of("Annots"),
    pdfDoc.context.obj([pdfDoc.context.register(note)]),
  );
  return pdfDoc.save({ useObjectStreams: true });
}

test("a file carrying more note text than the limit is refused with nothing of it kept", async () => {
  const { result } = await mountRefusedModel(await pdfWithNoteText(8_000_001));

  assert.match(result.current.model.loadError ?? "", /8 million characters/);
  assert.equal(result.current.model.pdfDoc, null);
  assert.deepEqual(result.current.model.annotations, []);
});

test("a file at the limit opens with its note", async () => {
  const { result } = await mountLoadedModel(
    1,
    "at-the-limit.pdf",
    await pdfWithNoteText(8_000_000),
  );

  await waitFor(() => {
    assert.equal(result.current.model.annotations.length, 1);
  });
  const [note] = result.current.model.annotations;
  assert.equal(note?.kind, "stickyNote");
  assert.equal(note?.kind === "stickyNote" ? note.text.length : 0, 8_000_000);
});

// pdf.js shows the pages and pdf-lib writes them, so where the two list different page objects a note or a page edit lands on another page than the one the reader chose. pdf.js takes a page-tree leaf with no /Type for a page and pdf-lib skips it, which moves every later page along by one.
async function pdfWithUntypedFirstPage({
  claimPdfA = false,
  evenCounts = false,
} = {}) {
  const pdfDoc = await PDFDocument.create();
  for (const width of evenCounts ? [300, 310, 320, 330] : [300, 310, 320]) {
    pdfDoc.addPage([width, 400]);
  }
  pdfDoc.getPage(0).node.delete(PDFName.of("Type"));
  if (evenCounts) {
    // A fourth page past /Count, which pdf-lib alone lists: both count three, and still not one index names the same page to both.
    pdfDoc.catalog.Pages().set(PDFName.of("Count"), PDFNumber.of(3));
  }
  if (claimPdfA) {
    // A reason that on its own offers "Edit a copy".
    pdfDoc.catalog.set(
      PDFName.of("Metadata"),
      pdfDoc.context.register(
        pdfDoc.context.stream(
          '<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1"/>',
          { Subtype: "XML", Type: "Metadata" },
        ),
      ),
    );
  }
  return pdfDoc.save({ useObjectStreams: false });
}

for (const [name, options] of [
  ["whose page lists disagree", {}],
  ["whose page lists disagree though they count alike", { evenCounts: true }],
  ["whose page lists disagree and that claims PDF/A", { claimPdfA: true }],
] as const) {
  test(`a file ${name} opens read-only, with no copy to edit and no page to change`, async () => {
    const bytes = await pdfWithUntypedFirstPage(options);
    const { result } = await mountLoadedModel(1, "pages.pdf", bytes);
    const model = () => result.current.model;
    assert.equal(model().readOnlyReason, "ambiguous page order");
    assert.equal(model().readOnly, true);

    act(() => {
      model().handleEnableEditing();
    });
    await act(async () => {
      await model().handleDeletePage(0);
    });

    assert.equal(model().editingEnabled, false);
    assert.equal(model().readOnly, true);
    assert.equal(model().pdfBytes, bytes);
    assert.equal(model().pageCount, 3);
  });
}

// A parked tab keeps the reason it was opened with rather than check its file again, so the refusal has to hold there too, whatever else the parked state says.
test("a parked file whose page lists disagree comes back read-only", async () => {
  const parked = await mountLoadedModel(
    1,
    "pages.pdf",
    await pdfWithUntypedFirstPage(),
  );
  const session = parked.result.current.model.createDocumentEditorSession();
  assert.ok(session, "no session was captured for a loaded document");
  assert.equal(session.readOnlyReason, "ambiguous page order");
  parked.unmount();

  const { result } = await mountLoadedModel(
    1,
    undefined,
    session.pdfBytes,
    [],
    { ...session, editingEnabled: true },
  );
  assert.equal(result.current.model.readOnlyReason, "ambiguous page order");
  assert.equal(result.current.model.editingEnabled, false);
  assert.equal(result.current.model.readOnly, true);
});
