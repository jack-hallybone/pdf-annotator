import assert from "node:assert/strict";
import { test } from "node:test";
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

// The document owner, mounted on its own with a stub viewport, on the three
// defects specific to the split: a parked session or undo entry folding the
// viewport back into the document state, a proxy committed without bumping
// documentVersion, and a `primaryView()` where an `eachView()` belongs.

// `fileName` is what the window title, the tab strip, the rename dialog's
// default and every suggested save name are built from, so the character rules
// belong at this one entry rather than at those four surfaces.
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

// Nothing stops the document being taken out from under an edit, because the
// shell releases a document's renderer the moment it leaves view. The merge is
// the operation a test can drive this through: its host file picker is the one
// await it can hold open.
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
    // Registered after the merge is already awaiting this same promise, so it runs
    // in the window between the merge's own check and the envelope's.
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

// Two viewports at the model's own level; tests-e2e/split-view.spec.ts proves
// the capability end to end.
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

// Which page a description belongs to is settled by the content streams, and a
// stream the app cannot read leaves that open. `deleted-page-residue.test.ts`
// owns whether the report is right; this owns whether the app passes it on.
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

// A note's text is the one string here that is never shortened, so nothing else
// bounds what a document can put into `annotations`. A check that runs after the
// document is committed has already paid for the memory it refuses, and the
// sizes are literals, so raising the limit fails here.
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
