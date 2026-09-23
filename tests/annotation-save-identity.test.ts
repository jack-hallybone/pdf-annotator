import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "pdf-lib";
import { PDFDict } from "pdf-lib";
import {
  PdfAnnotationIntegrityError,
  remapAnnotationSources,
  remapRemovedAnnotationSources,
} from "../src/pdfdocumenteditor/pdfWriter";
import type { WrittenAnnotationSources } from "../src/pdfdocumenteditor/pdfWriter";
import {
  documentEditorSessionAfterSave,
  documentEditorSessionOutput,
} from "../src/pdfdocumenteditor/sessionOutput";
import { createWorkSignature } from "../src/pdfdocumenteditor/annotationState";
import { UNCHANGED_PAGE_ORDER } from "../src/pdfdocumenteditor/pageIdentity";
import { markNonSerializable } from "../src/pdfdocumenteditor/sensitiveSession";
import { annotationHistoryEntry } from "../src/pdfdocumenteditor/historyStack";
import type { SensitivePdfDocumentEditorSession } from "../src/pdfdocumenteditor/PdfDocumentEditor";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import { loadTestPdf } from "./pdfTestUtils";

// A save is also an import it never did: this app's own writer moves the
// positions that identify a direct dictionary and then makes the bytes it wrote
// the baseline without re-importing them, so a second save resolved positions
// recorded against the first save's input.

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
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { importExistingAnnotationsForPage } =
  await import("../src/pdfdocumenteditor/annotationImport");

test("a second save edits the annotation the first one edited, not its neighbour", async () => {
  const bytes = await directNotesPdf(["A", "B", "C"]);
  const imported = await importPageAnnotations(bytes);
  assert.deepEqual(sourceIds(imported), [
    "direct:0:0",
    "direct:0:1",
    "direct:0:2",
  ]);

  const first = await saveSession(
    openSession(bytes, imported, {
      annotations: retext(without(imported, 0), imported[1].id, "B edited"),
      removedAnnotationSourceIds: [imported[0].sourceId!],
    }),
  );
  assert.deepEqual(await noteTexts(first.bytes), ["B edited", "C"]);

  assert.deepEqual(sourceIds(first.session.annotations), [
    "direct:0:0",
    "direct:0:1",
  ]);
  assert.deepEqual(first.session.removedAnnotationSourceIds, []);

  const second = await saveSession(
    editSession(first.session, (annotations) =>
      retext(annotations, imported[1].id, "B edited twice"),
    ),
  );

  assert.deepEqual(await noteTexts(second.bytes), ["B edited twice", "C"]);
});

test("a removal is not replayed against a file it has already left", async () => {
  const bytes = await directNotesPdf(["A", "B", "C", "D"]);
  const imported = await importPageAnnotations(bytes);

  const first = await saveSession(
    openSession(bytes, imported, {
      annotations: without(imported, 0),
      removedAnnotationSourceIds: [imported[0].sourceId!],
    }),
  );
  assert.deepEqual(await noteTexts(first.bytes), ["B", "C", "D"]);

  const second = await saveSession(
    editSession(
      first.session,
      (annotations) =>
        annotations.filter((annotation) => annotation.id !== imported[2].id),
      [sourceIdOf(first.session, imported[2].id)],
    ),
  );

  assert.deepEqual(await noteTexts(second.bytes), ["B", "D"]);
});

test("an edit repeated across two saves stays on its own annotation", async () => {
  const bytes = await directNotesPdf(["A", "B", "C"]);
  const imported = await importPageAnnotations(bytes);

  const first = await saveSession(
    openSession(bytes, imported, {
      annotations: retext(imported, imported[1].id, "B edited"),
    }),
  );
  assert.deepEqual(await noteTexts(first.bytes), ["A", "B edited", "C"]);

  const second = await saveSession(
    editSession(first.session, (annotations) =>
      retext(annotations, imported[1].id, "B edited twice"),
    ),
  );

  assert.deepEqual(await noteTexts(second.bytes), ["A", "B edited twice", "C"]);
});

