import { useEffect, useState } from 'react';
import { browserFileAdapter } from './browserFileAdapter';
import { TabbedPdfShell } from '../tabbedapp';
import type { TabbedPdfDocumentSummary } from '../tabbedapp';

export function BrowserShell() {
  const [documents, setDocuments] = useState<TabbedPdfDocumentSummary[]>([]);

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
    />
  );
}
