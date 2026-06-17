import './styles.css';

export { PdfWorkspace as PdfAnnotatorWorkspace, PdfWorkspace } from './PdfWorkspace';
export { attachPdfSourceId } from './host';
export { createPdfFileLoader, readPdfFile } from './pdfFile';
export type {
  PdfExternalLinkContext,
  PdfExternalLinkOpener,
  PdfImageFilePicker,
  PdfDownloadTarget,
  PdfPrintTarget,
  PdfSaveAsResult,
  PdfSaveAsTarget,
  PdfSaveTarget,
  PdfWorkspaceBytesSource,
  PdfWorkspaceLoaderSource,
  PdfWorkspaceSource,
  PdfWorkspaceSourceInput
} from './host';
export type {
  PdfWorkspaceDocumentHistorySnapshot,
  PdfWorkspaceHandle,
  PdfWorkspaceHistoryEntry,
  PdfWorkspaceProps,
  PdfWorkspaceReadOnlyReason,
  PdfWorkspaceSession,
  PdfWorkspaceViewPosition
} from './PdfWorkspace';
export type {
  FreeTextAnnotation,
  ImageStampAnnotation,
  InkAnnotation,
  PdfAnnotation,
  PdfPoint,
  PdfRect,
  StickyNoteAnnotation,
  TextHighlightAnnotation,
  Tool,
  ToolSettings
} from './types';