test("moving an annotation to another page leaves the entries behind it addressable", async () => {
  const bytes = await directNotesPdf(["A", "B", "C"], { pageCount: 2 });
  const imported = await importPageAnnotations(bytes);

  const first = await saveSession(
    openSession(bytes, imported, {
      annotations: imported.map((annotation) =>
        annotation.id === imported[0].id
          ? { ...annotation, pageIndex: 1 }
          : annotation,
      ),
      managedAnnotationPageIndexes: [0, 1],
    }),
  );
  assert.deepEqual(await noteTextsByPage(first.bytes), [["B", "C"], ["A"]]);

  const second = await saveSession(
    editSession(first.session, (annotations) =>
      retext(annotations, imported[2].id, "C edited"),
    ),
  );

  assert.deepEqual(await noteTextsByPage(second.bytes), [
    ["B", "C edited"],
    ["A"],
  ]);
});

test("three saves in a row each land on the annotation they name", async () => {
  const bytes = await directNotesPdf(["A", "B", "C", "D"]);
  const imported = await importPageAnnotations(bytes);

  const first = await saveSession(
    openSession(bytes, imported, {
      annotations: retext(without(imported, 0), imported[1].id, "B edited"),
      removedAnnotationSourceIds: [imported[0].sourceId!],
    }),
  );
  assert.deepEqual(await noteTexts(first.bytes), ["B edited", "C", "D"]);

  const second = await saveSession(
    editSession(
      first.session,
      (annotations) =>
        retext(
          annotations.filter((annotation) => annotation.id !== imported[2].id),
          imported[3].id,
          "D edited",
        ),
      [sourceIdOf(first.session, imported[2].id)],
    ),
  );
  assert.deepEqual(await noteTexts(second.bytes), ["B edited", "D edited"]);

  const third = await saveSession(
    editSession(second.session, (annotations) =>
      retext(
        retext(annotations, imported[1].id, "B edited twice"),
        imported[3].id,
        "D edited twice",
      ),
    ),
  );

  assert.deepEqual(await noteTexts(third.bytes), [
    "B edited twice",
    "D edited twice",
  ]);
});

test("an indirect reference is not restated by a shift behind it", async () => {
  const bytes = await mixedNotesPdf();
  const imported = await importPageAnnotations(bytes);
  assert.deepEqual(sourceIds(imported), ["direct:0:0", "50R"]);

  const first = await saveSession(
    openSession(bytes, imported, {
      annotations: retext(without(imported, 0), imported[1].id, "ref edited"),
      removedAnnotationSourceIds: [imported[0].sourceId!],
    }),
  );
  assert.deepEqual(await noteTexts(first.bytes), ["ref edited"]);
  assert.deepEqual(sourceIds(first.session.annotations), ["50R"]);

  const second = await saveSession(
    editSession(first.session, (annotations) =>
      retext(annotations, imported[1].id, "ref edited twice"),
    ),
  );

  assert.deepEqual(await noteTexts(second.bytes), ["ref edited twice"]);
});

test("the undo history is restated against the file that was written", async () => {
  const bytes = await directNotesPdf(["A", "B", "C"]);
  const imported = await importPageAnnotations(bytes);

  const saved = await saveSession(
    openSession(bytes, imported, {
      annotations: retext(without(imported, 0), imported[1].id, "B edited"),
      removedAnnotationSourceIds: [imported[0].sourceId!],
      undoStack: [annotationHistoryEntry(imported)],
    }),
  );

  const [entry] = saved.session.undoStack;
  assert.equal(entry?.kind, "annotations");
  if (entry?.kind !== "annotations") {
    return;
  }
  assert.deepEqual(sourceIds(entry.annotations), [
    undefined,
    "direct:0:0",
    "direct:0:1",
  ]);
});

