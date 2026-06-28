import { Download, FolderOpen } from 'lucide-react';
import type { TabbedPdfHomeRenderProps } from '../tabbedapp';
import titleImageUrl from './assets/title.svg?url';

type BrowserHomeProps = TabbedPdfHomeRenderProps & {
  canHandlePdfLaunches: boolean;
  installedAsApp: boolean;
  onInstall?: () => void;
};

export function BrowserHome({
  canHandlePdfLaunches,
  createTemplateDocument,
  dragActive,
  installedAsApp,
  onInstall,
  openPdfDocuments,
  templateActions
}: BrowserHomeProps) {
  const showInstallCard = Boolean(onInstall) || installedAsApp;

  return (
    <div className="browserapp-home-panel">
      <section className="browserapp-home-card" aria-label="PDF Annotator home">
        <h1 className="browserapp-home-title">
          <img
            alt="PDF Annotator"
            className="browserapp-home-title-image"
            src={titleImageUrl}
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

        {showInstallCard ? (
          <aside className="browserapp-install-card">
            <div className="browserapp-install-copy">
              <h2>
                {installedAsApp ? 'Tip' : 'Install as Web App'}
              </h2>
              <p>
                {installedAsApp ? (
                  canHandlePdfLaunches ? (
                    'To use this app as your default PDF software, set PDF Annotator as the app for PDF files in your system settings.'
                  ) : (
                    'This app is installed and can work offline.'
                  )
                ) : (
                  <>
                    Install as a{' '}
                    <a
                      href="https://en.wikipedia.org/wiki/Progressive_web_app"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Progressive Web App
                    </a>{' '}
                    to annotate PDFs offline and open files directly from your
                    computer.
                  </>
                )}
              </p>
            </div>
            {onInstall ? (
              <button
                className="browserapp-install-button"
                onClick={() => void onInstall()}
                type="button"
              >
                <Download size={18} />
                Install
              </button>
            ) : null}
          </aside>
        ) : null}

        <a
          className="browserapp-home-credit"
          href="https://jack-hallybone.github.io/"
          rel="noopener noreferrer"
          target="_blank"
        >
          Made by Jack and Codex
        </a>
      </section>
    </div>
  );
}
