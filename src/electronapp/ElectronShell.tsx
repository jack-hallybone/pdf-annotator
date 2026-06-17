import { useEffect, useRef } from 'react';
import { AppWindow } from 'lucide-react';
import { TabbedPdfShell } from '../tabbedapp';
import type { TabbedPdfShellHandle } from '../tabbedapp';
import {
  desktopDocumentsToHostDocuments,
  electronFileAdapter
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
      () => shellRef.current?.confirmWindowClose() ?? true
    );

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, []);

  return (
    <TabbedPdfShell
      fileAdapter={electronFileAdapter}
      newTabMenuActions={[
        {
          label: 'New window',
          onSelect: () => window.pdfAnnotatorDesktop?.newWindow(),
          renderIcon: (size) => <AppWindow size={size} />
        }
      ]}
      ref={shellRef}
      workspaceOptions={{
        onOpenExternalLink: (url) =>
          window.pdfAnnotatorDesktop?.openExternalLink(url),
        showDownloadButton: false
      }}
    />
  );
}
