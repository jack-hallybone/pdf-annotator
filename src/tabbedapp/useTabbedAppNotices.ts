import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PdfDocumentEditorNoticeOptions,
  PdfDocumentEditorNoticeTone,
} from "../pdfdocumenteditor";
import type { TabbedAppNotice } from "./components/TabbedAppNotices";

const DEFAULT_NOTICE_DURATION_MS = 10000;

type TabbedAppNoticesOptions = {
  /** How long a notice lives when neither caller nor tone says otherwise. */
  defaultDurationMs?: number;
};

// One definition with the core's, so a tone it sends can always be rendered.
export type ShowNoticeOptions = PdfDocumentEditorNoticeOptions;

type TabbedAppNoticesApi = {
  notices: TabbedAppNotice[];
  showNotice: (message: string, options?: ShowNoticeOptions) => void;
  dismissNotice: (id: number) => void;
  reportMalformedAnnotations: (count: number) => void;
  /** While the stack is hovered or holds focus, so nothing vanishes mid-read. */
  pauseNoticeTimers: () => void;
  resumeNoticeTimers: () => void;
};

// Danger notices stay until dismissed: WCAG 2.2.1's exceptions do not cover
// error messages, and a save failure is the only record there is.
function defaultDurationFor(
  tone: PdfDocumentEditorNoticeTone | undefined,
  fallbackMs: number,
) {
  return tone === "danger" ? null : fallbackMs;
}

type NoticeTimer = {
  /** Remaining life when the countdown was last started; null once paused. */
  handle: number | null;
  remainingMs: number;
  startedAt: number;
};

// Re-showing a visible message refreshes its timer, not stacks a duplicate.
export function useTabbedAppNotices({
  defaultDurationMs = DEFAULT_NOTICE_DURATION_MS,
}: TabbedAppNoticesOptions = {}): TabbedAppNoticesApi {
  const [notices, setNotices] = useState<TabbedAppNotice[]>([]);
  const noticeIdRef = useRef(0);
  const timersRef = useRef<Map<number, NoticeTimer>>(new Map());
  const pausedRef = useRef(false);

  const removeNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer?.handle !== null && timer?.handle !== undefined) {
      window.clearTimeout(timer.handle);
    }
    timersRef.current.delete(id);
  }, []);

  const startTimer = useCallback(
    (id: number, remainingMs: number) => {
      timersRef.current.set(id, {
        handle: window.setTimeout(() => {
          timersRef.current.delete(id);
          removeNotice(id);
        }, remainingMs),
        remainingMs,
        startedAt: Date.now(),
      });
    },
    [removeNotice],
  );

  const dismissNotice = useCallback(
    (id: number) => {
      clearTimer(id);
      removeNotice(id);
    },
    [clearTimer, removeNotice],
  );

  const showNotice = useCallback(
    (message: string, { durationMs, tone }: ShowNoticeOptions = {}) => {
      const life =
        durationMs === undefined
          ? defaultDurationFor(tone, defaultDurationMs)
          : durationMs;
      const id = noticeIdRef.current + 1;
      noticeIdRef.current = id;

      setNotices((current) => {
        const next: TabbedAppNotice[] = [];
        for (const notice of current) {
          if (notice.message === message) {
            clearTimer(notice.id);
          } else {
            next.push(notice);
          }
        }
        next.push({ id, message, tone });
        return next;
      });

      if (life === null) {
        return;
      }
      // A notice raised while the stack is already hovered starts paused.
      if (pausedRef.current) {
        timersRef.current.set(id, {
          handle: null,
          remainingMs: life,
          startedAt: Date.now(),
        });
        return;
      }
      startTimer(id, life);
    },
    [clearTimer, defaultDurationMs, startTimer],
  );

  const pauseNoticeTimers = useCallback(() => {
    if (pausedRef.current) {
      return;
    }
    pausedRef.current = true;
    for (const [id, timer] of timersRef.current) {
      if (timer.handle === null) continue;
      window.clearTimeout(timer.handle);
      timersRef.current.set(id, {
        handle: null,
        // Never below zero, so a notice hovered past its deadline still gets
        // a moment on screen after the pointer leaves.
        remainingMs: Math.max(
          0,
          timer.remainingMs - (Date.now() - timer.startedAt),
        ),
        startedAt: timer.startedAt,
      });
    }
  }, []);

  const resumeNoticeTimers = useCallback(() => {
    if (!pausedRef.current) {
      return;
    }
    pausedRef.current = false;
    for (const [id, timer] of [...timersRef.current]) {
      if (timer.handle !== null) continue;
      startTimer(id, Math.max(timer.remainingMs, 1000));
    }
  }, [startTimer]);

  // Such an annotation is left untouched in the file but cannot be shown, so
  // say so rather than let it vanish.
  const reportMalformedAnnotations = useCallback(
    (count: number) => {
      if (count <= 0) {
        return;
      }

      showNotice(
        count === 1
          ? "1 annotation could not be displayed. It is preserved, untouched, in the file."
          : `${count} annotations could not be displayed. They are preserved, untouched, in the file.`,
        { tone: "warning" },
      );
    },
    [showNotice],
  );

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) {
        if (timer.handle !== null) {
          window.clearTimeout(timer.handle);
        }
      }
      timersRef.current.clear();
    },
    [],
  );

  return {
    notices,
    showNotice,
    dismissNotice,
    reportMalformedAnnotations,
    pauseNoticeTimers,
    resumeNoticeTimers,
  };
}