// Emptying a note drops it from the output, so the annotation the session still
// holds is the app's own again and typing into it writes a new one.
test("an emptied note typed into again is written fresh", async () => {
  const bytes = await directNotesPdf(["A", "B"]);
  const imported = await importPageAnnotations(bytes);

  const emptied = retext(imported, imported[0].id, "");
  const saved = await saveSession(
    openSession(bytes, imported, { annotations: emptied }),
  );
  assert.deepEqual(await noteTexts(saved.bytes), ["B"]);
  assert.deepEqual(sourceIds(saved.session.annotations), [
    undefined,
    "direct:0:0",
  ]);

  const retyped = await saveSession(
    editSession(saved.session, (annotations) =>
      retext(annotations, imported[0].id, "typed again"),
    ),
  );
  assert.deepEqual((await noteTexts(retyped.bytes)).sort(), [
    "B",
    "typed again",
  ]);

  const again = await saveSession(
    editSession(retyped.session, (annotations) => annotations),
  );
  assert.deepEqual((await noteTexts(again.bytes)).sort(), ["B", "typed again"]);
});

test("a position past the end of the array still stops the save", async () => {
  const bytes = await directNotesPdf(["A"]);
  const imported = await importPageAnnotations(bytes);
  const stale = imported.map((annotation) => ({
    ...annotation,
    sourceId: "direct:0:9",
  }));

  await assert.rejects(
    () =>
      documentEditorSessionOutput(
        openSession(bytes, stale, {
          annotations: retext(stale, imported[0].id, "edited"),
        }),
      ),
    (error) =>
      error instanceof PdfAnnotationIntegrityError &&
      /could not be identified/.test(error.message),
  );
});

// The remap's contract without a PDF in the way: reported gone drops the
// identity and the annotation is the app's own to write fresh; unfollowable, or
// never seen, comes back as an identity nothing matches; and a removal the write
// applied is dropped rather than carried forward.
test("the writer's report is applied without inventing a fallback", () => {
  const sources: WrittenAnnotationSources = new Map([
    ["direct:0:0", { kind: "removed" }],
    ["direct:0:1", { kind: "moved", sourceId: "direct:0:0" }],
    [
      "direct:0:2",
      { kind: "unresolved", sourceId: "unresolved:ambiguous:0:2" },
    ],
  ]);
  const annotations: PdfAnnotation[] = [
    "direct:0:0",
    "direct:0:1",
    "direct:0:2",
    "direct:0:7",
  ].map((sourceId, index) => ({ ...note(`note-${index}`, "text"), sourceId }));
  annotations.push(note("app-made", "text"));

  assert.deepEqual(
    sourceIds(
      remapAnnotationSources(annotations, sources, UNCHANGED_PAGE_ORDER),
    ),
    [
      undefined,
      "direct:0:0",
      "unresolved:ambiguous:0:2",
      "unresolved:shifted:0:7",
      undefined,
    ],
  );

  assert.deepEqual(
    remapRemovedAnnotationSources(
      ["direct:0:0", "direct:0:1", "direct:0:2", "direct:0:7", "an-app-id"],
      sources,
      UNCHANGED_PAGE_ORDER,
    ),
    [
      "direct:0:0",
      "unresolved:ambiguous:0:2",
      "unresolved:shifted:0:7",
      "an-app-id",
    ],
  );
});

async function saveSession(session: SensitivePdfDocumentEditorSession) {
  const output = await documentEditorSessionOutput(session);
  return {
    bytes: output.bytes,
    session: documentEditorSessionAfterSave(session, output),
  };
}

