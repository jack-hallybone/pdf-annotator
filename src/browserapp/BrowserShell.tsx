import { useCallback, useEffect, useRef, useState } from 'react';
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

  useEffect(() => registerBrowserServiceWorker(), []);

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
