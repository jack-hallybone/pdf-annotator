import "./styles.css";

/**
 * The first line here loads the theme and the core stylesheet, which is why a
 * module tested under plain node imports the core module directly.
 */
export { PdfDocumentEditor } from "./PdfDocumentEditor";

/* Two views over one document: one usePdfDocumentEditor, many viewports. */
export { PdfDocumentEditorViewport } from "./PdfDocumentEditor";
export { useDocumentModel as usePdfDocumentEditor } from "./useDocumentModel";
export { attachPdfSourceId, PdfSaveError } from "./host";
export { createPdfFileLoader, readPdfFile } from "./pdfFile";
export { markNonSerializable } from "./sensitiveSession";
export { canCreateOutputCopy, canEditReadOnlyCopy } from "./readOnlyPolicy";
export { usesAnnotationLayer } from "./pdfDocumentEditorHelpers";
export { annotationColors, foregroundOn, rgbToHex } from "./annotationColors";

/* Comments and flags: the model, with the host drawing the editor. */
export {
  annotationCommentText,
  annotationCoveredText,
  annotationSupportsComment,
  MAX_ANNOTATION_COMMENT_LENGTH,
} from "./annotationComments";

/* Saving a tab that is not on screen, from its parked session. */
export {
  documentEditorSessionAfterSave,
  documentEditorSessionOutput,
} from "./sessionOutput";
export { safePdfExternalUrl } from "./pdfLinks";
export { defaultToolSettings } from "./toolSettings";

/* Shared with the in-viewport popover, so the two cannot drift apart. */
export {
  ColorPalette,
  NumberSetting,
  SettingsPanelShell,
} from "./SettingsPanel";

/* Page geometry and raster helpers, for chrome drawing its own view. */
export { FREE_TEXT_LINE_HEIGHT, freeTextVisualLines } from "./freeTextLayout";
export {
  annotationContentTransform,
  pathToViewportD,
  pdfRectToViewportRect,
} from "./pdfGeometry";
/* Where an annotation sits, for a host listing them in reading order. */
export { annotationBounds } from "./annotationGeometry";
export {
  cachedPageBaseRenderMode,
  cachePageBaseRenderMode,
  canvasLooksEmpty,
  pageHasRenderableContent,
  releaseCanvasBuffer,
  safeCanvasPixelRatio,
} from "./pdfRender";
export {
  clamp,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
} from "./viewerConfig";

export type { RgbColor } from "./annotationColors";
export type { PdfOutlineEntry } from "./pdfOutline";
export type {
  PdfDocumentEditorNoticeOptions,
  PdfDocumentEditorNoticeReporter,
  PdfDocumentEditorNoticeTone,
} from "./notices";
export type {
  PdfDocumentEditorCapabilities,
  PdfExternalLinkContext,
  PdfExternalLinkOpener,
  PdfDocumentEditorHostCapabilities,
  PdfImageFilePicker,
  PdfDownloadTarget,
  PdfMergeFile,
  PdfMergeFilePicker,
  PdfPrintTarget,
  PdfSaveAsResult,
  PdfSaveAsTarget,
  PdfSaveStage,
  PdfSaveTarget,
  PdfSaveWithResult,
  PdfDocumentEditorBytesSource,
  PdfDocumentEditorLoaderSource,
  PdfDocumentEditorSource,
  PdfDocumentEditorSourceInput,
} from "./host";
export type {
  PdfDocumentEditorHistorySnapshot,
  PdfDocumentEditorCloseRequest,
  PdfDocumentEditorModel,
  PdfDocumentEditorSharedProps,
  PdfDocumentEditorViewportProps,
  PdfDocumentEditorHandle,
  PdfDocumentEditorHistoryEntry,
  PdfDocumentEditorProps,
  PdfDocumentEditorReadOnlyState,
  PdfDocumentEditorViewState,
  SensitivePdfDocumentEditorSession,
  PdfDocumentEditorViewPosition,
  PdfDocumentEditorViewSnapshot,
} from "./PdfDocumentEditor";
export type { PdfDocumentEditorReadOnlyReason } from "./pdfProtection";
export type { SplitAxis } from "./useSplitResizer";
export type {
  FreeTextAnnotation,
  ImageStampAnnotation,
  InkAnnotation,
  LoadedPage,
  PageSize,
  PageViewport,
  PdfAnnotation,
  PdfPoint,
  PdfRect,
  StickyNoteAnnotation,
  TextHighlightAnnotation,
  Tool,
  ToolPresetMap,
  ToolSettings,
} from "./types";
