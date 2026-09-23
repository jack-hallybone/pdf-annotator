import type { PdfAnnotation } from "./types";

// Host capabilities are all optional callbacks: the core shows the
// corresponding UI only when the host supplies one.

// Returns a refreshed `fileKey` when saving changed the file's identity, or
// the shell's already-open-file dedup stops recognizing the file as itself.
export type PdfSaveTarget = (
  bytes: Uint8Array,
) => Promise<{ fileKey?: string } | void>;

export type PdfSaveStage =
  "permission" | "preflight" | "write" | "close" | "verify" | "post-save";

// A save target may fail after bytes are already committed, so the UI never
// promises an original is unchanged when it cannot know that.
export class PdfSaveError extends Error {
  mayHaveCommitted: boolean;
  stage: PdfSaveStage;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      mayHaveCommitted: boolean;
      stage: PdfSaveStage;
    },
  ) {
    super(message, { cause: options.cause });
    this.mayHaveCommitted = options.mayHaveCommitted;
    this.name = "PdfSaveError";
    this.stage = options.stage;
  }
}

export type PdfDownloadTarget = (
  bytes: Uint8Array,
  suggestedName: string,
) => Promise<void> | void;

export type PdfPrintTarget = (
  bytes: Uint8Array,
  suggestedName: string,
) => Promise<void> | void;

/** A refreshed file identity, and the target that writes this file again. */
export type PdfSaveWithResult = {
  fileKey?: string;
  saveTarget?: PdfSaveTarget | null;
};

export type PdfSaveAsResult = {
  bytes: Uint8Array;
  // Recomputed for the file this Save As created or overwrote, never carried
  // over from what was open before.
  fileKey?: string;
  fileName?: string;
  saveTarget?: PdfSaveTarget | null;
};

export type PdfSaveAsTarget = (
  createBytes: () => Promise<Uint8Array>,
  suggestedName: string,
) => Promise<PdfSaveAsResult | null | undefined>;

export type PdfExternalLinkContext = {
  fileName: string;
  sourceId: string;
};

export type PdfExternalLinkOpener = (
  url: string,
  context: PdfExternalLinkContext,
) => Promise<void> | void;

export type PdfImageFilePicker = () => Promise<File | null | undefined>;

export type PdfMergeFile = {
  bytes: Uint8Array;
  name: string;
};

export type PdfMergeFilePicker = () => Promise<PdfMergeFile | null | undefined>;

/* A document's own write targets are not here: they belong to the file, and
 * live on PdfDocumentEditorSource. */
export type PdfDocumentEditorCapabilities = {
  pickImageFile?: PdfImageFilePicker;
  pickMergePdfFile?: PdfMergeFilePicker;
  printTarget?: PdfPrintTarget | null;
};

/* The chrome adds opening a link; the core only reports that one was clicked,
   because where a reader is sent is the host's decision. */
export type PdfDocumentEditorHostCapabilities =
  PdfDocumentEditorCapabilities & {
    onOpenExternalLink?: PdfExternalLinkOpener;
  };

type PdfDocumentEditorSourceBase = {
  initialAnnotations?: PdfAnnotation[];
  markDirty?: boolean;
  name: string;
  downloadTarget?: PdfDownloadTarget | null;
  fileKey?: string;
  saveAsTarget?: PdfSaveAsTarget | null;
  saveTarget?: PdfSaveTarget | null;
  sourceId: string;
};

export type PdfDocumentEditorBytesSource = PdfDocumentEditorSourceBase & {
  bytes: Uint8Array;
  kind?: "bytes";
};

export type PdfDocumentEditorLoaderSource = PdfDocumentEditorSourceBase & {
  kind: "loader";
  loadBytes: () => Promise<Uint8Array>;
};

export type PdfDocumentEditorSource =
  PdfDocumentEditorBytesSource | PdfDocumentEditorLoaderSource;

export type PdfDocumentEditorSourceInput =
  | Omit<PdfDocumentEditorBytesSource, "sourceId">
  | Omit<PdfDocumentEditorLoaderSource, "sourceId">;

export function attachPdfSourceId(
  source: PdfDocumentEditorSourceInput,
  sourceId: string,
): PdfDocumentEditorSource {
  return { ...source, sourceId };
}
