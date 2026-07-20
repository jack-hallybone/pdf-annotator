import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { TabbedPdfShell } from '../tabbedapp';
import type {
  TabbedPdfDocumentSummary,
  TabbedPdfShellHandle
} from '../tabbedapp';
import { BrowserHome } from './BrowserHome';
import {
  browserFileAdapter,
  browserFileHandlesToHostDocuments
} from './browserFileAdapter';
import {
  applyAvailableServiceWorkerUpdate,
  registerBrowserServiceWorker,
  setPwaFileLaunchHandler
} from './pwa';
import { isBrowserAppFramed } from './frameGuard';
import './styles.css';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
};

export function BrowserShell() {
  return isBrowserAppFramed() ? <FramedBrowserAppBlock /> : <BrowserShellInner />;
}

function FramedBrowserAppBlock() {
  return (
    <main className="browserapp-frame-block">
      <section className="browserapp-frame-block-card">
        <h1>PDF Annotator cannot run inside another page.</h1>
        <p>Open it directly to use local PDF files safely.</p>
      </section>
    </main>
  );
}

function BrowserShellInner() {
  const shellRef = useRef<TabbedPdfShellHandle>(null);
  const [documents, setDocuments] = useState<TabbedPdfDocumentSummary[]>([]);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installedAsApp, setInstalledAsApp] = useState(isPwaDisplayMode);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(
    () => registerBrowserServiceWorker(() => setUpdateAvailable(true)),
    []
  );

  const refreshForUpdate = useCallback(() => {
    applyAvailableServiceWorkerUpdate();
  }, []);

  const dismissUpdateNotice = useCallback(() => {
    setUpdateAvailable(false);
  }, []);

  useEffect(() => {
    const standaloneMedia = window.matchMedia('(display-mode: standalone)');
    const updateInstalledState = () => setInstalledAsApp(isPwaDisplayMode());

    updateInstalledState();
    standaloneMedia.addEventListener('change', updateInstalledState);
    return () =>
      standaloneMedia.removeEventListener('change', updateInstalledState);
  }, []);

  useEffect(() => {
    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }

    function handleAppInstalled() {
      setInstallPrompt(null);
      setInstalledAsApp(true);
    }

    window.addEventListener(
      'beforeinstallprompt',
      handleBeforeInstallPrompt
    );
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt
      );
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  useEffect(
    () =>
      setPwaFileLaunchHandler(async (handles) => {
        try {
          const launchedDocuments =
            await browserFileHandlesToHostDocuments(handles);
          shellRef.current?.openDocuments(launchedDocuments);
        } catch {
          shellRef.current?.showNotice('Could not open this file.');
        }
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

  const installApp = useCallback(async () => {
    const prompt = installPrompt;
    if (!prompt) {
      return;
    }

    setInstallPrompt(null);
    await prompt.prompt();
    await prompt.userChoice.catch(() => undefined);
  }, [installPrompt]);

  return (
    <>
      {updateAvailable ? (
        <UpdateAvailableBanner
          onClose={dismissUpdateNotice}
          onRefresh={refreshForUpdate}
        />
      ) : null}
      <TabbedPdfShell
        fileAdapter={browserFileAdapter}
        onDocumentsChange={setDocuments}
        ref={shellRef}
        renderHome={(props) => (
          <BrowserHome
            {...props}
            canHandlePdfLaunches={canHandlePwaFileLaunches()}
            installedAsApp={installedAsApp}
            onInstall={
              installPrompt && !installedAsApp ? installApp : undefined
            }
          />
        )}
      />
    </>
  );
}

function UpdateAvailableBanner({
  onClose,
  onRefresh
}: {
  onClose: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="browserapp-update-banner ui-frame screen-only" role="status">
      <span className="browserapp-update-banner-text">
        A new version of PDF Annotator is available.
      </span>
      <div className="browserapp-update-banner-actions">
        <button
          className="ui-button browserapp-update-banner-refresh"
          onClick={onRefresh}
          type="button"
        >
          <RefreshCw size={14} />
          <span>Refresh</span>
        </button>
        <button
          aria-label="Dismiss update notification"
          className="icon-button ui-button browserapp-update-banner-close"
          onClick={onClose}
          type="button"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function isPwaDisplayMode() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function canHandlePwaFileLaunches() {
  return 'launchQueue' in window;
}