function openSession(
  pdfBytes: Uint8Array,
  cleanAnnotations: PdfAnnotation[],
  overrides: Partial<SensitivePdfDocumentEditorSession>,
): SensitivePdfDocumentEditorSession {
  return markNonSerializable<SensitivePdfDocumentEditorSession>({
    annotations: cleanAnnotations,
    cleanAnnotations,
    cleanPdfBytes: pdfBytes,
    cleanWorkSignature: createWorkSignature("open", cleanAnnotations),
    fileName: "parked.pdf",
    hasUnsavedChanges: true,
    importedAnnotationPageIndexes: [0],
    managedAnnotationPageIndexes: [0],
    pdfBytes,
    pdfFingerprint: "open",
    redoStack: [],
    removedAnnotationSourceIds: [],
    shouldImportAnnotations: false,
    sourceId: "parked-1",
    undoStack: [],
    view: { activePageIndex: 0, scale: 1 },
    version: 1,
    ...overrides,
  });
}

function editSession(
  session: SensitivePdfDocumentEditorSession,
  edit: (annotations: PdfAnnotation[]) => PdfAnnotation[],
  removed: string[] = [],
): SensitivePdfDocumentEditorSession {
  return markNonSerializable<SensitivePdfDocumentEditorSession>({
    ...session,
    annotations: edit(session.annotations),
    hasUnsavedChanges: true,
    removedAnnotationSourceIds: [
      ...session.removedAnnotationSourceIds,
      ...removed,
    ],
  });
}

function sourceIdOf(session: SensitivePdfDocumentEditorSession, id: string) {
  const annotation = session.annotations.find((item) => item.id === id);
  assert.ok(annotation?.sourceId, `no source identity for ${id}`);
  return annotation.sourceId;
}

function retext(annotations: PdfAnnotation[], id: string, text: string) {
  return annotations.map((annotation) =>
    annotation.id === id && annotation.kind === "stickyNote"
      ? { ...annotation, text }
      : annotation,
  );
}

function without(annotations: PdfAnnotation[], index: number) {
  return annotations.filter((_, position) => position !== index);
}

function sourceIds(annotations: PdfAnnotation[]) {
  return annotations.map((annotation) => annotation.sourceId);
}

function note(id: string, text: string): PdfAnnotation {
  return {
    color: [1, 0.9, 0.25],
    id,
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text,
  };
}

async function directNotesPdf(
  contents: string[],
  { pageCount = 1 }: { pageCount?: number } = {},
) {
  const pdfDoc = await PDFDocument.create();
  const pages = Array.from({ length: pageCount }, () =>
    pdfDoc.addPage([612, 792]),
  );
  const { context } = pdfDoc;
  const [page] = pages;
  page.node.set(
    PDFName.of("Annots"),
    context.obj(
      contents.map((text, index) =>
        context.obj({
          C: [1, 0.9, 0],
          Contents: PDFHexString.fromText(text),
          P: page.ref,
          Rect: [72 + index * 40, 700, 92 + index * 40, 720],
          Subtype: "Text",
          Type: "Annot",
        }),
      ),
    ),
  );
  return pdfDoc.save({
    objectsPerTick: 500,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function mixedNotesPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  const direct = context.obj({
    C: [1, 0.9, 0],
    Contents: PDFHexString.fromText("direct"),
    P: page.ref,
    Rect: [72, 700, 92, 720],
    Subtype: "Text",
    Type: "Annot",
  });
  const referenced = PDFRef.of(50, 0);
  context.assign(
    referenced,
    context.obj({
      C: [1, 0.9, 0],
      Contents: PDFHexString.fromText("referenced"),
      P: page.ref,
      Rect: [200, 700, 220, 720],
      Subtype: "Text",
      Type: "Annot",
    }),
  );
  page.node.set(PDFName.of("Annots"), context.obj([direct, referenced]));
  return pdfDoc.save({
    objectsPerTick: 500,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function noteTexts(bytes: Uint8Array) {
  return (await noteTextsByPage(bytes))[0];
}

async function noteTextsByPage(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
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

async function importPageAnnotations(bytes: Uint8Array) {
  const options = {
    data: bytes.slice(),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  };
  const loadingTask = getDocument(options);
  try {
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(1);
    return (await importExistingAnnotationsForPage(page, 0, bytes)).annotations;
  } finally {
    await loadingTask.destroy();
  }
}
