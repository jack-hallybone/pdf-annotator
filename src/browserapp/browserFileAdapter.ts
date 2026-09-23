// Never src/pdfdocumenteditor's barrel: it re-exports PdfDocumentEditor, and this file is
// in the initial chunk.
import { createPdfFileLoader, readPdfFile } from "../pdfdocumenteditor/pdfFile";
import type { PdfSaveAsTarget, PdfSaveTarget } from "../tabbedapp";
import { PdfSaveError } from "../pdfdocumenteditor/host";
import type { TabbedAppHostAdapter, TabbedAppHostDocument } from "../tabbedapp";
import { browserPrintTarget } from "./browserPrintTarget";
import {
  canPickLocalPdfFile,
  canSaveLocalPdfFileAs,
  downloadPdfBytes,
  fingerprintPdfBytes,
  fingerprintPdfFile,
  isPdfFile,
  localPdfFilesFromDrop,
  localPdfFilesFromHandles,
  readDroppedFiles,
  pickLocalPdfSaveFile,
  pickLocalImageFile,
  pickLocalPdfFiles,
  savePdfToLocalFile,
} from "./localFileAccess";
import type { LocalPdfFileHandle } from "./localFileAccess";
import { browserFileHandleKey } from "./browserFileIdentity";
import { PACKAGE_NAME } from "../packageName";

type BrowserPdfFile = {
  file: File;
  fileKey?: string;
  handle?: LocalPdfFileHandle | null;
};

export const browserFileAdapter: TabbedAppHostAdapter = {
  downloadTarget: downloadPdfBytes,
  fileInput: {
    accept: "application/pdf",
    multiple: true,
  },
  saveAsTarget: browserFileSaveAsTarget(),
  async pickPdfDocuments() {
    if (!canPickLocalPdfFile()) {
      return { documents: [], useFileInputFallback: true };
    }

    const pickedFiles = await pickLocalPdfFiles();
    return {
      documents: await browserHandleFilesToHostDocuments(pickedFiles),
    };
  },
  pickMergePdfFile: browserPickMergePdfFile,
  pickImageFile: browserPickImageFile,
  printTarget: browserPrintTarget(),
  async pdfDocumentsFromDrop(dataTransfer) {
    // Must stay the first statement and the only one touching `dataTransfer`:
    // the run up to the first `await` is the whole window a drop answers in.
    const dropped = readDroppedFiles(dataTransfer);

    try {
      const localFiles = await localPdfFilesFromDrop(dropped);
      if (localFiles.length > 0) {
        return browserHandleFilesToHostDocuments(localFiles);
      }
    } catch {
      // The plain File path below still opens them, without in-place save.
    }

    return browserFilesToHostDocuments(filesToBrowserFiles(dropped.files));
  },
  pdfDocumentsFromFileInput(files) {
    return browserFilesToHostDocuments(filesToBrowserFiles(files));
  },
};

export async function browserFileHandlesToHostDocuments(
  handles: LocalPdfFileHandle[],
) {
  return browserHandleFilesToHostDocuments(
    await localPdfFilesFromHandles(handles),
  );
}

async function browserPickImageFile() {
  if (canPickLocalPdfFile()) {
    return pickLocalImageFile();
  }

  return pickImageFileWithInput();
}

async function browserPickMergePdfFile() {
  const files = canPickLocalPdfFile()
    ? await pickLocalPdfFiles({ multiple: false })
    : filesToBrowserFiles(await pickPdfFilesWithInput({ multiple: false }));
  const file = files.find(({ file }) => isPdfFile(file))?.file;
  return file
    ? {
        bytes: await readPdfFile(file),
        name: file.name,
      }
    : null;
}

async function browserHandleFilesToHostDocuments(files: BrowserPdfFile[]) {
  const keyedFiles = await Promise.all(
    files.map(async (file) => ({
      ...file,
      fileKey: file.handle
        ? await browserFileHandleKey(file.handle)
        : undefined,
    })),
  );
  return browserFilesToHostDocuments(keyedFiles);
}

function browserFilesToHostDocuments(
  files: BrowserPdfFile[],
): TabbedAppHostDocument[] {
  return files
    .filter(({ file }) => isPdfFile(file))
    .map(({ file, fileKey, handle }, index) => ({
      fileKey,
      source: {
        kind: "loader",
        loadBytes: createPdfFileLoader(file, { preload: index === 0 }),
        name: file.name,
        saveAsTarget: browserFileAdapter.saveAsTarget ?? null,
        saveTarget: handle
          ? createBrowserPdfSaveTarget(handle, file, fileKey)
          : null,
      },
      title: file.name,
    }));
}

