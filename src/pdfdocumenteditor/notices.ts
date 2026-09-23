/**
 * How the core reports something to its host: it raises notices and never
 * renders them.
 */
export type PdfDocumentEditorNoticeTone = "danger" | "warning" | "success";

export type PdfDocumentEditorNoticeOptions = {
  /** Milliseconds before the notice removes itself; `null` means never. */
  durationMs?: number | null;
  tone?: PdfDocumentEditorNoticeTone;
};

export type PdfDocumentEditorNoticeReporter = (
  message: string,
  options?: PdfDocumentEditorNoticeOptions,
) => void;
