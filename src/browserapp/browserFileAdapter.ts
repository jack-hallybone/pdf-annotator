import { createPdfFileLoader } from '../annotator';
import type { PdfDownloadTarget, PdfSaveTarget } from '../annotator';
import type { PdfHostAdapter, PdfHostDocument } from '../tabbedapp';
import {
  canPickLocalPdfFile,
  canSaveLocalPdfFileAs,
  localPdfFilesFromDrop,
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
  const blob = new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(suggestedName);
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

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function safeDownloadName(name: string) {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || 'annotated.pdf';
}
