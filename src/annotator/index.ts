import './styles.css';

export { PdfWorkspace as PdfAnnotatorWorkspace, PdfWorkspace } from './PdfWorkspace';
export { readPdfFile } from './pdfFile';
export type {
  PdfSaveTarget,
  PdfWorkspaceHandle,
  PdfWorkspaceProps,
  PdfWorkspaceSession,
  PdfWorkspaceSource
} from './PdfWorkspace';
export type {
  FreeTextAnnotation,
  InkAnnotation,
  PdfAnnotation,
  PdfPoint,
  PdfRect,
  StickyNoteAnnotation,
  TextHighlightAnnotation,
  Tool,
  ToolSettings
} from './types';
