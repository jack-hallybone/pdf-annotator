import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceNotice } from './components/WorkspaceNotices';

const DEFAULT_NOTICE_DURATION_MS = 10000;

export type WorkspaceNoticesApi = {
  notices: WorkspaceNotice[];
  showNotice: (message: string, durationMs?: number) => void;
  dismissNotice: (id: number) => void;
  reportMalformedAnnotations: (count: number) => void;
};

// Transient, auto-dismissing status messages shown over the workspace. Owns
// the id counter, per-notice dismissal timers, and their unmount cleanup.
// Re-showing a message that's already visible refreshes its timer rather than
// stacking a duplicate.
export function useWorkspaceNotices(): WorkspaceNoticesApi {
  const [notices, setNotices] = useState<WorkspaceNotice[]>([]);
  const noticeIdRef = useRef(0);
  const noticeTimersRef = useRef<Map<number, number>>(new Map());

  const dismissNotice = useCallback((id: number) => {
    const timer = noticeTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      noticeTimersRef.current.delete(id);
    }
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const showNotice = useCallback(
    (message: string, durationMs = DEFAULT_NOTICE_DURATION_MS) => {
      const id = noticeIdRef.current + 1;
      noticeIdRef.current = id;
      setNotices((current) => {
        const next: WorkspaceNotice[] = [];
        for (const notice of current) {
          if (notice.message === message) {
            const existingTimer = noticeTimersRef.current.get(notice.id);
            if (existingTimer !== undefined) {
              window.clearTimeout(existingTimer);
              noticeTimersRef.current.delete(notice.id);
            }
          } else {
            next.push(notice);
          }
        }
        next.push({ id, message });
        return next;
      });

      const timer = window.setTimeout(() => {
        noticeTimersRef.current.delete(id);
        setNotices((current) => current.filter((notice) => notice.id !== id));
      }, durationMs);
      noticeTimersRef.current.set(id, timer);
    },
    []
  );

  // Some pre-existing annotation looked like one of our editable kinds but
  // its own data failed our validation (bad image bit depth, a BBox/Rect
  // relationship that isn't a pure translate, etc.) - not something this
  // app produced or broke, so it's left untouched in the file, but it also
  // can't be shown or edited. Let the user know it's there rather than
  // letting it silently vanish from view.
  const reportMalformedAnnotations = useCallback(
    (count: number) => {
      if (count <= 0) {
        return;
      }

      showNotice(
        count === 1
          ? '1 annotation could not be displayed. It is preserved, untouched, in the file.'
          : `${count} annotations could not be displayed. They are preserved, untouched, in the file.`
      );
    },
    [showNotice]
  );

  useEffect(
    () => () => {
      for (const timer of noticeTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      noticeTimersRef.current.clear();
    },
    []
  );

  return { notices, showNotice, dismissNotice, reportMalformedAnnotations };
}