function filesToBrowserFiles(files: FileList | File[]) {
  return Array.from(files).map((file) => ({ file }));
}

function pickImageFileWithInput() {
  return pickFilesWithInput({
    accept: "image/png,image/jpeg,image/webp",
    multiple: false,
  }).then((files) => files[0] ?? null);
}

function pickPdfFilesWithInput({ multiple }: { multiple: boolean }) {
  return pickFilesWithInput({ accept: "application/pdf", multiple });
}

function pickFilesWithInput({
  accept,
  multiple,
}: {
  accept: string;
  multiple: boolean;
}) {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.accept = accept;
    input.multiple = multiple;
    input.type = "file";
    input.style.display = "none";

    function cleanup(files: File[]) {
      window.setTimeout(() => {
        input.remove();
        resolve(files);
      }, 0);
    }

    input.addEventListener(
      "change",
      () => cleanup(Array.from(input.files ?? [])),
      { once: true },
    );
    input.addEventListener("cancel", () => cleanup([]), { once: true });

    document.body.append(input);
    input.click();
  });
}

function browserFileSaveAsTarget(): PdfSaveAsTarget | null {
  if (!canSaveLocalPdfFileAs()) {
    return null;
  }

  return async (createBytes, suggestedName: string) => {
    const handle = await pickLocalPdfSaveFile(suggestedName);
    if (!handle) {
      return null;
    }

    const bytes = await createBytes();
    await savePdfToLocalFile(handle, bytes);
    let savedFile: File;
    let fileKey: string;
    try {
      savedFile = await handle.getFile();
      fileKey = await browserFileHandleKey(handle);
    } catch (error) {
      throw new PdfSaveError(
        "The PDF was saved and verified, but its file identity could not be refreshed.",
        { cause: error, mayHaveCommitted: true, stage: "post-save" },
      );
    }
    const saveTarget = createBrowserPdfSaveTarget(handle, savedFile, fileKey);
    return {
      bytes,
      fileKey,
      fileName: handle.name,
      saveTarget,
    };
  };
}

function createBrowserPdfSaveTarget(
  fileHandle: LocalPdfFileHandle,
  initialFile: File,
  initialFileKey?: string,
): PdfSaveTarget {
  let expectedVersion = pdfFileVersion(initialFile);
  let expectedFingerprint: Promise<string> | null = null;
  const getExpectedFingerprint = () => {
    expectedFingerprint ??= fingerprintPdfFile(initialFile);
    return expectedFingerprint;
  };
  const lockName = `${PACKAGE_NAME}:file-write:${fileHandle.name
    .normalize("NFC")
    .toLocaleLowerCase()}`;
  const fileKeyRequest = initialFileKey
    ? Promise.resolve(initialFileKey)
    : browserFileHandleKey(fileHandle);

  return (bytes) =>
    withBrowserFileLock(lockName, async () => {
      const currentFile = await fileHandle.getFile();
      if (!samePdfFileVersion(expectedVersion, pdfFileVersion(currentFile))) {
        throw new Error(
          "The PDF changed outside this window. Use Save As to avoid overwriting newer changes.",
        );
      }

      await savePdfToLocalFile(fileHandle, bytes, {
        expectedCurrentFingerprint: await getExpectedFingerprint(),
      });
      try {
        const savedFile = await fileHandle.getFile();
        expectedVersion = pdfFileVersion(savedFile);
        expectedFingerprint = fingerprintPdfBytes(bytes);
        // The entry-identity key: Save changes size and modified time.
        return { fileKey: await fileKeyRequest };
      } catch (error) {
        throw new PdfSaveError(
          "The PDF was saved and verified, but its file identity could not be refreshed.",
          { cause: error, mayHaveCommitted: true, stage: "post-save" },
        );
      }
    });
}

type BrowserLockManager = {
  request: <T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ) => Promise<T>;
};

function withBrowserFileLock<T>(name: string, task: () => Promise<T>) {
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { locks?: BrowserLockManager }).locks;
  return locks ? locks.request(name, { mode: "exclusive" }, task) : task();
}

function pdfFileVersion(file: File) {
  return { lastModified: file.lastModified, size: file.size };
}

function samePdfFileVersion(
  expected: ReturnType<typeof pdfFileVersion>,
  current: ReturnType<typeof pdfFileVersion>,
) {
  return (
    expected.lastModified === current.lastModified &&
    expected.size === current.size
  );
}
