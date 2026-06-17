const { contextBridge, ipcRenderer } = require('electron');

const electronIpcChannels = {
  closeDecision: 'desktop:close-decision',
  downloadPdf: 'desktop:download-pdf',
  newWindow: 'desktop:new-window',
  openExternalLink: 'desktop:open-external-link',
  openPdfFiles: 'desktop:open-pdf-files',
  pickImageFile: 'desktop:pick-image-file',
  pickPdfFiles: 'desktop:pick-pdf-files',
  printPdf: 'desktop:print-pdf',
  requestClose: 'desktop:request-close',
  savePdf: 'desktop:save-pdf',
  savePdfAs: 'desktop:save-pdf-as'
};

const closeHandlers = new Set();

const bridge = {
  downloadPdf(bytes, suggestedName) {
    return ipcRenderer.invoke(
      electronIpcChannels.downloadPdf,
      bytes,
      suggestedName
    );
  },
  onOpenPdfFiles(callback) {
    const listener = (_event, documents) => {
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
  newWindow() {
    return ipcRenderer.invoke(electronIpcChannels.newWindow);
  },
  openExternalLink(url) {
    return ipcRenderer.invoke(electronIpcChannels.openExternalLink, url);
  },
  pickImageFile() {
    return ipcRenderer.invoke(electronIpcChannels.pickImageFile);
  },
  pickPdfFiles() {
    return ipcRenderer.invoke(electronIpcChannels.pickPdfFiles);
  },
  printPdf(bytes, suggestedName) {
    return ipcRenderer.invoke(
      electronIpcChannels.printPdf,
      bytes,
      suggestedName
    );
  },
  savePdf(fileId, bytes) {
    return ipcRenderer.invoke(electronIpcChannels.savePdf, fileId, bytes);
  },
  savePdfAs(bytes, suggestedName) {
    return ipcRenderer.invoke(
      electronIpcChannels.savePdfAs,
      bytes,
      suggestedName
    );
  }
};

ipcRenderer.on(electronIpcChannels.requestClose, () => {
  void resolveCloseRequest();
});

contextBridge.exposeInMainWorld('pdfAnnotatorDesktop', bridge);

async function resolveCloseRequest() {
  let allowed = true;
  try {
    for (const handler of closeHandlers) {
      if (!(await handler())) {
        allowed = false;
        break;
      }
    }
  } catch {
    allowed = false;
  }

  ipcRenderer.send(electronIpcChannels.closeDecision, allowed);
}

function isDesktopPdfDocument(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.bytes instanceof Uint8Array &&
    typeof value.fileKey === 'string' &&
    typeof value.fileId === 'string' &&
    typeof value.name === 'string'
  );
}
