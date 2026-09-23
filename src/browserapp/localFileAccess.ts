import { uint8ArrayToArrayBuffer } from "../bytes";
import { safePdfFileName } from "../fileNames";
// Initial-chunk code, so never src/pdfdocumenteditor's barrel: it would drag PDF.js in.
import { PdfSaveError } from "../pdfdocumenteditor/host";

export type LocalPdfFileHandle = {
  kind: "file";
  name: string;
  createWritable: (
    options?: LocalCreateWritableOptions,
  ) => Promise<LocalWritableFileStream>;
  getFile: () => Promise<File>;
  queryPermission?: (
    descriptor?: LocalFilePermissionDescriptor,
  ) => Promise<PermissionState>;
  requestPermission?: (
    descriptor?: LocalFilePermissionDescriptor,
  ) => Promise<PermissionState>;
  isSameEntry?: (other: LocalPdfFileHandle) => Promise<boolean>;
};

type LocalFilePermissionDescriptor = {
  mode?: "read" | "readwrite";
};

type LocalWritableFileStream = {
  abort?: () => Promise<void>;
  close: () => Promise<void>;
  write: (data: Blob) => Promise<void>;
};

type LocalCreateWritableOptions = {
  keepExistingData?: boolean;
  mode?: "exclusive" | "siloed";
};

type LocalWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (
      options?: LocalOpenFilePickerOptions,
    ) => Promise<LocalPdfFileHandle[]>;
    showSaveFilePicker?: (
      options?: LocalSaveFilePickerOptions,
    ) => Promise<LocalPdfFileHandle>;
  };

type LocalOpenFilePickerOptions = {
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  types?: Array<{
    accept: Record<string, string[]>;
    description?: string;
  }>;
};

type LocalSaveFilePickerOptions = Omit<
  LocalOpenFilePickerOptions,
  "multiple"
> & {
  suggestedName?: string;
};

type DataTransferItemWithFileSystemHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<unknown>;
};

const pdfPickerOptions: LocalOpenFilePickerOptions = {
  excludeAcceptAllOption: false,
  multiple: true,
  types: [
    {
      accept: {
        "application/pdf": [".pdf"],
      },
      description: "PDF files",
    },
  ],
};

const pdfSavePickerOptions: LocalSaveFilePickerOptions = {
  excludeAcceptAllOption: pdfPickerOptions.excludeAcceptAllOption,
  types: pdfPickerOptions.types,
};

const imagePickerOptions: LocalOpenFilePickerOptions = {
  excludeAcceptAllOption: false,
  multiple: false,
  types: [
    {
      accept: {
        "image/jpeg": [".jpg", ".jpeg"],
        "image/png": [".png"],
        "image/webp": [".webp"],
      },
      description: "Image files",
    },
  ],
};

export function canPickLocalPdfFile() {
  return typeof localWindow().showOpenFilePicker === "function";
}

export function canSaveLocalPdfFileAs() {
  return typeof localWindow().showSaveFilePicker === "function";
}

export async function pickLocalPdfFiles({
  multiple = true,
}: { multiple?: boolean } = {}) {
  const picker = localWindow().showOpenFilePicker;
  if (!picker) {
    return [];
  }

  try {
    const handles = await picker({ ...pdfPickerOptions, multiple });
    return localPdfFilesFromHandles(handles);
  } catch (error) {
    if (isPickerAbort(error)) {
      return [];
    }
    throw error;
  }
}

