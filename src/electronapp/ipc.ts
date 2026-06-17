export const electronIpcChannels = {
  closeDecision: 'desktop:close-decision',
  downloadPdf: 'desktop:download-pdf',
  openExternalLink: 'desktop:open-external-link',
  openPdfFiles: 'desktop:open-pdf-files',
  pickImageFile: 'desktop:pick-image-file',
  pickPdfFiles: 'desktop:pick-pdf-files',
  printPdf: 'desktop:print-pdf',
  requestClose: 'desktop:request-close',
  savePdf: 'desktop:save-pdf',
  savePdfAs: 'desktop:save-pdf-as'
} as const;
