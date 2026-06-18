import { readPdfFile } from '../annotator';
import type {
  PdfPrintTarget,
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
  fileInput: {
    accept: 'application/pdf',
    multiple: true
  },
  printTarget: electronPrintTarget(),
  saveAsTarget: electronSaveAsTarget(),
  async pickPdfDocuments() {
    const bridge = requireDesktopBridge();
    return {
      documents: desktopDocumentsToHostDocuments(await bridge.pickPdfFiles())
    };
  },
  pickImageFile: electronPickImageFile,
  pickMergePdfFile: electronPickMergePdfFile,
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
    readOnly: document.readOnly,
    readOnlyMessage: document.readOnly
      ? 'This file is open as read-only because it is being edited in another window.'
      : undefined,
    source: {
      bytes: document.bytes,
      fileKey: document.fileKey,
      name: document.name,
      saveAsTarget: electronFileAdapter.saveAsTarget ?? null,
      saveTarget: document.fileId ? electronSaveTarget(document.fileId) : null
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
      fileKey: browserFileKey(file),
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
    async saveAs(createBytes, suggestedName) {
      const bytes = await createBytes();
      const result = await requireDesktopBridge().savePdfAs(
        bytes,
        suggestedName
      );
      return result
        ? {
            bytes,
            fileKey: result.fileKey,
            fileName: result.name,
            saveTarget: electronSaveTarget(result.fileId)
          }
        : null;
    }
  };
}

export function electronPrintTarget(): PdfPrintTarget {
  return {
    print: (bytes, suggestedName) =>
      requireDesktopBridge().printPdf(bytes, suggestedName)
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

async function electronPickMergePdfFile() {
  const [document] = await requireDesktopBridge().pickPdfFiles();
  return document
    ? {
        bytes: document.bytes,
        name: document.name
      }
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
