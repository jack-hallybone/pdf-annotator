import type { PdfAnnotation } from './types';

// Host capabilities are all optional callbacks: the workspace only shows the
// corresponding UI (Save, Download, Print, Save As, image/merge pickers,
// external-link opener) when the host supplies one. They are plain functions
// rather than { method } objects so every capability has the same shape.

// A save target may optionally return a refreshed `fileKey` if the act of
// saving changed the underlying file's identity (e.g. its mtime/size, for a
// local-file adapter) - without this, the tabbed shell's already-open-file
// dedup check would stop recognizing a saved file as itself the next time
// it's reopened. See PdfHostDocument.fileKey in tabbedapp/fileHost.ts for
// the full contract.
export type PdfSaveTarget = (
  bytes: Uint8Array
) => Promise<{ fileKey?: string } | void>;

export type PdfDownloadTarget = (
  bytes: Uint8Array,
  suggestedName: string
) => Promise<void> | void;

export type PdfPrintTarget = (
  bytes: Uint8Array,
  suggestedName: string
) => Promise<void> | void;

export type PdfSaveAsResult = {
  bytes: Uint8Array;
  // Must identify "this is the same underlying file" for the tabbed shell's
  // already-open-tab dedup check (see PdfHostDocument.fileKey), recomputed
  // for the file this Save As just created/overwrote - not carried over from
  // whatever was open before. See browserFileKey() in browserFileAdapter.ts
  // for a reference implementation.
  fileKey?: string;
  fileName?: string;
  saveTarget?: PdfSaveTarget | null;
};

export type PdfSaveAsTarget = (
  createBytes: () => Promise<Uint8Array>,
  suggestedName: string
) => Promise<PdfSaveAsResult | null | undefined>;

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
