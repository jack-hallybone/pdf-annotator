// Order matters: the core's sheet declares the tokens the chrome overrides.
import "../pdfdocumenteditor/styles.css";
import "./styles.css";

export { TabbedAppDocument } from "./TabbedAppDocument";
export { TabbedAppShell } from "./TabbedAppShell";
export { TabbedAppNoticeStack } from "./components/TabbedAppNotices";
export {
  attachPdfSourceId,
  createPdfFileLoader,
  PdfSaveError,
  readPdfFile,
} from "../pdfdocumenteditor";
export type { TabbedAppNotice } from "./components/TabbedAppNotices";
export type {
  TabbedAppDocumentChromeState,
  TabbedAppDocumentHandle,
  TabbedAppDocumentProps,
  SensitiveTabbedAppDocumentSession,
} from "./TabbedAppDocument";
export type {
  TabbedAppCloseDocumentsRequest,
  TabbedAppOpenDocumentSummary,
  TabbedAppHomeRenderProps,
  TabbedAppShellHandle,
  TabbedAppShellProps,
  TabbedAppTemplateAction,
  TabbedAppDocumentOptions,
} from "./TabbedAppShell";
export type {
  TabbedAppHostAdapter,
  TabbedAppHostDocument,
  TabbedAppHostFileInput,
  TabbedAppHostPickResult,
} from "./fileHost";
export type {
  PdfDocumentEditorCloseRequest,
  PdfDocumentEditorSource,
  PdfDocumentEditorSourceInput,
  PdfDocumentEditorHostCapabilities,
  PdfDownloadTarget,
  PdfExternalLinkContext,
  PdfExternalLinkOpener,
  PdfImageFilePicker,
  PdfMergeFile,
  PdfMergeFilePicker,
  PdfPrintTarget,
  PdfSaveAsResult,
  PdfSaveAsTarget,
  PdfSaveStage,
  PdfSaveTarget,
  PdfSaveWithResult,
} from "../pdfdocumenteditor";
export type { AnnotationListFilter } from "./annotationList";
export type { PdfAnnotation, Tool, ToolSettings } from "../pdfdocumenteditor";
