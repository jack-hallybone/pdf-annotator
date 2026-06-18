import { createPdfFileLoader, readPdfFile } from '../annotator';
import type {
  PdfDownloadTarget,
  PdfSaveAsTarget,
  PdfSaveTarget
} from '../annotator';
import { uint8ArrayToArrayBuffer } from '../bytes';
import { safePdfFileName } from '../fileNames';
import type { PdfHostAdapter, PdfHostDocument } from '../tabbedapp';
import { browserPrintTarget } from './browserPrintTarget';
import {
  canPickLocalPdfFile,
  canSaveLocalPdfFileAs,
  localPdfFilesFromDrop,
  pickLocalPdfSaveFile,
  pickLocalImageFile,
  pickLocalPdfFiles,
  savePdfToLocalFile
} from './localFileAccess';
import type { LocalPdfFileHandle } from './localFileAccess';

type BrowserPdfFile = {
  file: File;
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
    return { documents: browserFilesToHostDocuments(pickedFiles) };
  },
  pickMergePdfFile: browserPickMergePdfFile,
  pickImageFile: browserPickImageFile,
  printTarget: browserPrintTarget(),
  async pdfDocumentsFromDrop(dataTransfer) {
    try {
      const localFiles = await localPdfFilesFromDrop(dataTransfer);
      if (localFiles.length > 0) {
        return browserFilesToHostDocuments(localFiles);
      }
    } catch (error) {
      console.error(error);
    }

    return browserFilesToHostDocuments(filesToBrowserFiles(dataTransfer.files));
  },
  pdfDocumentsFromFileInput(files) {
    return browserFilesToHostDocuments(filesToBrowserFiles(files));
  }
};

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

function browserFilesToHostDocuments(
  files: BrowserPdfFile[]
): PdfHostDocument[] {
  return files
    .filter(({ file }) => isPdfFile(file))
    .map(({ file, handle }, index) => ({
      fileKey: pdfFileKey(file),
      source: {
        kind: 'loader',
        fileKey: pdfFileKey(file),
        loadBytes: createPdfFileLoader(file, { preload: index === 0 }),
        name: file.name,
        saveAsTarget: browserFileAdapter.saveAsTarget ?? null,
        saveTarget: handle ? browserFileSaveTarget(handle) : null
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

  return {
    async saveAs(createBytes, suggestedName: string) {
      const handle = await pickLocalPdfSaveFile(suggestedName);
      if (!handle) {
        return null;
      }

      const bytes = await createBytes();
      await savePdfToLocalFile(handle, bytes);
      return {
        bytes,
        fileKey: await pdfFileKeyForHandle(handle),
        fileName: handle.name,
        saveTarget: browserFileSaveTarget(handle)
      };
    }
  };
}

function browserFileSaveTarget(
  fileHandle: LocalPdfFileHandle
): PdfSaveTarget {
  return {
    save: (bytes) => savePdfToLocalFile(fileHandle, bytes)
  };
}

function browserFileDownloadTarget(): PdfDownloadTarget {
  return {
    download: browserDownloadPdf
  };
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

function pdfFileKey(file: File) {
  return [
    file.webkitRelativePath || '',
    file.name,
    String(file.size),
    String(file.lastModified)
  ].join('\u001f');
}

async function pdfFileKeyForHandle(handle: LocalPdfFileHandle) {
  try {
    return pdfFileKey(await handle.getFile());
  } catch {
    return ['local-handle', handle.name].join('\u001f');
  }
}
