import type { PDFPageProxy } from "pdfjs-dist";

export type Tool =
  | "select"
  | "highlight"
  | "textHighlight"
  | "freehandHighlight"
  | "draw"
  | "freeText"
  | "imageStamp"
  | "stickyNote"
  | "eraser"
  | "lasso";

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

/**
 * `comment` is the annotation's /Contents, the reader's own note, never the
 * text it sits on: that is `coveredText`, re-derived and never written.
 */
export type TextHighlightAnnotation = {
  id: string;
  sourceId?: string;
  bookmarked?: boolean;
  kind: "textHighlight";
  pageIndex: number;
  rects: PdfRect[];
  quadPoints: number[][];
  color: [number, number, number];
  opacity: number;
  comment: string;
  coveredText?: string;
};

export type InkAnnotation = {
  id: string;
  sourceId?: string;
  bookmarked?: boolean;
  kind: "draw" | "freehandHighlight";
  pageIndex: number;
  paths: PdfPoint[][];
  color: [number, number, number];
  opacity: number;
  width: number;
  comment: string;
  filled?: boolean;
};

export type FreeTextAnnotation = {
  id: string;
  sourceId?: string;
  bookmarked?: boolean;
  kind: "freeText";
  pageIndex: number;
  rect: PdfRect;
  text: string;
  fontSize: number;
  color: [number, number, number];
  opacity: number;
  layoutWidth?: number;
  // Clockwise degrees (0/90/180/270), independent of the page's own rotation.
  rotation?: number;
};

export type StickyNoteAnnotation = {
  id: string;
  sourceId?: string;
  bookmarked?: boolean;
  kind: "stickyNote";
  pageIndex: number;
  rect: PdfRect;
  text: string;
  color: [number, number, number];
};

export type ImageStampAnnotation = {
  id: string;
  sourceId?: string;
  bookmarked?: boolean;
  kind: "imageStamp";
  pageIndex: number;
  rect: PdfRect;
  comment: string;
  imageData: string;
  mimeType: "image/png";
  widthPx: number;
  heightPx: number;
  // Clockwise degrees (0/90/180/270), independent of the page's own rotation.
  rotation?: number;
};

export type PdfAnnotation =
  | TextHighlightAnnotation
  | InkAnnotation
  | FreeTextAnnotation
  | StickyNoteAnnotation
  | ImageStampAnnotation;

export type PageViewport = ReturnType<PDFPageProxy["getViewport"]>;
export type LoadedPage = PDFPageProxy | null;

/**
 * A range rather than a page number: how many pages a view displays is a
 * property of its height and zoom alone, and a band around an active page is
 * wrong about every other pane.
 */
export type VisiblePageRange = {
  /** Last page displayed, inclusive, and never less than `start`. */
  end: number;
  start: number;
};

export type PageDisplaySize = {
  height: number;
  width: number;
};

export type PageSize = {
  width: number;
  height: number;
};

export type ToolPresetMap = Record<string, Partial<ToolSettings>>;

export type PageRenderPriority = "visible" | "near" | "idle";
