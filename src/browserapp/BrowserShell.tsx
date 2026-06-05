import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { browserFileAdapter } from './browserFileAdapter';
import { TabbedPdfShell } from '../tabbedapp';
import type {
  TabbedPdfCloseDocumentsRequest,
  TabbedPdfDocumentSummary,
  TabbedPdfHomeRenderProps
} from '../tabbedapp';
import './styles.css';

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
      confirmCloseDocuments={confirmCloseDocuments}
      fileAdapter={browserFileAdapter}
      onDocumentsChange={setDocuments}
      renderHome={(props) => <BrowserHome {...props} />}
      workspaceOptions={{
        confirmDiscardChanges: confirmDiscardWorkspaceChanges
      }}
    />
  );
}

function confirmDiscardWorkspaceChanges() {
  return window.confirm('Close this PDF and discard unsaved changes?');
}

function confirmCloseDocuments({
  dirtyCount,
  documents
}: TabbedPdfCloseDocumentsRequest) {
  return window.confirm(closeDocumentsMessage(documents.length, dirtyCount));
}

function closeDocumentsMessage(tabCount: number, dirtyCount: number) {
  return `Close ${tabCount} tab${tabCount === 1 ? '' : 's'} and discard unsaved changes in ${dirtyCount} PDF${dirtyCount === 1 ? '' : 's'}?`;
}

function BrowserHome({
  createTemplateDocument,
  dragActive,
  openPdfDocuments,
  templateActions
}: TabbedPdfHomeRenderProps) {
  return (
    <div className="browserapp-home-panel">
      <section className="browserapp-home-card" aria-label="PDF Annotator home">
        <h1 className="browserapp-home-title">
          <img
            alt="PDF Annotator"
            className="browserapp-home-title-image"
            src={`${import.meta.env.BASE_URL}title.svg`}
          />
        </h1>
        <div className="browserapp-home-action-frame">
          {dragActive ? (
            <div aria-live="polite" className="browserapp-home-drop-message">
              <FolderOpen size={22} />
              <span>Drop PDFs to open</span>
            </div>
          ) : (
            <div className="browserapp-home-action-stack">
              <button
                className="browserapp-home-open-button"
                onClick={() => void openPdfDocuments()}
                type="button"
              >
                <FolderOpen size={22} />
                Open PDFs
              </button>
              <div className="browserapp-home-template-grid">
                {templateActions.map(({ kind, label, renderIcon }) => (
                  <button
                    className="browserapp-home-template-button"
                    key={kind}
                    onClick={() => void createTemplateDocument(kind)}
                    type="button"
                  >
                    {renderIcon(18)}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
