import { Download, FolderOpen } from "lucide-react";
import titleImageUrl from "./assets/title.svg?url";
// Imported rather than linked by a fixed name so Vite content-hashes it:
// everything precached has to carry its identity in its path.
import thirdPartyNoticesUrl from "../../THIRD-PARTY-NOTICES.md?url";
import { PRODUCT_NAME } from "../productName";
import { RELEASE_VERSION } from "../releaseVersion";
import type { TabbedAppHomeRenderProps } from "../tabbedapp";

type BrowserHomeProps = TabbedAppHomeRenderProps & {
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
  templateActions,
}: BrowserHomeProps) {
  const showInstallCard = Boolean(onInstall) || installedAsApp;

  return (
    <div className="browserapp-home-panel">
      <section
        className="browserapp-home-card stack xl"
        aria-label={`${PRODUCT_NAME} home`}
      >
        {/* A drawn wordmark, so the accessible name comes from PRODUCT_NAME
            rather than from the artwork. */}
        <h1 className="browserapp-home-title">
          <img
            alt={PRODUCT_NAME}
            className="browserapp-home-title-image"
            src={titleImageUrl}
          />
        </h1>

        <div className="panel raised browserapp-home-action-frame">
          {/* Both stay mounted (see styles.css) so the card never changes
              height, and everything below it jumps, when a drag starts. */}
          <div className="browserapp-home-action-stack" hidden={dragActive}>
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
          <div
            aria-live="polite"
            className="browserapp-home-drop-message"
            hidden={!dragActive}
          >
            <FolderOpen size={22} />
            <span>Drop PDFs to open</span>
          </div>
        </div>

        {showInstallCard ? (
          <aside className="panel raised browserapp-install-card">
            <div className="browserapp-install-copy">
              <h2>{installedAsApp ? "Tip" : "Install as Web App"}</h2>
              <p>
                {installedAsApp ? (
                  canHandlePdfLaunches ? (
                    `To use this app as your default PDF software, set ${PRODUCT_NAME} as the app for PDF files in your system settings.`
                  ) : (
                    "This app is installed and can work offline."
                  )
                ) : (
                  <>
                    Install as a{" "}
                    <a
                      href="https://en.wikipedia.org/wiki/Progressive_web_app"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Progressive Web App
                    </a>{" "}
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

        <footer className="browserapp-home-footer stack xxs text-muted">
          <a
            className="browserapp-home-credit tap-target text-xs text-muted"
            href="https://jack-hallybone.github.io/"
            rel="noopener noreferrer"
            target="_blank"
          >
            Made by Jack (and the machines)
          </a>
          {/* The bundled licences have to be *provided*, not merely present at
              a URL nobody is told about. */}
          <a
            className="browserapp-home-credit tap-target text-xs text-muted"
            href={thirdPartyNoticesUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open-source licences
          </a>
          <span className="browserapp-release-version text-xs text-mono">
            {RELEASE_VERSION}
          </span>
        </footer>
      </section>
    </div>
  );
}
