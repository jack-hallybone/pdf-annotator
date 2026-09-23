import assert from "node:assert/strict";
import { test } from "node:test";
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from "pdf-lib";
import "./rendererAssetStubs";
import {
  pendingDocumentRefusals,
  refuseNextDocumentLoad,
} from "./refusingRenderer.mjs";
import type { PdfDocumentEditorSource } from "../src/pdfdocumenteditor/host";
import type { PdfDocumentEditorViewBridge } from "../src/pdfdocumenteditor/useDocumentModel";
import type { PdfDocumentEditorViewSnapshot } from "../src/pdfdocumenteditor/viewSnapshot";

// Every case reads the file that was written rather than the model's own
// bookkeeping, which can look right over a file that is wrong.

// pdf.js's browser entry touches these globals while it is evaluated.
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

const { useDocumentModel } =
  await import("../src/pdfdocumenteditor/useDocumentModel");

// pdfRender's module side effect points workerSrc at a stubbed Vite asset, so it
// has to be aimed at the real worker after that import.
const { GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const STUB_VIEW: PdfDocumentEditorViewSnapshot = {
  activePageIndex: 0,
  scale: 1,
  viewPosition: { offsetRatio: 0, pageIndex: 0, scrollLeftRatio: 0 },
};

const TWO_NOTES = [null, "note on page 1", "note on page 2"];

type Model = ReturnType<typeof useDocumentModel>;

// appendDocument needs a host file picker, so its insert-at-the-end shape is
// covered by the page insert here and by page-identity.test.ts.
const PAGE_EDITS = [
  {
    afterEdit: [
      [0, "direct:0:0"],
      [1, "direct:1:0"],
    ],
    name: "deleting a page",
    run: (model: () => Model) => model().handleDeletePage(0),
  },
  {
    afterEdit: [
      [2, "direct:2:0"],
      [3, "direct:3:0"],
    ],
    name: "inserting a page",
    run: (model: () => Model) => model().handleAddPage(0, "after"),
  },
  {
    afterEdit: [
      [2, "direct:2:0"],
      [1, "direct:1:0"],
    ],
    name: "moving a page",
    run: (model: () => Model) => model().handleMovePage(1, 1),
  },
  {
    afterEdit: [
      [1, "direct:1:0"],
      [2, "direct:2:0"],
    ],
    name: "rotating a page",
    run: (model: () => Model) => model().handleRotatePage(1),
  },
] as const;

const BEFORE_ANY_EDIT = [
  [1, "direct:1:0"],
  [2, "direct:2:0"],
];

for (const pageEdit of PAGE_EDITS) {
  test(`${pageEdit.name} restates the identities the save then resolves`, async () => {
    const written: Uint8Array[] = [];
    const { result } = await mountWithNotes(TWO_NOTES, written);
    const model = () => result.current.model;
    assert.deepEqual(identities(model()), BEFORE_ANY_EDIT);

    await act(async () => {
      await pageEdit.run(model);
    });
    assert.deepEqual(identities(model()), pageEdit.afterEdit);

    await editAndSave(model, "note on page 1", "EDITED");
    assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
  });

  test(`undoing ${pageEdit.name} leaves identities the save can resolve`, async () => {
    const written: Uint8Array[] = [];
    const { result } = await mountWithNotes(TWO_NOTES, written);
    const model = () => result.current.model;

    await act(async () => {
      await pageEdit.run(model);
    });
    await act(async () => {
      await model().undoHistory();
    });
    assert.deepEqual(identities(model()), BEFORE_ANY_EDIT);

    await editAndSave(model, "note on page 1", "EDITED");
    assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
  });

  test(`redoing ${pageEdit.name} leaves identities the save can resolve`, async () => {
    const written: Uint8Array[] = [];
    const { result } = await mountWithNotes(TWO_NOTES, written);
    const model = () => result.current.model;

    await act(async () => {
      await pageEdit.run(model);
    });
    await act(async () => {
      await model().undoHistory();
    });
    await act(async () => {
      await model().redoHistory();
    });
    assert.deepEqual(identities(model()), pageEdit.afterEdit);

    await editAndSave(model, "note on page 1", "EDITED");
    assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
  });
}

// The restatement runs before the reload, so a reload that fails would leave
// every identity describing bytes that were never committed. The failure comes
// from the renderer refusing the document (tests/refusingRenderer.mjs).
test("a page delete whose reload fails puts every identity back", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written, notices);
  const model = () => result.current.model;

  const doomed = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 1",
  );
  assert.ok(doomed?.sourceId);
  await act(async () => {
    model().removedAnnotationSourceIdsRef.current.add(doomed.sourceId!);
    model().commitAnnotations((annotations) =>
      annotations.filter((annotation) => annotation.id !== doomed.id),
    );
  });
  const before = pageEditBookkeeping(model());
  assert.deepEqual(before.removedAnnotationSourceIds, ["direct:1:0"]);

  refuseNextDocumentLoad();
  await act(async () => {
    await model().handleDeletePage(0);
  });

  // The refusal must have been spent here, or the case passed on a path it never
  // drove.
  assert.equal(
    pendingDocumentRefusals(),
    0,
    "the edit never reached the reload",
  );
  assert.ok(
    notices.includes("Could not reload the PDF after deleting the page."),
    `expected the reload failure to be named, got ${JSON.stringify(notices)}`,
  );

  assert.equal(model().pageCount, 3);
  assert.deepEqual(pageEditBookkeeping(model()), before);

  await editAndSave(model, "note on page 2", "EDITED");
  assert.deepEqual(await noteTexts(written.at(-1)!), [[], [], ["EDITED"]]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("a page edit followed by a save writes the note that was edited", async () => {
  const written: Uint8Array[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written);
  const model = () => result.current.model;

  await act(async () => {
    await model().handleDeletePage(0);
  });
  await editAndSave(model, "note on page 1", "EDITED");

  assert.deepEqual(await noteTexts(written.at(-1)!), [
    ["EDITED"],
    ["note on page 2"],
  ]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("a save, then a page edit, then another save", async () => {
  const written: Uint8Array[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written);
  const model = () => result.current.model;

  await editAndSave(model, "note on page 2", "FIRST EDIT");
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));

  await act(async () => {
    await model().handleDeletePage(0);
  });
  await editAndSave(model, "note on page 1", "SECOND EDIT");

  assert.deepEqual(await noteTexts(written.at(-1)!), [
    ["SECOND EDIT"],
    ["FIRST EDIT"],
  ]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("a page edit, a save, an undo back past the page edit, and a save", async () => {
  const written: Uint8Array[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written);
  const model = () => result.current.model;

  await act(async () => {
    await model().handleDeletePage(0);
  });
  await editAndSave(model, "note on page 1", "EDITED");

  await act(async () => {
    await model().undoHistory();
  });
  await act(async () => {
    await model().undoHistory();
  });
  assert.deepEqual(identities(model()), BEFORE_ANY_EDIT);
  assert.deepEqual(model().annotations.map(noteText), [
    "note on page 1",
    "note on page 2",
  ]);

  await editAndSave(model, "note on page 2", "EDITED AFTER UNDO");
  assert.deepEqual(await noteTexts(written.at(-1)!), [
    [],
    ["note on page 1"],
    ["EDITED AFTER UNDO"],
  ]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("deleting the page a note is on, saving, and undoing it back", async () => {
  const written: Uint8Array[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written);
  const model = () => result.current.model;

  await act(async () => {
    await model().handleDeletePage(1);
  });
  assert.deepEqual(identities(model()), [[1, "direct:1:0"]]);
  await editAndSave(model, "note on page 2", "EDITED");
  assert.deepEqual(await noteTexts(written.at(-1)!), [[], ["EDITED"]]);

  await act(async () => {
    await model().undoHistory();
  });
  await act(async () => {
    await model().undoHistory();
  });
  assert.deepEqual(identities(model()), BEFORE_ANY_EDIT);

  await editAndSave(model, "note on page 1", "EDITED AFTER UNDO");
  assert.deepEqual(await noteTexts(written.at(-1)!), [
    [],
    ["EDITED AFTER UNDO"],
    ["note on page 2"],
  ]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("a page edit while a removal is pending deletes the annotation the reader deleted", async () => {
  const written: Uint8Array[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written);
  const model = () => result.current.model;

  const doomed = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 1",
  );
  assert.ok(doomed?.sourceId);
  await act(async () => {
    model().removedAnnotationSourceIdsRef.current.add(doomed.sourceId!);
    model().commitAnnotations((annotations) =>
      annotations.filter((annotation) => annotation.id !== doomed.id),
    );
  });

  await act(async () => {
    await model().handleDeletePage(0);
  });
  assert.deepEqual(
    [...model().removedAnnotationSourceIdsRef.current],
    ["direct:0:0"],
  );

  await act(async () => {
    assert.equal(await model().handleSave(), true);
  });
  assert.deepEqual(await noteTexts(written.at(-1)!), [[], ["note on page 2"]]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("a removal whose page is deleted outright is dropped, not replayed", async () => {
  const written: Uint8Array[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written);
  const model = () => result.current.model;

  const doomed = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 1",
  );
  assert.ok(doomed?.sourceId);
  await act(async () => {
    model().removedAnnotationSourceIdsRef.current.add(doomed.sourceId!);
    model().commitAnnotations((annotations) =>
      annotations.filter((annotation) => annotation.id !== doomed.id),
    );
  });

  await act(async () => {
    await model().handleDeletePage(1);
  });
  assert.deepEqual([...model().removedAnnotationSourceIdsRef.current], []);

  await act(async () => {
    assert.equal(await model().handleSave(), true);
  });
  assert.deepEqual(await noteTexts(written.at(-1)!), [[], ["note on page 2"]]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

// The writer's uniqueness check counts how many annotations a key matches, so it
// cannot tell a shifted /Annots array from the one the key was minted against:
// the count is 1 either way, and the 1 is the wrong annotation.
const CROWDED_PAGES: PageNotes[] = [
  null,
  ["note A", "note B", "note C"],
  ["note D"],
  null,
];

const SURVIVING_PAGE_EDITS = [
  {
    name: "deleting an empty page",
    run: (model: () => Model) => model().handleDeletePage(0),
  },
  {
    name: "inserting a page",
    run: (model: () => Model) => model().handleAddPage(0, "after"),
  },
  {
    name: "moving a page",
    run: (model: () => Model) => model().handleMovePage(1, 1),
  },
  {
    name: "rotating a page",
    run: (model: () => Model) => model().handleRotatePage(1),
  },
] as const;

const REMOVAL_KEY_SHAPES = [
  { indirect: false, name: "a direct dictionary" },
  { indirect: true, name: "an indirect reference" },
] as const;

for (const shape of REMOVAL_KEY_SHAPES) {
  for (const pageEdit of SURVIVING_PAGE_EDITS) {
    for (const doomedText of ["note A", "note B", "note C", "note D"]) {
      test(`${pageEdit.name} while ${doomedText} is pending removal by ${shape.name}`, async () => {
        const written: Uint8Array[] = [];
        const { result } = await mountWithNotes(CROWDED_PAGES, written, [], {
          indirect: shape.indirect,
        });
        const model = () => result.current.model;

        const doomed = model().annotations.find(
          (annotation) => noteText(annotation) === doomedText,
        );
        assert.ok(doomed?.sourceId, `no note reading ${doomedText}`);
        await act(async () => {
          model().removedAnnotationSourceIdsRef.current.add(doomed.sourceId!);
          model().commitAnnotations((annotations) =>
            annotations.filter((annotation) => annotation.id !== doomed.id),
          );
        });

        await act(async () => {
          await pageEdit.run(model);
        });
        await act(async () => {
          assert.equal(await model().handleSave(), true);
        });

        const survivors = await fileNotes(written.at(-1)!);
        assert.deepEqual(
          survivors,
          modelNotes(model()),
          "the file and the model disagree about what the document holds",
        );
        assert.deepEqual(
          survivors.map((note) => note.text).sort(),
          ["note A", "note B", "note C", "note D"]
            .filter((text) => text !== doomedText)
            .sort(),
          "the removal took out an annotation other than the one deleted",
        );
      });
    }
  }
}

test("an identity a page edit cannot restate stops the save by name", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written, notices);
  const model = () => result.current.model;

  const stray = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 2",
  );
  assert.ok(stray);
  await act(async () => {
    model().commitAnnotations((annotations) =>
      annotations.map((annotation) =>
        annotation.id === stray.id
          ? { ...annotation, sourceId: "direct:1:1" }
          : annotation,
      ),
    );
  });

  await act(async () => {
    await model().handleDeletePage(1);
  });
  assert.deepEqual(
    model()
      .annotations.filter((annotation) => annotation.id === stray.id)
      .map((annotation) => annotation.sourceId),
    ["unresolved:shifted:1:1"],
  );

  await act(async () => {
    model().commitAnnotations((annotations) =>
      annotations.map((annotation) =>
        annotation.id === stray.id && annotation.kind === "stickyNote"
          ? { ...annotation, text: "EDITED" }
          : annotation,
      ),
    );
  });
  await act(async () => {
    assert.equal(await model().handleSave(), false);
  });

  assert.equal(written.length, 0);
  assert.ok(
    notices.some((notice) => /could not be located in the file/.test(notice)),
    `expected a named refusal, got ${JSON.stringify(notices)}`,
  );
});

// Undoing a page delete re-creates that page's annotation objects under new
// numbers. The delete direction reported success with the note still in the
// written file, so this asks the outcome rather than the refusal.
test("deleting a note on a page a delete-undo restored takes it out of the file", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written, notices, {
    indirect: true,
  });
  const model = () => result.current.model;

  await act(async () => {
    await model().handleDeletePage(1);
  });
  await act(async () => {
    await model().undoHistory();
  });

  const doomed = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 1",
  );
  assert.ok(doomed?.sourceId);
  await act(async () => {
    model().removedAnnotationSourceIdsRef.current.add(doomed.sourceId!);
    model().commitAnnotations((annotations) =>
      annotations.filter((annotation) => annotation.id !== doomed.id),
    );
  });

  await act(async () => {
    assert.equal(
      await model().handleSave(),
      true,
      `notices: ${JSON.stringify(notices)}`,
    );
  });
  assert.deepEqual(await noteTexts(written.at(-1)!), [
    [],
    [],
    ["note on page 2"],
  ]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("a removal whose identity names nothing stops the save by name", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written, notices, {
    indirect: true,
  });
  const model = () => result.current.model;

  const doomed = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 1",
  );
  assert.ok(doomed?.sourceId);
  await act(async () => {
    model().removedAnnotationSourceIdsRef.current.add("9999 0 R");
    model().commitAnnotations((annotations) =>
      annotations.filter((annotation) => annotation.id !== doomed.id),
    );
  });

  await act(async () => {
    assert.equal(await model().handleSave(), false);
  });
  assert.equal(written.length, 0);
  assert.ok(
    notices.some((notice) =>
      /removed could not be found in the file/.test(notice),
    ),
    `expected a named refusal, got ${JSON.stringify(notices)}`,
  );
});

test("deleting a note by indirect reference and then its page still saves", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written, notices, {
    indirect: true,
  });
  const model = () => result.current.model;

  const doomed = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 1",
  );
  assert.ok(doomed?.sourceId);
  await act(async () => {
    model().removedAnnotationSourceIdsRef.current.add(doomed.sourceId!);
    model().commitAnnotations((annotations) =>
      annotations.filter((annotation) => annotation.id !== doomed.id),
    );
  });

  await act(async () => {
    await model().handleDeletePage(1);
  });
  assert.deepEqual([...model().removedAnnotationSourceIdsRef.current], []);

  await act(async () => {
    assert.equal(await model().handleSave(), true);
  });
  assert.deepEqual(await noteTexts(written.at(-1)!), [[], ["note on page 2"]]);
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

test("a page edit does not re-read the marks the model already holds", async () => {
  const written: Uint8Array[] = [];
  // Four pages, so the reload's eager pass reaches past the initial band.
  const { result } = await mountWithNotes(
    ["note 0", "note 1", "note 2", "note 3"],
    written,
  );
  const model = () => result.current.model;
  assert.equal(model().annotations.length, 4);

  await act(async () => {
    await model().handleAddPage(0, "after");
  });
  await waitFor(
    () => {
      assert.equal(model().pageCount, 5);
    },
    { timeout: 15_000 },
  );

  assert.deepEqual(identities(model()), [
    [0, "direct:0:0"],
    [2, "direct:2:0"],
    [3, "direct:3:0"],
    [4, "direct:4:0"],
  ]);

  await editAndSave(model, "note 2", "EDITED");
  assert.deepEqual(await fileNotes(written.at(-1)!), modelNotes(model()));
});

// The undo of a page delete is insertPages over extractPagesBytes, and both
// halves copy, so an indirect reference comes back naming nothing.
const COPY_SHAPED_PAGES: PageNotes[] = [
  ["p0a", "p0b"],
  "p1",
  null,
  ["p3a", "p3b"],
];

const ALL_NOTES = ["p0a", "p0b", "p1", "p3a", "p3b"];

const RESTORING_PAGE_EDITS = [
  {
    name: "deleting a page",
    run: (model: () => Model) => model().handleDeletePage(0),
  },
  {
    name: "deleting a later page",
    run: (model: () => Model) => model().handleDeletePage(3),
  },
  {
    name: "inserting a page",
    run: (model: () => Model) => model().handleAddPage(0, "after"),
  },
  {
    name: "moving a page",
    run: (model: () => Model) => model().handleMovePage(0, 1),
  },
  {
    name: "rotating a page",
    run: (model: () => Model) => model().handleRotatePage(0),
  },
] as const;

for (const shape of REMOVAL_KEY_SHAPES) {
  for (const pageEdit of RESTORING_PAGE_EDITS) {
    for (const undos of [1, 2] as const) {
      test(`${pageEdit.name} then ${undos === 1 ? "undo" : "undo and redo"}, ${shape.name}: every note is still writable`, async () => {
        const written: Uint8Array[] = [];
        const notices: string[] = [];
        const { result } = await mountWithNotes(
          COPY_SHAPED_PAGES,
          written,
          notices,
          { indirect: shape.indirect },
        );
        const model = () => result.current.model;

        await act(async () => {
          await pageEdit.run(model);
        });
        await act(async () => {
          await model().undoHistory();
        });
        if (undos === 2) {
          await act(async () => {
            await model().redoHistory();
          });
        }

        const survivors = model()
          .annotations.map(noteText)
          .filter((text): text is string => Boolean(text));
        for (const text of survivors) {
          await editAndSave(model, text, `EDITED ${text}`);
        }
        assert.deepEqual(
          await fileNotes(written.at(-1)!),
          modelNotes(model()),
          `notices: ${JSON.stringify(notices)}`,
        );
        assert.deepEqual(
          (await fileNotes(written.at(-1)!)).map((note) => note.text).sort(),
          survivors.map((text) => `EDITED ${text}`).sort(),
        );
      });
    }
  }
}

test("a page delete, a save, an undo, and an edit to the note that came back", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written, notices, {
    indirect: true,
  });
  const model = () => result.current.model;

  await act(async () => {
    await model().handleDeletePage(1);
  });
  await editAndSave(model, "note on page 2", "EDITED FIRST");
  await act(async () => {
    await model().undoHistory();
  });
  await act(async () => {
    await model().undoHistory();
  });

  await editAndSave(model, "note on page 1", "EDITED AFTER UNDO");
  assert.deepEqual(
    await fileNotes(written.at(-1)!),
    modelNotes(model()),
    `notices: ${JSON.stringify(notices)}`,
  );
  assert.deepEqual(await noteTexts(written.at(-1)!), [
    [],
    ["EDITED AFTER UNDO"],
    ["note on page 2"],
  ]);
});

test("two page deletes and two undos leave every note writable", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(COPY_SHAPED_PAGES, written, notices, {
    indirect: true,
  });
  const model = () => result.current.model;

  await act(async () => {
    await model().handleDeletePage(3);
  });
  await act(async () => {
    await model().handleDeletePage(0);
  });
  await act(async () => {
    await model().undoHistory();
  });
  await act(async () => {
    await model().undoHistory();
  });

  const survivors = model()
    .annotations.map(noteText)
    .filter((text): text is string => Boolean(text));
  assert.deepEqual(
    survivors.slice().sort(),
    ALL_NOTES.slice().sort(),
    `pages ${model().pageCount} notices ${JSON.stringify(notices)} ids ${JSON.stringify(identities(model()))}`,
  );
  for (const text of survivors) {
    await editAndSave(model, text, `EDITED ${text}`);
  }
  assert.deepEqual(
    await fileNotes(written.at(-1)!),
    modelNotes(model()),
    `notices: ${JSON.stringify(notices)}`,
  );
});

test("a save the writer refuses still lets the reader download their work", async () => {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const downloaded: Uint8Array[] = [];
  const { result } = await mountWithNotes(TWO_NOTES, written, notices, {
    downloaded,
  });
  const model = () => result.current.model;

  const stray = model().annotations.find(
    (annotation) => noteText(annotation) === "note on page 2",
  );
  assert.ok(stray);
  await act(async () => {
    model().commitAnnotations((annotations) =>
      annotations.map((annotation) =>
        annotation.id === stray.id
          ? { ...annotation, sourceId: "unresolved:shifted:2:0" }
          : annotation,
      ),
    );
  });
  await act(async () => {
    model().commitAnnotations((annotations) =>
      annotations.map((annotation) =>
        annotation.kind === "stickyNote" &&
        noteText(annotation) === "note on page 1"
          ? { ...annotation, text: "EDITED" }
          : annotation,
      ),
    );
  });

  await act(async () => {
    assert.equal(await model().handleSave(), false);
  });
  assert.equal(written.length, 0);

  await act(async () => {
    await model().handleDownload();
  });
  assert.equal(downloaded.length, 1, `notices: ${JSON.stringify(notices)}`);
  assert.deepEqual(await noteTexts(downloaded.at(-1)!), [
    [],
    ["EDITED"],
    ["note on page 2"],
  ]);
  assert.ok(
    notices.some((notice) => /could not be identified/.test(notice)),
    `expected the copy to name what it left out, got ${JSON.stringify(notices)}`,
  );
  assert.equal(model().hasUnsavedChanges, true);
});

const UNIDENTIFIABLE_COUNTS = [
  {
    name: "one edited annotation whose identity is lost",
    expected: "1 annotation could not be identified",
    poison: ["note on page 1"],
    empty: [],
  },
  {
    name: "two edited annotations whose identities are lost",
    expected: "2 annotations could not be identified",
    poison: ["note on page 1", "note on page 2"],
    empty: [],
  },
  {
    name: "one deleted annotation whose identity is lost",
    expected: "1 annotation could not be identified",
    poison: ["note on page 1"],
    empty: ["note on page 1"],
  },
];

for (const shape of UNIDENTIFIABLE_COUNTS) {
  test(`the copy says ${shape.expected} for ${shape.name}`, async () => {
    const written: Uint8Array[] = [];
    const notices: string[] = [];
    const downloaded: Uint8Array[] = [];
    const { result } = await mountWithNotes(TWO_NOTES, written, notices, {
      downloaded,
    });
    const model = () => result.current.model;

    await act(async () => {
      model().commitAnnotations((annotations) =>
        annotations.map((annotation, index) => {
          const text = noteText(annotation);
          if (!text || !shape.poison.includes(text)) {
            return annotation;
          }
          const poisoned = {
            ...annotation,
            sourceId: `unresolved:shifted:${index}:0`,
          };
          return shape.empty.includes(text) && poisoned.kind === "stickyNote"
            ? { ...poisoned, text: "" }
            : poisoned;
        }),
      );
    });

    await act(async () => {
      await model().handleDownload();
    });
    assert.equal(downloaded.length, 1, `notices: ${JSON.stringify(notices)}`);
    const notice = notices.find((entry) =>
      /could not be identified/.test(entry),
    );
    assert.ok(notice, `no notice, got ${JSON.stringify(notices)}`);
    assert.ok(
      notice.startsWith(shape.expected),
      `expected "${shape.expected}...", got "${notice}"`,
    );
  });
}

async function editAndSave(model: () => Model, from: string, to: string) {
  const target = model().annotations.find(
    (annotation) => noteText(annotation) === from,
  );
  assert.ok(target, `no note reading ${JSON.stringify(from)}`);
  await act(async () => {
    model().commitAnnotations((annotations) =>
      annotations.map((annotation) =>
        annotation.id === target.id && annotation.kind === "stickyNote"
          ? { ...annotation, text: to }
          : annotation,
      ),
    );
  });
  await act(async () => {
    assert.equal(await model().handleSave(), true);
  });
}

function noteText(annotation: { kind: string; text?: string }) {
  return annotation.kind === "stickyNote" ? annotation.text : undefined;
}

function identities(model: Model) {
  return sourceIdentities(model.annotations);
}

function sourceIdentities(
  annotations: { pageIndex: number; sourceId?: string }[],
) {
  return annotations.map((annotation) => [
    annotation.pageIndex,
    annotation.sourceId,
  ]);
}

// Read back through the command that parks a tab, where a session's bookkeeping
// is written down. By identity only: the rollback rebuilds the objects.
function pageEditBookkeeping(model: Model) {
  const session = model.createDocumentEditorSession();
  assert.ok(session, "no session was captured for a loaded document");
  return {
    annotations: sourceIdentities(session.annotations),
    cleanAnnotations: sourceIdentities(session.cleanAnnotations),
    cleanSignatureRefreshEnabled: session.cleanSignatureRefreshEnabled,
    importedAnnotationPageIndexes: ascending(
      session.importedAnnotationPageIndexes,
    ),
    managedAnnotationPageIndexes: ascending(
      session.managedAnnotationPageIndexes,
    ),
    removedAnnotationSourceIds: [...session.removedAnnotationSourceIds].sort(),
    shouldImportAnnotations: session.shouldImportAnnotations,
  };
}

function ascending(pageIndexes: number[]) {
  return [...pageIndexes].sort((first, second) => first - second);
}

function modelNotes(model: Model) {
  return model.annotations
    .map((annotation) => ({
      pageIndex: annotation.pageIndex,
      text: noteText(annotation) ?? "",
    }))
    .sort((first, second) => first.text.localeCompare(second.text));
}

async function mountWithNotes(
  contents: PageNotes[],
  written: Uint8Array[],
  notices: string[] = [],
  {
    downloaded = [],
    indirect = false,
  }: { downloaded?: Uint8Array[]; indirect?: boolean } = {},
) {
  const bytes = await notesPdf(contents, indirect);
  const harness = renderHook(() =>
    useModelHarness(bytes, written, notices, downloaded),
  );
  await waitFor(
    () => {
      assert.ok(
        harness.result.current.model.pdfDoc,
        `document never loaded: ${harness.result.current.model.loadError}`,
      );
    },
    { timeout: 15_000 },
  );
  await act(async () => {
    await harness.result.current.model.importAllAnnotations();
  });
  const expected = contents.flatMap(pageNoteTexts).length;
  await waitFor(
    () => {
      assert.equal(harness.result.current.model.annotations.length, expected);
    },
    { timeout: 15_000 },
  );
  return harness;
}

function useModelHarness(
  bytes: Uint8Array,
  written: Uint8Array[],
  notices: string[],
  downloaded: Uint8Array[] = [],
) {
  const view = useStubView();
  const source = useRef<PdfDocumentEditorSource>({
    bytes,
    downloadTarget: async (downloadedBytes: Uint8Array) => {
      downloaded.push(downloadedBytes);
    },
    name: "harness.pdf",
    saveTarget: async (savedBytes: Uint8Array) => {
      written.push(savedBytes);
    },
    sourceId: "harness-1",
  });
  const model = useDocumentModel({
    allowEditing: true,
    allowImageAnnotations: false,
    initialSession: null,
    manageDocumentTitle: false,
    onClose: () => {},
    onNotice: (message) => {
      notices.push(message);
    },
    printTarget: null,
    showAnnotations: true,
    source: source.current,
  });
  const { attachView } = model;

  useLayoutEffect(() => attachView(view.bridge), [attachView, view.bridge]);

  return { model };
}

function useStubView() {
  const activePageIndexRef = useRef(0);
  const visiblePageRangeRef = useRef({ end: 0, start: 0 });
  const [, setActivePageIndex] = useState(0);
  const [, setSelectedAnnotationIds] = useState<string[]>([]);
  const [, setFocusedAnnotationId] = useState<string | null>(null);
  const bridge: RefObject<PdfDocumentEditorViewBridge> =
    useRef<PdfDocumentEditorViewBridge>({
      activePageIndex: 0,
      activePageIndexRef,
      captureViewSnapshot: () => STUB_VIEW,
      clearInitialVisualReadiness: () => {},
      markInitialAnnotationsReady: () => {},
      resetInitialVisualReadiness: () => {},
      restoreViewPosition: () => {},
      revealPreparationError: () => {},
      runAfterInitialVisualReady: (callback: () => void) => callback(),
      setActivePageIndex,
      setFocusedAnnotationId,
      setScale: () => {},
      setSelectedAnnotationIds,
      visiblePageRangeRef,
    });

  return { bridge };
}

// Either the dictionary itself, whose identity is its position, or an indirect
// reference, the shape a re-created page renumbers.
async function notesPdf(contents: PageNotes[], indirect = false) {
  const pdfDoc = await PDFDocument.create();
  const { context } = pdfDoc;
  for (const entry of contents) {
    const page = pdfDoc.addPage([612, 792]);
    const texts = pageNoteTexts(entry);
    if (texts.length === 0) {
      continue;
    }
    const notes = texts.map((text, index) => {
      const note = context.obj({
        C: [1, 0.9, 0],
        Contents: PDFHexString.fromText(text),
        P: page.ref,
        // Each note gets its own rectangle: sharing one would share a geometry key
        // too, and position is all that tells them apart.
        Rect: [72, 700 - index * 40, 92, 720 - index * 40],
        Subtype: "Text",
        Type: "Annot",
      });
      return indirect ? context.register(note) : note;
    });
    page.node.set(PDFName.of("Annots"), context.obj(notes));
  }
  return pdfDoc.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

type PageNotes = string | string[] | null;

function pageNoteTexts(entry: PageNotes) {
  if (entry === null) {
    return [];
  }
  return Array.isArray(entry) ? entry : [entry];
}

async function noteTexts(bytes: Uint8Array) {
  const pdfDoc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  return pdfDoc.getPages().map((page) => {
    const annots = page.node.Annots();
    const texts: string[] = [];
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const dict = annots?.lookupMaybe(index, PDFDict);
      if (
        dict?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() !==
        "Text"
      ) {
        continue;
      }
      texts.push(
        dict
          .lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)
          ?.decodeText() ?? "",
      );
    }
    return texts;
  });
}

async function fileNotes(bytes: Uint8Array) {
  return (await noteTexts(bytes))
    .flatMap((texts, pageIndex) => texts.map((text) => ({ pageIndex, text })))
    .sort((first, second) => first.text.localeCompare(second.text));
}
