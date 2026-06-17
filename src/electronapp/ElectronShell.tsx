import { useEffect, useRef } from 'react';
import { AppWindow } from 'lucide-react';
import { TabbedPdfShell } from '../tabbedapp';
import type { TabbedPdfShellHandle } from '../tabbedapp';
import {
  desktopDocumentsToHostDocuments,
  electronFileAdapter,
  electronPrintTarget
} from './electronFileAdapter';

export function ElectronShell() {
  const shellRef = useRef<TabbedPdfShellHandle>(null);
  const bridge = window.pdfAnnotatorDesktop;

  useEffect(() => {
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
  }, [bridge]);

  if (!bridge) {
    return (
      <main className="tabbedapp-shell">
        <section className="tabbedapp-content">
          <div className="tabbedapp-home-panel">
            <p>Desktop integration did not load.</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <TabbedPdfShell
      fileAdapter={electronFileAdapter}
      newTabMenuActions={[
        {
          label: 'New window',
          onSelect: () => bridge.newWindow(),
          renderIcon: (size) => <AppWindow size={size} />
        }
      ]}
      ref={shellRef}
      workspaceOptions={{
        onOpenExternalLink: (url) => bridge.openExternalLink(url),
        printTarget: electronPrintTarget(),
        showDownloadButton: false
      }}
    />
  );
}
