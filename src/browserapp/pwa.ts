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
let handoffRegistered = false;
let launchDeliveryQueue = Promise.resolve();
// A launch can fire before the shell calls setPwaFileLaunchHandler - a cold start is exactly when it does - so it waits here until one is set.
const pendingFileLaunches: LocalPdfFileHandle[][] = [];

// Lock names are origin-wide and sibling apps share this origin, so this one carries the package name.
const WINDOW_LOCK = `${PACKAGE_NAME}-window`;

// An update downloads in the background and runs from the next reload: a new worker waiting by then takes over, unless another window of this app is still open on the current version.
async function applyWaitingUpdate() {
  // Asked for before anything else and held until this window closes, so another window's check below always finds this one.
  const locked = new Promise<void>((resolve) => {
    void navigator.locks.request(WINDOW_LOCK, { mode: "shared" }, () => {
      resolve();
      return new Promise(() => {});
    });
  });
  // Asked for at once too, not once the lock is granted: a long boot can hold up the grant, and an update that finished downloading meanwhile must wait for the next reload.
  const waiting = (await navigator.serviceWorker.getRegistration())?.waiting;
  const [navigation] = performance.getEntriesByType(
    "navigation",
  ) as PerformanceNavigationTiming[];
  const reload = navigation?.type === "reload";
  await locked;
  if (
    !waiting ||
    !reload ||
    !navigator.serviceWorker.controller ||
    (await otherWindowOpen(WINDOW_LOCK))
  ) {
    return;
  }
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => location.reload(),
    { once: true },
  );
  waiting.postMessage({ type: "SKIP_WAITING" });
}

// This window holds the lock as well, so a second hold is another window's, or for a moment after a reload the page it replaced, which can still be listed after it has gone: a second hold counts only once it has lasted a quarter of a second.
async function otherWindowOpen(
  name: string,
  start = performance.now(),
): Promise<boolean> {
  const holds =
    (await navigator.locks.query()).held?.filter((lock) => lock.name === name)
      .length ?? 0;
  if (holds < 2 || performance.now() - start >= 250) return holds > 1;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return otherWindowOpen(name, start);
}

export function registerBrowserServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }
  // The update tests wait for this mark to know the check is over, whichever way it went.
  if (navigator.locks)
    void applyWaitingUpdate()
      .catch(() => undefined)
      .finally(() => performance.mark("update-checked"));

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
  registerFileHandoff();
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
    if (files.length > 0) {
      receiveFileLaunch(files);
    }
  });
}

// The reference manager beside this app, on the same origin, hands over a library PDF's file handle, so Save writes back to the library's file. It is a launch like any other.
function registerFileHandoff() {
  if (handoffRegistered) {
    return;
  }

  handoffRegistered = true;
  const received = new Set<string>();
  window.addEventListener("message", (event) => {
    const data = event.data as {
      type?: unknown;
      id?: unknown;
      handle?: unknown;
    } | null;
    if (
      event.origin !== location.origin ||
      data?.type !== "pdf-annotator-open" ||
      typeof data.id !== "string"
    ) {
      return;
    }

    // Answered every time: the sender sends again whenever this window says it is ready.
    (event.source as Window | null)?.postMessage(
      { type: "pdf-annotator-opened", id: data.id },
      location.origin,
    );
    if (received.has(data.id)) {
      return;
    }

    received.add(data.id);
    // Checked when read, as every launch's handles are.
    receiveFileLaunch([data.handle as LocalPdfFileHandle]);
  });
  // A window the reference manager has just opened has its file sent now.
  (window.opener as Window | null)?.postMessage(
    { type: "pdf-annotator-ready" },
    location.origin,
  );
}

function receiveFileLaunch(files: LocalPdfFileHandle[]) {
  if (!fileLaunchHandler) {
    pendingFileLaunches.push(files);
    return;
  }

  enqueueFileLaunch(files);
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
