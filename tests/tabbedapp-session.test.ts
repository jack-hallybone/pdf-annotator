import assert from "node:assert/strict";
import test from "node:test";
import { composeTabbedAppSession } from "../src/tabbedapp/tabbedAppSession";
import { markNonSerializable } from "../src/pdfdocumenteditor/sensitiveSession";
import type { SensitivePdfDocumentEditorSession } from "../src/pdfdocumenteditor/PdfDocumentEditor";
import { defaultToolSettings } from "../src/pdfdocumenteditor/toolSettings";

function documentEditorSession(): SensitivePdfDocumentEditorSession {
  return markNonSerializable({
    annotations: [],
    cleanAnnotations: [],
    cleanWorkSignature: "sig",
    fileName: "document.pdf",
    hasUnsavedChanges: false,
    importedAnnotationPageIndexes: [],
    managedAnnotationPageIndexes: [],
    pdfBytes: new Uint8Array([37, 80, 68, 70]),
    pdfFingerprint: "fp",
    redoStack: [],
    removedAnnotationSourceIds: [],
    shouldImportAnnotations: true,
    sourceId: "source-1",
    undoStack: [],
    view: { activePageIndex: 0, scale: 1 },
    version: 1,
  });
}

const chrome = {
  activeToolKey: "pen-2",
  annotationFilter: { bookmarkedOnly: false, colorKeys: [] },
  showAnnotations: true,
  sidebarOpen: true,
  sidebarTab: "annotations" as const,
  sidebarWidth: 200,
  toolPresets: {},
  toolSettings: defaultToolSettings,
};

// Composing the two halves of a cached tab spreads the core's session, and a
// spread does not carry a non-enumerable property - which is exactly what the
// "never serialize" guard is.
test("a composed tabbedapp session still refuses to be serialized", () => {
  const session = composeTabbedAppSession(documentEditorSession(), chrome);
  assert.throws(() => JSON.stringify(session));
  assert.throws(() => JSON.stringify({ tabs: [session] }));
});

test("a composed tabbedapp session carries both halves", () => {
  const session = composeTabbedAppSession(documentEditorSession(), chrome);
  assert.equal(session.sourceId, "source-1");
  assert.equal(session.chrome.activeToolKey, "pen-2");
  assert.equal(session.chrome.sidebarWidth, 200);
  assert.equal(session.chrome.sidebarTab, "annotations");
});
