import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  attachPdfSourceId,
  PdfDocumentEditorViewport,
  readPdfFile,
  usePdfDocumentEditor,
} from "../../src/pdfdocumenteditor";
import type {
  PdfDocumentEditorHandle,
  PdfDocumentEditorSource,
  PdfDocumentEditorViewState,
  Tool,
} from "../../src/pdfdocumenteditor";

// This reaches for src/pdfdocumenteditor's barrel and nothing else, so a binding split
// view needs but the core does not export would fail to compile.

// Every entry is a read of a view's own state or a call on its handle, never a
// back channel: a harness that copied anything between the views would be
// answering its own question.
type SplitViewControls = {
  activePageIndex: (view: ViewId) => number;
  annotationCount: (view: ViewId) => number;
  canUndo: (view: ViewId) => boolean;
  handle: (view: ViewId) => PdfDocumentEditorHandle | null;
  loadedPageIndexes: (view: ViewId) => number[];
  pageCount: (view: ViewId) => number;
  pageLoaded: (view: ViewId, pageIndex: number) => boolean;
  ready: () => boolean;
  saveFrom: (view: ViewId) => Promise<{ digest: string; length: number }>;
  scale: (view: ViewId) => number;
  setTool: (tool: Tool) => void;
};

type ViewId = "a" | "b";

declare global {
  interface Window {
    splitViewHarness?: SplitViewControls;
  }
}

function SplitView({ source }: { source: PdfDocumentEditorSource }) {
  const [tool, setTool] = useState<Tool>("select");
  const handles = useRef<Record<ViewId, PdfDocumentEditorHandle | null>>({
    a: null,
    b: null,
  });
  const viewStates = useRef<Record<ViewId, PdfDocumentEditorViewState | null>>({
    a: null,
    b: null,
  });
  const documentEditorModel = usePdfDocumentEditor({
    onClose: () => {},
    onNotice: (message) => {
      // The core draws no banner of its own, so a host that swallows this swallows
      // every "could not save this file" the save path raises.
      console.warn(`[split-harness] ${message}`);
    },
    source,
  });

  const controls: SplitViewControls = {
    activePageIndex: (view) => viewStates.current[view]?.activePageIndex ?? -1,
    annotationCount: (view) => {
      const state = viewStates.current[view];
      if (!state) {
        return -1;
      }

      let total = 0;
      for (const annotations of state.annotationsByPage.values()) {
        total += annotations.length;
      }
      return total;
    },
    canUndo: (view) => viewStates.current[view]?.canUndo ?? false,
    handle: (view) => handles.current[view],
    loadedPageIndexes: (view) => {
      const pages = viewStates.current[view]?.pages ?? [];
      const loaded: number[] = [];
      pages.forEach((page, pageIndex) => {
        if (page) {
          loaded.push(pageIndex);
        }
      });
      return loaded;
    },
    pageCount: (view) => viewStates.current[view]?.pages.length ?? -1,
    pageLoaded: (view, pageIndex) =>
      Boolean(viewStates.current[view]?.pages[pageIndex]),
    ready: () =>
      Boolean(viewStates.current.a?.ready && viewStates.current.b?.ready),
    saveFrom: async (view) => {
      const saved: Uint8Array[] = [];
      await handles.current[view]?.saveWith(async (bytes) => {
        saved.push(bytes);
      });
      const captured = saved[0];
      if (!captured) {
        return { digest: "", length: 0 };
      }

      const hash = await crypto.subtle.digest(
        "SHA-256",
        captured.slice().buffer as ArrayBuffer,
      );
      return {
        digest: [...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
        length: captured.length,
      };
    },
    scale: (view) => viewStates.current[view]?.scale ?? -1,
    setTool,
  };

  // Everything it closes over is a ref or a stable setter, so one mount-time
  // assignment stays current.
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  useLayoutEffect(() => {
    window.splitViewHarness = controlsRef.current;
    return () => {
      delete window.splitViewHarness;
    };
  }, []);

  const pane = (view: ViewId) => (
    <div className="split-harness-pane" data-view={view}>
      <PdfDocumentEditorViewport
        className="split-harness-view"
        document={documentEditorModel}
        manageDocumentTitle={false}
        onToolChange={setTool}
        ref={(handle) => {
          handles.current[view] = handle;
        }}
        tool={tool}
      >
        {(state) => {
          // The overlay slot is where a host reads the view state. A ref write during
          // render, deliberately: there is nothing to paint.
          viewStates.current[view] = state;
          return null;
        }}
      </PdfDocumentEditorViewport>
    </div>
  );

  return (
    <div className="split-harness">
      {pane("a")}
      {pane("b")}
    </div>
  );
}

function Harness() {
  const [source, setSource] = useState<PdfDocumentEditorSource | null>(null);

  return (
    <>
      <input
        className="split-harness-input"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }

          setSource(
            attachPdfSourceId(
              { bytes: await readPdfFile(file), name: file.name },
              `split-harness:${file.name}`,
            ),
          );
        }}
        type="file"
      />
      {source ? <SplitView source={source} /> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
