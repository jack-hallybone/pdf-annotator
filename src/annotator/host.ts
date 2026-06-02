import type { PdfAnnotation } from './types';

export type PdfSaveTarget = {
  save: (bytes: Uint8Array) => Promise<void>;
};

export type PdfExternalLinkContext = {
  fileName: string;
  sourceId: string;
};

export type PdfExternalLinkOpener = (
  url: string,
  context: PdfExternalLinkContext
) => Promise<void> | void;

type PdfWorkspaceSourceBase = {
  initialAnnotations?: PdfAnnotation[];
  markDirty?: boolean;
  name: string;
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
