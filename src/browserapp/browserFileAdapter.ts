import { createPdfFileLoader } from '../annotator';
import type { PdfDownloadTarget, PdfSaveTarget } from '../annotator';
import { uint8ArrayToArrayBuffer } from '../bytes';
import { safePdfFileName } from '../fileNames';
import type { PdfHostAdapter, PdfHostDocument } from '../tabbedapp';
import {
  canPickLocalPdfFile,
  canSaveLocalPdfFileAs,
  localPdfFilesFromDrop,
  pickLocalImageFile,
  pickLocalPdfFiles,
  savePdfAsLocalFile,
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
  pickImageFile: browserPickImageFile,
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

function browserFilesToHostDocuments(
  files: BrowserPdfFile[]
): PdfHostDocument[] {
  return files
    .filter(({ file }) => isPdfFile(file))
    .map(({ file, handle }, index) => ({
      fileKey: pdfFileKey(file),
      source: {
        kind: 'loader',
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
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.accept = 'image/png,image/jpeg,image/webp';
    input.type = 'file';
    input.style.display = 'none';

    function cleanup(file: File | null) {
      window.setTimeout(() => {
        input.remove();
        resolve(file);
      }, 0);
    }

    input.addEventListener(
      'change',
      () => cleanup(input.files?.[0] ?? null),
      { once: true }
    );
    input.addEventListener('cancel', () => cleanup(null), { once: true });

    document.body.append(input);
    input.click();
  });
}

function browserFileSaveAsTarget() {
  if (!canSaveLocalPdfFileAs()) {
    return null;
  }

  return {
    async saveAs(bytes: Uint8Array, suggestedName: string) {
      const handle = await savePdfAsLocalFile(bytes, suggestedName);
      return handle
        ? {
            fileName: handle.name,
            saveTarget: browserFileSaveTarget(handle)
          }
        : null;
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
