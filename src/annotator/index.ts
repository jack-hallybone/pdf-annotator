import './styles.css';

export { PdfWorkspace as PdfAnnotatorWorkspace, PdfWorkspace } from './PdfWorkspace';
export { attachPdfSourceId } from './host';
export { createPdfFileLoader, readPdfFile } from './pdfFile';
export type { AppTheme } from '../theme';
export type {
  PdfExternalLinkContext,
  PdfExternalLinkOpener,
  PdfImageFilePicker,
  PdfDownloadTarget,
  PdfMergeFile,
  PdfMergeFilePicker,
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
  PdfWorkspaceCloseRequest,
  PdfWorkspaceHandle,
  PdfWorkspaceHistoryEntry,
  PdfWorkspaceProps,
  PdfWorkspaceTabCacheSession,
  PdfWorkspaceViewPosition
} from './PdfWorkspace';
export type { PdfWorkspaceReadOnlyReason } from './pdfProtection';
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
