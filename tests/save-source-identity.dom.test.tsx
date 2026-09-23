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
import type { PdfDocumentEditorSource } from "../src/pdfdocumenteditor/host";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import type { PdfDocumentEditorViewBridge } from "../src/pdfdocumenteditor/useDocumentModel";
import type { PdfDocumentEditorViewSnapshot } from "../src/pdfdocumenteditor/viewSnapshot";

// The document model's own save and annotation-save-identity.test.ts's parked
// one keep their own copies of the same steps, and the defect lived in the step
// they share: the saved bytes become the baseline without being re-imported.

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

test("the model's own save resolves the second edit in the file it just wrote", async () => {
  const written: Uint8Array[] = [];
  const { result } = await mountWithNotes(["A", "B", "C"], written);
  const model = () => result.current.model;

  const [a, b] = model().annotations;
  assert.deepEqual(
    model().annotations.map((annotation) => annotation.sourceId),
    ["direct:0:0", "direct:0:1", "direct:0:2"],
  );

  await act(async () => {
    model().removedAnnotationSourceIdsRef.current.add(a.sourceId!);
    model().commitAnnotations((annotations) =>
      annotations
        .filter((annotation) => annotation.id !== a.id)
        .map((annotation) =>
          annotation.id === b.id && annotation.kind === "stickyNote"
            ? { ...annotation, text: "B edited" }
            : annotation,
        ),
    );
  });
  await act(async () => {
    assert.equal(await model().handleSave(), true);
  });

  assert.deepEqual(await noteTexts(written.at(-1)!), ["B edited", "C"]);
  assert.deepEqual(
    model().annotations.map((annotation) => annotation.sourceId),
    ["direct:0:0", "direct:0:1"],
  );
  assert.deepEqual([...model().removedAnnotationSourceIdsRef.current], []);

  await act(async () => {
    model().commitAnnotations((annotations) =>
      annotations.map((annotation) =>
        annotation.id === b.id && annotation.kind === "stickyNote"
          ? { ...annotation, text: "B edited twice" }
          : annotation,
      ),
    );
  });
  await act(async () => {
    assert.equal(
      await model().saveThroughHostWriter(async (bytes) => {
        written.push(bytes);
      }),
      true,
    );
  });

  assert.deepEqual(await noteTexts(written.at(-1)!), ["B edited twice", "C"]);
});

// The first save takes the annotation's dictionary out of the file, and
// restating that identity as `unresolved:shifted:` put an identity nothing can
// match onto the annotation the undo brings back, stopping the next save for the
// whole document.
test("a note deleted, saved and undone is written fresh by the next save", async () => {
  const { sourceIdBeforeDelete } = await deleteSaveUndoSave(directNotesPdf);
  assert.equal(sourceIdBeforeDelete, "direct:0:0");
});

test("the same sequence over an indirect reference", async () => {
  const { sourceIdBeforeDelete } = await deleteSaveUndoSave(indirectNotesPdf);
  assert.match(sourceIdBeforeDelete, /^\d+R\d*$/);
});

async function deleteSaveUndoSave(
  makeFixture: (contents: string[]) => Promise<Uint8Array>,
) {
  const written: Uint8Array[] = [];
  const notices: string[] = [];
  const { result } = await mountWithNotes(
    ["A", "B", "C"],
    written,
    notices,
    makeFixture,
  );
  const model = () => result.current.model;
  const [deleted] = model().annotations;
  const sourceIdBeforeDelete = deleted.sourceId!;

  await act(async () => {
    model().managedAnnotationPagesRef.current.add(deleted.pageIndex);
    model().removedAnnotationSourceIdsRef.current.add(sourceIdBeforeDelete);
    model().commitAnnotations((annotations) =>
      annotations.filter((annotation) => annotation.id !== deleted.id),
    );
  });
  await act(async () => {
    assert.equal(await model().handleSave(), true);
  });
  assert.deepEqual(await noteTexts(written.at(-1)!), ["B", "C"]);

  await act(async () => {
    await model().undoHistory();
  });
  assert.deepEqual(model().annotations.map(noteText).sort(), ["A", "B", "C"]);

  await act(async () => {
    assert.equal(
      await model().handleSave(),
      true,
      `the save was refused: ${notices.join(" / ")}`,
    );
  });
  assert.deepEqual((await noteTexts(written.at(-1)!)).sort(), ["A", "B", "C"]);
  assert.equal(
    model().annotations.find((annotation) => annotation.id === deleted.id)
      ?.sourceId,
    undefined,
  );

  await act(async () => {
    assert.equal(await model().handleSave(), true);
  });
  assert.deepEqual((await noteTexts(written.at(-1)!)).sort(), ["A", "B", "C"]);

  assert.deepEqual(notices, []);
  return { sourceIdBeforeDelete };
}

function noteText(annotation: PdfAnnotation) {
  return annotation.kind === "stickyNote" ? annotation.text : "";
}

async function mountWithNotes(
  contents: string[],
  written: Uint8Array[],
  notices: string[] = [],
  makeFixture: (contents: string[]) => Promise<Uint8Array> = directNotesPdf,
) {
  const bytes = await makeFixture(contents);
  const harness = renderHook(() => useModelHarness(bytes, written, notices));
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
  await waitFor(
    () => {
      assert.equal(
        harness.result.current.model.annotations.length,
        contents.length,
      );
    },
    { timeout: 15_000 },
  );
  return harness;
}

function useModelHarness(
  bytes: Uint8Array,
  written: Uint8Array[],
  notices: string[],
) {
  const view = useStubView();
  const source = useRef<PdfDocumentEditorSource>({
    bytes,
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
    onNotice: (message: string) => {
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

async function directNotesPdf(contents: string[]) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
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
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function indirectNotesPdf(contents: string[]) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { context } = pdfDoc;
  page.node.set(
    PDFName.of("Annots"),
    context.obj(
      contents.map((text, index) =>
        context.register(
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
    ),
  );
  return pdfDoc.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function noteTexts(bytes: Uint8Array) {
  const pdfDoc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const annots = pdfDoc.getPage(0).node.Annots();
  const texts: string[] = [];
  for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
    const dict = annots?.lookupMaybe(index, PDFDict);
    if (
      dict?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() !== "Text"
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
}
