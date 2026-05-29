import type { PDFPageProxy } from 'pdfjs-dist';

export type Tool =
  | 'select'
  | 'highlight'
  | 'textHighlight'
  | 'freehandHighlight'
  | 'draw'
  | 'freeText'
  | 'stickyNote'
  | 'eraser'
  | 'lasso';

export type PdfPoint = {
  x: number;
  y: number;
};

export type PdfRect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type ToolSettings = {
  highlightColor: [number, number, number];
  highlightOpacity: number;
  highlightWidth: number;
  drawColor: [number, number, number];
  drawOpacity: number;
  drawWidth: number;
  eraserWidth: number;
  textColor: [number, number, number];
  textFontSize: number;
  textOpacity: number;
  noteColor: [number, number, number];
};

export type TextHighlightAnnotation = {
  id: string;
  sourceId?: string;
  kind: 'textHighlight';
  pageIndex: number;
  rects: PdfRect[];
  quadPoints: number[][];
  color: [number, number, number];
  opacity: number;
  contents: string;
};

export type InkAnnotation = {
  id: string;
  sourceId?: string;
  kind: 'draw' | 'freehandHighlight';
  pageIndex: number;
  paths: PdfPoint[][];
  color: [number, number, number];
  opacity: number;
  width: number;
  contents: string;
  filled?: boolean;
};

export type FreeTextAnnotation = {
  id: string;
  sourceId?: string;
  kind: 'freeText';
  pageIndex: number;
  rect: PdfRect;
  text: string;
  fontSize: number;
  color: [number, number, number];
  opacity: number;
};

export type StickyNoteAnnotation = {
  id: string;
  sourceId?: string;
  kind: 'stickyNote';
  pageIndex: number;
  rect: PdfRect;
  text: string;
  color: [number, number, number];
};

export type PdfAnnotation =
  | TextHighlightAnnotation
  | InkAnnotation
  | FreeTextAnnotation
  | StickyNoteAnnotation;

export type PageViewport = ReturnType<PDFPageProxy['getViewport']>;
export type LoadedPage = PDFPageProxy | null;

export type PageSize = {
  width: number;
  height: number;
};

export type ToolPresetMap = Record<string, Partial<ToolSettings>>;

export type PageRenderPriority = 'visible' | 'near' | 'idle';
