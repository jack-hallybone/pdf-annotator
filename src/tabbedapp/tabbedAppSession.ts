import { markNonSerializable } from "../pdfdocumenteditor/sensitiveSession";
import type { AnnotationListFilter } from "./annotationList";
import type { DocumentSidebarTab } from "./components/DocumentSidebar";
import type { SensitivePdfDocumentEditorSession } from "../pdfdocumenteditor/PdfDocumentEditor";
import type { ToolPresetMap, ToolSettings } from "../pdfdocumenteditor/types";

/** The half of a cached tab that belongs to the chrome, not the document. */
export type TabbedAppDocumentChromeState = {
  activeToolKey: string;
  annotationFilter: AnnotationListFilter;
  showAnnotations: boolean;
  sidebarOpen: boolean;
  sidebarTab: DocumentSidebarTab;
  sidebarWidth: number;
  toolPresets: ToolPresetMap;
  toolSettings: ToolSettings;
};

// Sensitive, in-memory only: never log, transmit, store or persist one.
export type SensitiveTabbedAppDocumentSession =
  SensitivePdfDocumentEditorSession & {
    chrome: TabbedAppDocumentChromeState;
  };

/**
 * The spread is the dangerous part: the core's throwing `toJSON` is
 * non-enumerable, so spreading a session drops it and leaves a plain object of
 * PDF bytes that `JSON.stringify` will happily serialise.
 */
export function composeTabbedAppSession(
  session: SensitivePdfDocumentEditorSession,
  chrome: TabbedAppDocumentChromeState,
): SensitiveTabbedAppDocumentSession {
  return markNonSerializable<SensitiveTabbedAppDocumentSession>({
    ...session,
    chrome,
  });
}
