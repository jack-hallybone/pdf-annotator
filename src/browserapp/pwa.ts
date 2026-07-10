import type { LocalPdfFileHandle } from './localFileAccess';

type PwaLaunchParams = {
  files: LocalPdfFileHandle[];
};

type PwaLaunchQueue = {
  setConsumer: (consumer: (params: PwaLaunchParams) => void) => void;
};

type PwaWindow = Window &
  typeof globalThis & {
    launchQueue?: PwaLaunchQueue;
  };

type PwaFileLaunchHandler = (
  handles: LocalPdfFileHandle[]
) => Promise<void> | void;

let fileLaunchHandler: PwaFileLaunchHandler | null = null;
let launchQueueRegistered = false;
let launchDeliveryQueue = Promise.resolve();
const pendingFileLaunches: LocalPdfFileHandle[][] = [];

export function registerBrowserServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return;
  }

  const register = () => {
    // Offline/installable support is a bonus, not a feature the user directly
    // invoked - if registration fails the app still works as a normal page,
    // so there's nothing actionable to surface here.
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
        updateViaCache: 'none'
      })
      .catch(() => undefined);
  };

  if (document.readyState === 'complete') {
    register();
    return;
  }

  window.addEventListener('load', register, { once: true });
  return () => window.removeEventListener('load', register);
}

export function setPwaFileLaunchHandler(handler: PwaFileLaunchHandler) {
  fileLaunchHandler = handler;
  registerLaunchQueueConsumer();
  flushPendingFileLaunches();

  return () => {
    if (fileLaunchHandler === handler) {
      fileLaunchHandler = null;
    }
  };
}

function registerLaunchQueueConsumer() {
  const launchQueue = (window as PwaWindow).launchQueue;
  if (!launchQueue || launchQueueRegistered) {
    return;
  }

  launchQueueRegistered = true;
  launchQueue.setConsumer(({ files }) => {
    if (files.length === 0) {
      return;
    }

    if (!fileLaunchHandler) {
      pendingFileLaunches.push(files);
      return;
    }

    enqueueFileLaunch(files);
  });
}

function flushPendingFileLaunches() {
  if (!fileLaunchHandler) {
    return;
  }

  for (const handles of pendingFileLaunches.splice(0)) {
    enqueueFileLaunch(handles);
  }
}

function enqueueFileLaunch(handles: LocalPdfFileHandle[]) {
  launchDeliveryQueue = launchDeliveryQueue.then(() =>
    deliverFileLaunch(handles)
  );
}

async function deliverFileLaunch(handles: LocalPdfFileHandle[]) {
  try {
    await fileLaunchHandler?.(handles);
  } catch {
    // The registered handler (see BrowserShell) is responsible for reporting
    // its own failures to the user via the shell's notice UI - this is only
    // a backstop so a rejected delivery can't break the queue for the next one.
  }
}
