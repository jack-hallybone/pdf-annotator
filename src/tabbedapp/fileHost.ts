import type {
  PdfDownloadTarget,
  PdfImageFilePicker,
  PdfMergeFilePicker,
  PdfPrintTarget,
  PdfSaveAsTarget,
  PdfWorkspaceSourceInput
} from '../annotator';

export type PdfHostDocument = {
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
