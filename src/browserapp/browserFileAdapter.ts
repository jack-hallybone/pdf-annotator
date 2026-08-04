import { createPdfFileLoader, readPdfFile } from '../workspace';
import type {
  PdfDownloadTarget,
  PdfSaveAsTarget,
  PdfSaveTarget
} from '../workspace';
import { uint8ArrayToArrayBuffer } from '../bytes';
import { safePdfFileName } from '../fileNames';
import type { PdfHostAdapter, PdfHostDocument } from '../tabbedapp';
import { browserPrintTarget } from './browserPrintTarget';
import {
  canPickLocalPdfFile,
  canSaveLocalPdfFileAs,
  fingerprintPdfBytes,
  fingerprintPdfFile,
  localPdfFilesFromDrop,
  localPdfFilesFromHandles,
  pickLocalPdfSaveFile,
  pickLocalImageFile,
  pickLocalPdfFiles,
  savePdfToLocalFile
} from './localFileAccess';
import type { LocalPdfFileHandle } from './localFileAccess';
import { browserFileHandleKey } from './browserFileIdentity';

type BrowserPdfFile = {
  file: File;
  fileKey?: string;
  handle?: LocalPdfFileHandle | null;
};

export const browserFileAdapter: PdfHostAdapter = {
  downloadTarget: browserFileDownloadTarget(),
  fileInput: {
    accept: 'application/pdf',
    multiple: true
  },
  saveAsTarget: browserFileSaveAsTarget(),
  async pickPdfDocuments() {
    if (!canPickLocalPdfFile()) {
      return { documents: [], useFileInputFallback: true };
    }

    const pickedFiles = await pickLocalPdfFiles();
    return {
      documents: await browserHandleFilesToHostDocuments(pickedFiles)
    };
  },
  pickMergePdfFile: browserPickMergePdfFile,
  pickImageFile: browserPickImageFile,
  printTarget: browserPrintTarget(),
  async pdfDocumentsFromDrop(dataTransfer) {
    try {
      const localFiles = await localPdfFilesFromDrop(dataTransfer);
      if (localFiles.length > 0) {
        return browserHandleFilesToHostDocuments(localFiles);
      }
    } catch {
      // Falls back to the plain File-object path below, which still opens
      // the dropped file(s) - just without in-place-save support for them.
    }

    return browserFilesToHostDocuments(filesToBrowserFiles(dataTransfer.files));
  },
  pdfDocumentsFromFileInput(files) {
    return browserFilesToHostDocuments(filesToBrowserFiles(files));
  }
};

export async function browserFileHandlesToHostDocuments(
  handles: LocalPdfFileHandle[]
) {
  return browserHandleFilesToHostDocuments(
    await localPdfFilesFromHandles(handles)
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
        name: file.name
      }
    : null;
}

async function browserHandleFilesToHostDocuments(files: BrowserPdfFile[]) {
  const keyedFiles = await Promise.all(
    files.map(async (file) => ({
      ...file,
      fileKey: file.handle
        ? await browserFileHandleKey(file.handle)
        : undefined
    }))
  );
  return browserFilesToHostDocuments(keyedFiles);
}

function browserFilesToHostDocuments(
  files: BrowserPdfFile[]
): PdfHostDocument[] {
  return files
    .filter(({ file }) => isPdfFile(file))
    .map(({ file, fileKey, handle }, index) => ({
      fileKey,
      source: {
        kind: 'loader',
        loadBytes: createPdfFileLoader(file, { preload: index === 0 }),
        name: file.name,
        saveAsTarget: browserFileAdapter.saveAsTarget ?? null,
        saveTarget: handle
          ? createBrowserPdfSaveTarget(handle, file, fileKey)
          : null
      },
      title: file.name
    }));
}

function filesToBrowserFiles(files: FileList | File[]) {
  return Array.from(files).map((file) => ({ file }));
}

function pickImageFileWithInput() {
  return pickFilesWithInput({
    accept: 'image/png,image/jpeg,image/webp',
    multiple: false
  }).then((files) => files[0] ?? null);
}

function pickPdfFilesWithInput({ multiple }: { multiple: boolean }) {
  return pickFilesWithInput({ accept: 'application/pdf', multiple });
}

function pickFilesWithInput({
  accept,
  multiple
}: {
  accept: string;
  multiple: boolean;
}) {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.accept = accept;
    input.multiple = multiple;
    input.type = 'file';
    input.style.display = 'none';

    function cleanup(files: File[]) {
      window.setTimeout(() => {
        input.remove();
        resolve(files);
      }, 0);
    }

    input.addEventListener(
      'change',
      () => cleanup(Array.from(input.files ?? [])),
      { once: true }
    );
    input.addEventListener('cancel', () => cleanup([]), { once: true });

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
    const savedFile = await handle.getFile();
    const fileKey = await browserFileHandleKey(handle);
    const saveTarget = createBrowserPdfSaveTarget(handle, savedFile, fileKey);
    return {
      bytes,
      fileKey,
      fileName: handle.name,
      saveTarget
    };
  };
}

export function createBrowserPdfSaveTarget(
  fileHandle: LocalPdfFileHandle,
  initialFile: File,
  initialFileKey?: string
): PdfSaveTarget {
  let expectedVersion = pdfFileVersion(initialFile);
  let expectedFingerprint: Promise<string> | null = null;
  const getExpectedFingerprint = () => {
    expectedFingerprint ??= fingerprintPdfFile(initialFile);
    return expectedFingerprint;
  };
  const lockName = `pdf-annotator:file-write:${fileHandle.name
    .normalize('NFC')
    .toLocaleLowerCase()}`;
  const fileKeyRequest = initialFileKey
    ? Promise.resolve(initialFileKey)
    : browserFileHandleKey(fileHandle);

  return (bytes) =>
    withBrowserFileLock(lockName, async () => {
      const currentFile = await fileHandle.getFile();
      if (!samePdfFileVersion(expectedVersion, pdfFileVersion(currentFile))) {
        throw new Error(
          'The PDF changed outside this window. Use Save As to avoid overwriting newer changes.'
        );
      }

      await savePdfToLocalFile(fileHandle, bytes, {
        expectedCurrentFingerprint: await getExpectedFingerprint()
      });
      const savedFile = await fileHandle.getFile();
      expectedVersion = pdfFileVersion(savedFile);
      expectedFingerprint = fingerprintPdfBytes(bytes);
      // Return the stable entry-identity key so the shell keeps the same tab
      // identity after Save changes the file's size and modified time.
      return { fileKey: await fileKeyRequest };
    });
}

type BrowserLockManager = {
  request: <T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T>
  ) => Promise<T>;
};

function withBrowserFileLock<T>(name: string, task: () => Promise<T>) {
  const locks =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { locks?: BrowserLockManager }).locks;
  return locks ? locks.request(name, { mode: 'exclusive' }, task) : task();
}

function pdfFileVersion(file: File) {
  return { lastModified: file.lastModified, size: file.size };
}

function samePdfFileVersion(
  expected: ReturnType<typeof pdfFileVersion>,
  current: ReturnType<typeof pdfFileVersion>
) {
  return (
    expected.lastModified === current.lastModified &&
    expected.size === current.size
  );
}

function browserFileDownloadTarget(): PdfDownloadTarget {
  return browserDownloadPdf;
}

function browserDownloadPdf(bytes: Uint8Array, suggestedName: string) {
  const blob = new Blob([uint8ArrayToArrayBuffer(bytes)], {
    type: 'application/pdf'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safePdfFileName(suggestedName);
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function isPdfFile(file: File) {
  return (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  );
}
