import type { PageRenderPriority } from "./types";

/*
 * Priority is a scheduling hint and must never be a render-effect dependency:
 * crossing a page boundary re-ranks three pages, and the cleanups that follow
 * blank every visible canvas for two frames.
 */

/** `run` is a no-op once started or cancelled, so promotion is safe. */
export type PendingPageTask = {
  cancel: () => void;
  run: () => void;
};

function schedulePriorityTask(
  priority: PageRenderPriority,
  task: () => void | Promise<void>,
) {
  if (priority === "visible") {
    void task();
    return () => undefined;
  }

  if (priority === "near") {
    const timeout = window.setTimeout(() => void task(), 0);
    return () => window.clearTimeout(timeout);
  }

  if (window.requestIdleCallback && window.cancelIdleCallback) {
    const handle = window.requestIdleCallback(() => void task(), {
      timeout: 1200,
    });
    return () => window.cancelIdleCallback(handle);
  }

  const timeout = window.setTimeout(() => void task(), 180);
  return () => window.clearTimeout(timeout);
}

/**
 * A cancelled task is deregistered, so a later promotion cannot resurrect
 * torn-down work.
 */
export function schedulePromotableTask(
  pending: Set<PendingPageTask>,
  priority: PageRenderPriority,
  task: () => void | Promise<void>,
) {
  let settled = false;
  const entry: PendingPageTask = {
    cancel: () => undefined,
    run: () => undefined,
  };

  const start = () => {
    if (settled) {
      return;
    }
    settled = true;
    pending.delete(entry);
    void task();
  };

  const cancelScheduled = schedulePriorityTask(priority, start);
  entry.cancel = cancelScheduled;
  entry.run = () => {
    cancelScheduled();
    start();
  };

  // "visible" runs synchronously above, so the task may already have started.
  if (!settled) {
    pending.add(entry);
  }

  return () => {
    settled = true;
    pending.delete(entry);
    cancelScheduled();
  };
}

/** Every queued task on this page, started now; safe to call repeatedly. */
export function promotePendingPageTasks(pending: Set<PendingPageTask>) {
  for (const entry of [...pending]) {
    entry.run();
  }
}
