import type {
  PdfDownloadTarget,
  PdfDocumentEditorHostCapabilities,
  PdfSaveAsTarget,
  PdfDocumentEditorSourceInput,
} from "./index";

export type TabbedAppHostDocument = {
  // Must identify "this is the same underlying file", so an already-open
  // document is refocused rather than duplicated.
  fileKey?: string;
  source: PdfDocumentEditorSourceInput;
  title?: string;
};

export type TabbedAppHostPickResult = {
  documents: TabbedAppHostDocument[];
  useFileInputFallback?: boolean;
};

export type TabbedAppHostFileInput = {
  accept: string;
  multiple?: boolean;
};

// `downloadTarget` and `saveAsTarget` here are defaults, for a document that
// arrives with none of its own.
export type TabbedAppHostAdapter = PdfDocumentEditorHostCapabilities & {
  fileInput?: TabbedAppHostFileInput;
  /**
   * Must read everything it needs off `dataTransfer` before it awaits
   * anything: one `await` later its items and its files are both empty.
   */
  pdfDocumentsFromDrop?: (
    dataTransfer: DataTransfer,
  ) => Promise<TabbedAppHostDocument[]>;
  pdfDocumentsFromFileInput?: (files: File[]) => TabbedAppHostDocument[];
  pickPdfDocuments: () => Promise<TabbedAppHostPickResult>;
  downloadTarget?: PdfDownloadTarget | null;
  saveAsTarget?: PdfSaveAsTarget | null;
};
