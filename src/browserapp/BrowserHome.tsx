import { FolderOpen } from 'lucide-react';
import type { TabbedPdfHomeRenderProps } from '../tabbedapp';
import './styles.css';

export function BrowserHome({
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
