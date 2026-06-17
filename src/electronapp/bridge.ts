export type DesktopPdfDocument = {
  bytes: Uint8Array;
  fileKey: string;
  fileId: string;
  name: string;
};

export type DesktopImageFile = {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
};

export type DesktopSaveAsResult = {
  fileId: string;
  name: string;
};

export type DesktopBridge = {
  downloadPdf: (bytes: Uint8Array, suggestedName: string) => Promise<void>;
  onOpenPdfFiles: (
    callback: (documents: DesktopPdfDocument[]) => void
  ) => () => void;
  onRequestClose: (callback: () => boolean | Promise<boolean>) => () => void;
  openExternalLink: (url: string) => Promise<void>;
  pickImageFile: () => Promise<DesktopImageFile | null>;
  pickPdfFiles: () => Promise<DesktopPdfDocument[]>;
  printPdf: (bytes: Uint8Array, suggestedName: string) => Promise<void>;
  savePdf: (fileId: string, bytes: Uint8Array) => Promise<void>;
  savePdfAs: (
    bytes: Uint8Array,
    suggestedName: string
  ) => Promise<DesktopSaveAsResult | null>;
};

declare global {
  interface Window {
    pdfAnnotatorDesktop?: DesktopBridge;
  }
}
