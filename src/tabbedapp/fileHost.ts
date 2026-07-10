import type {
  PdfDownloadTarget,
  PdfImageFilePicker,
  PdfMergeFilePicker,
  PdfPrintTarget,
  PdfSaveAsTarget,
  PdfWorkspaceSourceInput
} from '../workspace';

export type PdfHostDocument = {
  // Must identify "this is the same underlying file" - used to detect that a
  // file being opened is already open in another tab and refocus it instead
  // of duplicating the tab. An adapter that never sets this (or sets it
  // inconsistently across pdfDocumentsFromDrop/pdfDocumentsFromFileInput/
  // pickPdfDocuments, or fails to recompute it after a save via
  // PdfSaveTarget/PdfSaveAsResult) will silently disable dedup instead of
  // erroring - see browserFileKey() in browserapp/browserFileAdapter.ts for
  // a reference implementation (name+size+lastModified, synchronous since
  // pdfDocumentsFromFileInput can't be async).
  fileKey?: string;
  readOnly?: boolean;
  readOnlyMessage?: string;
  source: PdfWorkspaceSourceInput;
  title?: string;
};

export type PdfHostPickResult = {
  documents: PdfHostDocument[];
  useFileInputFallback?: boolean;
};

export type PdfHostFileInput = {
  accept: string;
  multiple?: boolean;
};

export type PdfHostAdapter = {
  fileInput?: PdfHostFileInput;
  pdfDocumentsFromDrop?: (
    dataTransfer: DataTransfer
  ) => Promise<PdfHostDocument[]>;
  pdfDocumentsFromFileInput?: (files: File[]) => PdfHostDocument[];
  pickPdfDocuments: () => Promise<PdfHostPickResult>;
  pickImageFile?: PdfImageFilePicker;
  pickMergePdfFile?: PdfMergeFilePicker;
  downloadTarget?: PdfDownloadTarget | null;
  printTarget?: PdfPrintTarget | null;
  saveAsTarget?: PdfSaveAsTarget | null;
};
