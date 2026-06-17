import { useEffect, useRef } from 'react';
import { TabbedPdfShell } from '../tabbedapp';
import type { TabbedPdfShellHandle } from '../tabbedapp';
import {
  desktopDocumentsToHostDocuments,
  electronFileAdapter,
  electronPrintTarget
} from './electronFileAdapter';

export function ElectronShell() {
  const shellRef = useRef<TabbedPdfShellHandle>(null);

  useEffect(() => {
    const bridge = window.pdfAnnotatorDesktop;
    if (!bridge) {
      return;
    }

    const unsubscribeOpen = bridge.onOpenPdfFiles((documents) => {
      shellRef.current?.openDocuments(desktopDocumentsToHostDocuments(documents));
    });
    const unsubscribeClose = bridge.onRequestClose(
      () => shellRef.current?.closeAllDocuments() ?? true
    );

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, []);

  return (
    <TabbedPdfShell
      fileAdapter={electronFileAdapter}
      ref={shellRef}
      workspaceOptions={{
        onOpenExternalLink: (url) =>
          window.pdfAnnotatorDesktop?.openExternalLink(url),
        printTarget: electronPrintTarget(),
        showDownloadButton: false
      }}
    />
  );
}
