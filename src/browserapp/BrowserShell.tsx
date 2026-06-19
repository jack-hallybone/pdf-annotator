import { useEffect, useRef, useState } from 'react';
import { TabbedPdfShell } from '../tabbedapp';
import type {
  TabbedPdfDocumentSummary,
  TabbedPdfShellHandle
} from '../tabbedapp';
import {
  browserFileAdapter,
  browserFileHandlesToHostDocuments
} from './browserFileAdapter';
import {
  registerBrowserServiceWorker,
  setPwaFileLaunchHandler
} from './pwa';

export function BrowserShell() {
  const shellRef = useRef<TabbedPdfShellHandle>(null);
  const [documents, setDocuments] = useState<TabbedPdfDocumentSummary[]>([]);

  useEffect(() => registerBrowserServiceWorker(), []);

  useEffect(
    () =>
      setPwaFileLaunchHandler(async (handles) => {
        const launchedDocuments =
          await browserFileHandlesToHostDocuments(handles);
        shellRef.current?.openDocuments(launchedDocuments);
      }),
    []
  );

  useEffect(() => {
    if (!documents.some((document) => document.hasUnsavedChanges)) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [documents]);

  return (
    <TabbedPdfShell
      fileAdapter={browserFileAdapter}
      onDocumentsChange={setDocuments}
      ref={shellRef}
    />
  );
}
