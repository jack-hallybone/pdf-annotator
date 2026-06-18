import type { PdfAnnotation } from './types';

export type PdfSaveTarget = {
  save: (bytes: Uint8Array) => Promise<void>;
};

export type PdfDownloadTarget = {
  download: (bytes: Uint8Array, suggestedName: string) => Promise<void> | void;
};

export type PdfPrintTarget = {
  print: (bytes: Uint8Array, suggestedName: string) => Promise<void> | void;
};

export type PdfSaveAsResult = {
  bytes: Uint8Array;
  fileKey?: string;
  fileName?: string;
  saveTarget?: PdfSaveTarget | null;
};

export type PdfSaveAsTarget = {
  saveAs: (
    createBytes: () => Promise<Uint8Array>,
    suggestedName: string
  ) => Promise<PdfSaveAsResult | null | undefined>;
};

export type PdfExternalLinkContext = {
  fileName: string;
  sourceId: string;
};

export type PdfExternalLinkOpener = (
  url: string,
  context: PdfExternalLinkContext
) => Promise<void> | void;

export type PdfImageFilePicker = () => Promise<File | null | undefined>;

export type PdfMergeFile = {
  bytes: Uint8Array;
  name: string;
};

export type PdfMergeFilePicker = () => Promise<
  PdfMergeFile | null | undefined
>;

type PdfWorkspaceSourceBase = {
  initialAnnotations?: PdfAnnotation[];
  markDirty?: boolean;
  name: string;
  downloadTarget?: PdfDownloadTarget | null;
  fileKey?: string;
  saveAsTarget?: PdfSaveAsTarget | null;
  saveTarget?: PdfSaveTarget | null;
  sourceId: string;
};

export type PdfWorkspaceBytesSource = PdfWorkspaceSourceBase & {
  bytes: Uint8Array;
  kind?: 'bytes';
};

export type PdfWorkspaceLoaderSource = PdfWorkspaceSourceBase & {
  kind: 'loader';
  loadBytes: () => Promise<Uint8Array>;
};

export type PdfWorkspaceSource =
  | PdfWorkspaceBytesSource
  | PdfWorkspaceLoaderSource;

export type PdfWorkspaceSourceInput =
  | Omit<PdfWorkspaceBytesSource, 'sourceId'>
  | Omit<PdfWorkspaceLoaderSource, 'sourceId'>;

export function attachPdfSourceId(
  source: PdfWorkspaceSourceInput,
  sourceId: string
): PdfWorkspaceSource {
  return { ...source, sourceId };
}
