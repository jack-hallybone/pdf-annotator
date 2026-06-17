import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopBridge,
  DesktopImageFile,
  DesktopPdfDocument,
  DesktopSaveAsResult
} from './bridge.js';
import { electronIpcChannels } from './ipc.js';

type CloseHandler = () => boolean | Promise<boolean>;

const closeHandlers = new Set<CloseHandler>();

const bridge: DesktopBridge = {
  downloadPdf(bytes, suggestedName) {
    return ipcRenderer.invoke(
      electronIpcChannels.downloadPdf,
      bytes,
      suggestedName
    ) as Promise<void>;
  },
  onOpenPdfFiles(callback) {
    const listener = (_event: Electron.IpcRendererEvent, documents: unknown) => {
      if (Array.isArray(documents)) {
        callback(documents.filter(isDesktopPdfDocument));
      }
    };
    ipcRenderer.on(electronIpcChannels.openPdfFiles, listener);
    return () => {
      ipcRenderer.removeListener(electronIpcChannels.openPdfFiles, listener);
    };
  },
  onRequestClose(callback) {
    closeHandlers.add(callback);
    return () => closeHandlers.delete(callback);
  },
  openExternalLink(url) {
    return ipcRenderer.invoke(
      electronIpcChannels.openExternalLink,
      url
    ) as Promise<void>;
  },
  pickImageFile() {
    return ipcRenderer.invoke(
      electronIpcChannels.pickImageFile
    ) as Promise<DesktopImageFile | null>;
  },
  pickPdfFiles() {
    return ipcRenderer.invoke(
      electronIpcChannels.pickPdfFiles
    ) as Promise<DesktopPdfDocument[]>;
  },
  savePdf(fileId, bytes) {
    return ipcRenderer.invoke(
      electronIpcChannels.savePdf,
      fileId,
      bytes
    ) as Promise<void>;
  },
  savePdfAs(bytes, suggestedName) {
    return ipcRenderer.invoke(
      electronIpcChannels.savePdfAs,
      bytes,
      suggestedName
    ) as Promise<DesktopSaveAsResult | null>;
  }
};

ipcRenderer.on(electronIpcChannels.requestClose, () => {
  void resolveCloseRequest();
});

contextBridge.exposeInMainWorld('pdfAnnotatorDesktop', bridge);

async function resolveCloseRequest() {
  let allowed = true;
  for (const handler of closeHandlers) {
    if (!(await handler())) {
      allowed = false;
      break;
    }
  }

  ipcRenderer.send(electronIpcChannels.closeDecision, allowed);
}

function isDesktopPdfDocument(value: unknown): value is DesktopPdfDocument {
  const candidate = value as Partial<DesktopPdfDocument> | null;
  return (
    typeof value === 'object' &&
    value !== null &&
    candidate?.bytes instanceof Uint8Array &&
    typeof candidate.fileKey === 'string' &&
    typeof candidate.fileId === 'string' &&
    typeof candidate.name === 'string'
  );
}
