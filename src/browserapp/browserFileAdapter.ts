import { createPdfFileLoader } from '../annotator';
import type { PdfSaveTarget } from '../annotator';
import type { PdfHostAdapter, PdfHostDocument } from '../tabbedapp';
import {
  canPickLocalPdfFile,
  localPdfFilesFromDrop,
  pickLocalPdfFiles,
  savePdfToLocalFile
} from './localFileAccess';
import type { LocalPdfFileHandle } from './localFileAccess';

type BrowserPdfFile = {
  file: File;
  handle?: LocalPdfFileHandle | null;
};

export const browserFileAdapter: PdfHostAdapter = {
  fileInput: {
    accept: 'application/pdf',
    multiple: true
  },
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
        saveTarget: handle ? browserFileSaveTarget(handle) : null
      },
      title: file.name
    }));
}

function filesToBrowserFiles(files: FileList | File[]) {
  return Array.from(files).map((file) => ({ file }));
}

function browserFileSaveTarget(
  fileHandle: LocalPdfFileHandle
): PdfSaveTarget {
  return {
    save: (bytes) => savePdfToLocalFile(fileHandle, bytes)
  };
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
