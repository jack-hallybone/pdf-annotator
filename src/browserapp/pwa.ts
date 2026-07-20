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

// The service worker serves the cached app shell instantly (see
// buildServiceWorkerSource) rather than racing the network on every
// navigation. Picking up a new deploy is instead driven from here: with
// updateViaCache: 'none', every registerServiceWorker() call (i.e. every
// fresh page load/session) already makes the browser re-fetch sw.js and
// compare it byte-for-byte, so a new deploy installs in the background
// without any polling on our part - once it's done, it hands back the app a
// chance to prompt the user before switching over.
let currentRegistration: ServiceWorkerRegistration | null = null;

export function registerBrowserServiceWorker(onUpdateAvailable?: () => void) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return;
  }

  // Captured once, up front, rather than re-checked later inside the
  // 'installed' handler below: the new worker's activate handler calls
  // self.clients.claim(), which can make this very page "controlled"
  // moments after a brand-new (first-ever) install finishes - racing ahead
  // of this page's own statechange callback and making a first install look
  // like a genuine update. Reading it here, before registration even starts,
  // isn't subject to that race.
  const hadExistingController = Boolean(navigator.serviceWorker.controller);

  const register = () => {
    // Offline/installable support is a bonus, not a feature the user directly
    // invoked - if registration fails the app still works as a normal page,
    // so there's nothing actionable to surface here.
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
        updateViaCache: 'none'
      })
      .then((registration) => {
        currentRegistration = registration;
        watchForServiceWorkerUpdates(
          registration,
          hadExistingController,
          onUpdateAvailable
        );
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

function watchForServiceWorkerUpdates(
  registration: ServiceWorkerRegistration,
  hadExistingController: boolean,
  onUpdateAvailable?: () => void
) {
  if (!onUpdateAvailable) {
    return;
  }

  // A worker can already be sitting in "waiting" if it installed earlier in
  // this page's lifetime (or, in principle, before this listener attached).
  if (registration.waiting && hadExistingController) {
    onUpdateAvailable();
  }

  registration.addEventListener('updatefound', () => {
    const installingWorker = registration.installing;
    if (!installingWorker) {
      return;
    }

    installingWorker.addEventListener('statechange', () => {
      // hadExistingController is what tells a genuine update (some worker
      // already controlled this page before this registration attempt)
      // apart from the very first install (nothing to compare against yet).
      if (installingWorker.state === 'installed' && hadExistingController) {
        onUpdateAvailable();
      }
    });
  });
}

// Called when the user accepts the "update available" prompt. Tells the
// worker parked in the waiting state to activate now instead of waiting for
// every other tab of the old version to close, then reloads this page once
// it has taken control.
export function applyAvailableServiceWorkerUpdate() {
  const waitingWorker = currentRegistration?.waiting;
  if (!waitingWorker) {
    window.location.reload();
    return;
  }

  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => window.location.reload(),
    { once: true }
  );
  waitingWorker.postMessage('SKIP_WAITING');
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
