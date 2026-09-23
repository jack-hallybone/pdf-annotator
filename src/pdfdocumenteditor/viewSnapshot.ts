/*
 * A second view of the same document has its own answer for every field here,
 * so useDocumentModel carries a snapshot beside the document state it parks,
 * never inside it.
 */

/** A scroll position expressed against a page, so it survives a zoom change. */
export type PdfDocumentEditorViewPosition = {
  offsetRatio: number;
  pageIndex: number;
  scrollLeftRatio: number;
};

/**
 * `scale` is always captured but applied only where a zoom change is part of
 * the restore: putting a tab back on screen is, undoing a page deletion is not.
 */
export type PdfDocumentEditorViewSnapshot = {
  activePageIndex: number;
  scale: number;
  viewPosition?: PdfDocumentEditorViewPosition;
};