export async function pickLocalImageFile() {
  const picker = localWindow().showOpenFilePicker;
  if (!picker) {
    return null;
  }

  try {
    const [handle] = await picker(imagePickerOptions);
    const file = await handle?.getFile();
    return file && isSupportedImageFile(file) ? file : null;
  } catch (error) {
    if (isPickerAbort(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Everything a drop carries, taken off the drag data store synchronously: it
 * answers only while the drop event is being dispatched, so one `await` is
 * enough to leave `items`, `files` and every unasked handle empty.
 */
type DroppedFiles = {
  files: File[];
  handleRequests: Array<Promise<LocalPdfFileHandle | null>>;
};

export function readDroppedFiles(dataTransfer: DataTransfer): DroppedFiles {
  return {
    files: Array.from(dataTransfer.files ?? []),
    handleRequests: Array.from(dataTransfer.items ?? []).map((item) =>
      requestFileSystemHandle(item),
    ),
  };
}

export async function localPdfFilesFromDrop(dropped: DroppedFiles) {
  const handles = await Promise.all(dropped.handleRequests);
  return localPdfFilesFromHandles(handles.filter((handle) => handle !== null));
}

export async function savePdfToLocalFile(
  handle: LocalPdfFileHandle,
  bytes: Uint8Array,
  options: { expectedCurrentFingerprint?: string | null } = {},
) {
  try {
    await requestReadWritePermission(handle);
  } catch (error) {
    throw asPdfSaveError(error, "permission", false);
  }

  if (options.expectedCurrentFingerprint) {
    try {
      const currentFingerprint = await fingerprintPdfFile(
        await handle.getFile(),
      );
      if (currentFingerprint !== options.expectedCurrentFingerprint) {
        throw new Error(
          "The PDF changed outside this window. Use Save As to avoid overwriting newer changes.",
        );
      }
    } catch (error) {
      throw asPdfSaveError(error, "preflight", false);
    }
  }

  let writable: LocalWritableFileStream;
  try {
    writable = await createWritable(handle);
  } catch (error) {
    throw asPdfSaveError(error, "write", false);
  }

  try {
    await writable.write(pdfBlob(bytes));
  } catch (error) {
    await abortWritable(writable);
    throw asPdfSaveError(error, "write", false);
  }

  try {
    await writable.close();
  } catch (error) {
    await abortWritable(writable);
    // A rejected close may still have reached the filesystem commit point.
    throw asPdfSaveError(error, "close", true);
  }

  try {
    await verifySavedPdfBytes(handle, bytes);
  } catch (error) {
    throw asPdfSaveError(error, "verify", true);
  }
}

function asPdfSaveError(
  error: unknown,
  stage: ConstructorParameters<typeof PdfSaveError>[1]["stage"],
  mayHaveCommitted: boolean,
) {
  if (error instanceof PdfSaveError) {
    return error;
  }
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Could not save the PDF.";
  return new PdfSaveError(message, {
    cause: error,
    mayHaveCommitted,
    stage,
  });
}

export async function fingerprintPdfFile(file: File) {
  return fingerprintPdfBytes(new Uint8Array(await file.arrayBuffer()));
}

export async function fingerprintPdfBytes(bytes: Uint8Array) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Secure file fingerprinting is unavailable. Use Save As to avoid overwriting the original file.",
    );
  }

  const digest = await subtle.digest("SHA-256", arrayBufferForBytes(bytes));
  return hexBytes(new Uint8Array(digest));
}

export async function pickLocalPdfSaveFile(suggestedName: string) {
  const picker = localWindow().showSaveFilePicker;
  if (!picker) {
    return null;
  }

  try {
    return await picker({
      ...pdfSavePickerOptions,
      suggestedName,
    });
  } catch (error) {
    if (isPickerAbort(error)) {
      return null;
    }
    throw error;
  }
}

async function createWritable(handle: LocalPdfFileHandle) {
  try {
    return await handle.createWritable({ mode: "exclusive" });
  } catch (error) {
    if (error instanceof TypeError) {
      return handle.createWritable();
    }
    throw error;
  }
}

async function verifySavedPdfBytes(
  handle: LocalPdfFileHandle,
  expectedBytes: Uint8Array,
) {
  const savedFile = await handle.getFile();
  if (savedFile.size !== expectedBytes.byteLength) {
    throw new Error("Saved file verification failed: byte length mismatch.");
  }

  const reader = savedFile.stream().getReader();
  let offset = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== expectedBytes[offset + index]) {
          throw new Error("Saved file verification failed: byte mismatch.");
        }
      }
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (offset !== expectedBytes.byteLength) {
    throw new Error("Saved file verification failed: incomplete read.");
  }
}

// Called for every dropped item in one synchronous pass; only the awaiting is
// deferred.
function requestFileSystemHandle(item: DataTransferItem) {
  const getHandle = (item as DataTransferItemWithFileSystemHandle)
    .getAsFileSystemHandle;
  if (typeof getHandle !== "function") {
    return Promise.resolve(null);
  }

  return Promise.resolve(getHandle.call(item)).then(
    (handle) => (isPdfFileHandle(handle) ? handle : null),
    () => null,
  );
}

export async function localPdfFilesFromHandles(handles: LocalPdfFileHandle[]) {
  const files = await Promise.allSettled(
    handles.filter(isPdfFileHandle).map(async (handle) => ({
      file: await handle.getFile(),
      handle,
    })),
  );
  const readableFiles = files.flatMap((result) =>
    result.status === "fulfilled" && isPdfFile(result.value.file)
      ? [result.value]
      : [],
  );

  if (readableFiles.length === 0) {
    const failedRead = files.find((result) => result.status === "rejected");
    if (failedRead?.status === "rejected") {
      throw failedRead.reason;
    }
  }

  return readableFiles;
}

async function requestReadWritePermission(handle: LocalPdfFileHandle) {
  const descriptor: LocalFilePermissionDescriptor = { mode: "readwrite" };
  const current = await handle.queryPermission?.(descriptor);
  if (current === "granted") {
    return;
  }

  const requested = await handle.requestPermission?.(descriptor);
  if (requested && requested !== "granted") {
    throw new Error("Permission to save to the original file was not granted.");
  }
}

async function abortWritable(writable: LocalWritableFileStream) {
  try {
    await writable.abort?.();
  } catch {
    // The original save error is more useful to report.
  }
}

function isPdfFileHandle(handle: unknown): handle is LocalPdfFileHandle {
  const candidate = handle as Partial<LocalPdfFileHandle> | null;
  return (
    typeof handle === "object" &&
    handle !== null &&
    candidate?.kind === "file" &&
    typeof candidate.name === "string" &&
    typeof candidate.getFile === "function" &&
    typeof candidate.createWritable === "function"
  );
}

// The revoke is deferred a tick because Chrome cancels an in-flight
// navigation if the object URL dies in the same task.
export function downloadPdfBytes(bytes: Uint8Array, outputName: string) {
  const blob = new Blob([uint8ArrayToArrayBuffer(bytes)], {
    type: "application/pdf",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safePdfFileName(outputName);
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function isPdfFile(file: File) {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

function isSupportedImageFile(file: File) {
  return (
    ["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    /\.(jpe?g|png|webp)$/i.test(file.name)
  );
}

function pdfBlob(bytes: Uint8Array) {
  return new Blob([uint8ArrayToArrayBuffer(bytes)], {
    type: "application/pdf",
  });
}

function arrayBufferForBytes(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }

  return bytes.slice().buffer;
}

function hexBytes(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function isPickerAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function localWindow() {
  return typeof window === "undefined"
    ? ({} as LocalWindow)
    : (window as LocalWindow);
}
