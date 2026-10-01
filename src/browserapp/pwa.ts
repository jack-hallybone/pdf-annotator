import { PACKAGE_NAME } from "../packageName";
import type { LocalPdfFileHandle } from "./localFileAccess";

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
  handles: LocalPdfFileHandle[],
) => Promise<void> | void;

let fileLaunchHandler: PwaFileLaunchHandler | null = null;
let launchQueueRegistered = false;
let launchDeliveryQueue = Promise.resolve();
// A launch can fire before the shell calls setPwaFileLaunchHandler - a cold start is exactly when it does - so it waits here until one is set.
const pendingFileLaunches: LocalPdfFileHandle[][] = [];

// Lock names are origin-wide and sibling apps share this origin, so this one carries the package name.
const WINDOW_LOCK = `${PACKAGE_NAME}-window`;

// An update downloads in the background and runs from the next reload: a new worker waiting by then takes over, unless another window of this app is still open on the current version.
async function applyWaitingUpdate() {
  const waiting = (await navigator.serviceWorker.getRegistration())?.waiting;
  const [navigation] = performance.getEntriesByType(
    "navigation",
  ) as PerformanceNavigationTiming[];
  const reload = navigation?.type === "reload";
  const shared = (await navigator.locks.query()).held?.some(
    (lock) => lock.name === WINDOW_LOCK,
  );
  // Held until this window closes, for the check above in any other window.
  void navigator.locks.request(
    WINDOW_LOCK,
    { mode: "shared" },
    () => new Promise(() => {}),
  );
  if (!waiting || !reload || shared || !navigator.serviceWorker.controller) {
    return;
  }
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => location.reload(),
    { once: true },
  );
  waiting.postMessage({ type: "SKIP_WAITING" });
}

export function registerBrowserServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }
  if (navigator.locks) void applyWaitingUpdate().catch(() => undefined);

  const register = () => {
    // Registration only: a new worker installs and waits for a reload (applyWaitingUpdate, above) or for every window to close, so the running page keeps the asset set it booted with and a lazy chunk cannot 404 mid-session.
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
        updateViaCache: "none",
      })
      .catch(() => undefined);
  };

  if (document.readyState === "complete") {
    register();
    return;
  }

  window.addEventListener("load", register, { once: true });
  return () => window.removeEventListener("load", register);
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
  // One callback per launch, whatever it carries: a launch is either one with every file or, on Windows, one per file, and both shapes just work since nothing here batches them together.
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
    deliverFileLaunch(handles),
  );
}

async function deliverFileLaunch(handles: LocalPdfFileHandle[]) {
  try {
    await fileLaunchHandler?.(handles);
  } catch {
    // The handler reports its own failures; this only keeps a rejected delivery from breaking the queue for the next one.
  }
}
