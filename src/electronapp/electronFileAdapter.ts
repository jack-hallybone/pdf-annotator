import { readPdfFile } from '../annotator';
import type {
  PdfDownloadTarget,
  PdfSaveAsTarget,
  PdfSaveTarget
} from '../annotator';
import { uint8ArrayToArrayBuffer } from '../bytes';
import type { PdfHostAdapter, PdfHostDocument } from '../tabbedapp';
import type { DesktopBridge, DesktopPdfDocument } from './bridge';

export function hasDesktopBridge() {
  return Boolean(desktopBridge());
}

export const electronFileAdapter: PdfHostAdapter = {
  downloadTarget: electronDownloadTarget(),
  fileInput: {
    accept: 'application/pdf',
    multiple: true
  },
  saveAsTarget: electronSaveAsTarget(),
  async pickPdfDocuments() {
    const bridge = requireDesktopBridge();
    return {
      documents: desktopDocumentsToHostDocuments(await bridge.pickPdfFiles())
    };
  },
  pickImageFile: electronPickImageFile,
  async pdfDocumentsFromDrop(dataTransfer) {
    return filesToUnsavedHostDocuments(Array.from(dataTransfer.files ?? []));
  },
  pdfDocumentsFromFileInput(files) {
    return filesToUnsavedHostDocuments(files);
  }
};

export function desktopDocumentsToHostDocuments(
  documents: DesktopPdfDocument[]
): PdfHostDocument[] {
  return documents.map((document) => ({
    fileKey: document.fileKey,
    source: {
      bytes: document.bytes,
      downloadTarget: electronFileAdapter.downloadTarget ?? null,
      name: document.name,
      saveAsTarget: electronFileAdapter.saveAsTarget ?? null,
      saveTarget: electronSaveTarget(document.fileId)
    },
    title: document.name
  }));
}

function filesToUnsavedHostDocuments(files: File[]): PdfHostDocument[] {
  return files.filter(isPdfFile).map((file) => ({
    fileKey: browserFileKey(file),
    source: {
      kind: 'loader',
      loadBytes: () => readPdfFile(file),
      name: file.name,
      saveAsTarget: electronFileAdapter.saveAsTarget ?? null
    },
    title: file.name
  }));
}

function electronSaveTarget(fileId: string): PdfSaveTarget {
  return {
    save: (bytes) => requireDesktopBridge().savePdf(fileId, bytes)
  };
}

function electronSaveAsTarget(): PdfSaveAsTarget {
  return {
    async saveAs(bytes, suggestedName) {
      const result = await requireDesktopBridge().savePdfAs(
        bytes,
        suggestedName
      );
      return result
        ? {
            fileName: result.name,
            saveTarget: electronSaveTarget(result.fileId)
          }
        : null;
    }
  };
}

function electronDownloadTarget(): PdfDownloadTarget {
  return {
    download: (bytes, suggestedName) =>
      requireDesktopBridge().downloadPdf(bytes, suggestedName)
  };
}

async function electronPickImageFile() {
  const image = await requireDesktopBridge().pickImageFile();
  return image
    ? new File([uint8ArrayToArrayBuffer(image.bytes)], image.name, {
        type: image.mimeType
      })
    : null;
}

function desktopBridge(): DesktopBridge | null {
  return window.pdfAnnotatorDesktop ?? null;
}

function requireDesktopBridge() {
  const bridge = desktopBridge();
  if (!bridge) {
    throw new Error('Desktop bridge is not available.');
  }

  return bridge;
}

function isPdfFile(file: File) {
  return (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  );
}

function browserFileKey(file: File) {
  return [
    'drop',
    file.webkitRelativePath || '',
    file.name,
    String(file.size),
    String(file.lastModified)
  ].join('\u001f');
}
