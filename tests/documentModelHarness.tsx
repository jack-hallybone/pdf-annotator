// The document owner, mounted on its own with a stub viewport, shared by
// use-document-model.dom.test.tsx and history-invariant.dom.test.tsx.
import assert from "node:assert/strict";
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { PDFDocument } from "pdf-lib";
import "./rendererAssetStubs";
import type {
  PdfDocumentEditorSource,
  PdfMergeFilePicker,
} from "../src/pdfdocumenteditor/host";
import type { SensitivePdfDocumentEditorSession } from "../src/pdfdocumenteditor/useDocumentModel";
import type { PdfDocumentEditorViewBridge } from "../src/pdfdocumenteditor/useDocumentModel";
import type { PdfDocumentEditorViewSnapshot } from "../src/pdfdocumenteditor/viewSnapshot";

// pdf.js's browser entry touches DOMMatrix/ImageData/Path2D while it is
// evaluated, even with nothing rendering to a canvas.
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

// pdfRender sets GlobalWorkerOptions.workerSrc as a module side effect, from the
// Vite `?url` asset rendererAssetStubs has to stub away, so by the time the
// import above returns workerSrc names a stub module.
const { GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

export async function onePagePdf() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]);
  return pdfDoc.save({ useObjectStreams: false });
}

export const STUB_VIEW: PdfDocumentEditorViewSnapshot = {
  activePageIndex: 3,
  scale: 1.75,
  viewPosition: { offsetRatio: 0.25, pageIndex: 3, scrollLeftRatio: 0.5 },
};

export const SECOND_STUB_VIEW: PdfDocumentEditorViewSnapshot = {
  activePageIndex: 9,
  scale: 0.5,
  viewPosition: { offsetRatio: 0.75, pageIndex: 9, scrollLeftRatio: 0 },
};

type StubView = {
  bridge: RefObject<PdfDocumentEditorViewBridge>;
  readinessResets: RefObject<number[]>;
  scaleRef: RefObject<number>;
};

function useStubView(snapshot: PdfDocumentEditorViewSnapshot): StubView {
  const activePageIndexRef = useRef(snapshot.activePageIndex);
  const visiblePageRangeRef = useRef({
    end: snapshot.activePageIndex,
    start: snapshot.activePageIndex,
  });
  const [, setActivePageIndex] = useState(snapshot.activePageIndex);
  const [, setSelectedAnnotationIds] = useState<string[]>([]);
  const [, setFocusedAnnotationId] = useState<string | null>(null);
  const readinessResets = useRef<number[]>([]);
  const scaleRef = useRef(snapshot.scale);
  const bridge = useRef<PdfDocumentEditorViewBridge>({
    activePageIndex: snapshot.activePageIndex,
    activePageIndexRef,
    captureViewSnapshot: () => snapshot,
    clearInitialVisualReadiness: () => {},
    markInitialAnnotationsReady: () => {},
    resetInitialVisualReadiness: (pageIndex = 0) => {
      readinessResets.current.push(pageIndex);
    },
    restoreViewPosition: () => {},
    revealPreparationError: () => {},
    runAfterInitialVisualReady: (callback: () => void) => callback(),
    setActivePageIndex,
    setFocusedAnnotationId,
    setScale: (nextScale: number) => {
      scaleRef.current = nextScale;
    },
    setSelectedAnnotationIds,
    visiblePageRangeRef,
  });

  return { bridge, readinessResets, scaleRef };
}

function useModelHarness(
  bytes: Uint8Array,
  viewCount = 1,
  name = "harness.pdf",
  notices: string[] = [],
  initialSession: SensitivePdfDocumentEditorSession | null = null,
  pickMergePdfFile: PdfMergeFilePicker | undefined = undefined,
) {
  const first = useStubView(STUB_VIEW);
  const second = useStubView(SECOND_STUB_VIEW);
  const source = useRef<PdfDocumentEditorSource>({
    bytes,
    name,
    sourceId: "harness-1",
  });
  const model = useDocumentModel({
    allowEditing: true,
    allowImageAnnotations: false,
    initialSession,
    manageDocumentTitle: false,
    onClose: () => {},
    onNotice: (message: string) => {
      notices.push(message);
    },
    pickMergePdfFile,
    printTarget: null,
    showAnnotations: true,
    source: source.current,
  });
  const { attachView } = model;

  useLayoutEffect(() => {
    const detach = [attachView(first.bridge)];
    if (viewCount > 1) {
      detach.push(attachView(second.bridge));
    }
    return () => {
      for (const release of detach) {
        release();
      }
    };
  }, [attachView, first.bridge, second.bridge, viewCount]);

  return { first, model, scaleRef: first.scaleRef, second };
}

export async function mountRefusedModel(bytes: Uint8Array) {
  const harness = renderHook(() => useModelHarness(bytes));
  await waitFor(
    () => {
      assert.ok(
        harness.result.current.model.loadError,
        "the document loaded instead of being refused",
      );
    },
    { timeout: 30_000 },
  );
  return harness;
}

export async function mountLoadedModel(
  viewCount = 1,
  name?: string,
  bytes?: Uint8Array,
  notices: string[] = [],
  // A parked tab being put back: the restore is a separate push path into the
  // history stacks, the one place a stack arrives from outside this hook.
  initialSession: SensitivePdfDocumentEditorSession | null = null,
  // The host's own file picker for a merge: the one await inside any of the five
  // page operations that a test can hold open.
  pickMergePdfFile: PdfMergeFilePicker | undefined = undefined,
) {
  const loaded = bytes ?? (await onePagePdf());
  const harness = renderHook(() =>
    useModelHarness(
      loaded,
      viewCount,
      name,
      notices,
      initialSession,
      pickMergePdfFile,
    ),
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
  return harness;
}
