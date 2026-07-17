import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { PdfExternalLinkOpener } from './host';

export type PendingExternalLink = {
  trustKey: string;
  url: string;
};

type ExternalLinksParams = {
  onOpenExternalLink?: PdfExternalLinkOpener;
  fileName: string;
  sourceIdRef: RefObject<string>;
  showNotice: (message: string) => void;
};

export type ExternalLinksApi = {
  pendingExternalLink: PendingExternalLink | null;
  openButtonRef: RefObject<HTMLButtonElement | null>;
  requestExternalLink: (url: string) => void;
  confirmExternalLink: (options?: { always?: boolean }) => void;
  cancelExternalLink: () => void;
  // Clears the confirmation dialog and the per-document trust list. Used when
  // the workspace loads a different document.
  reset: () => void;
};

// Owns the "this file wants to open a link" confirmation flow. A PDF-embedded
// link is never opened silently: the first time a document asks to open a
// given origin (or mailto:), the user is prompted; "always" adds that origin
// to a per-document trust list so repeats open directly. The trust list is
// intentionally in-memory and per-document - it is cleared on reset() and
// never persisted.
export function useExternalLinks({
  onOpenExternalLink,
  fileName,
  sourceIdRef,
  showNotice
}: ExternalLinksParams): ExternalLinksApi {
  const [pendingExternalLink, setPendingExternalLink] =
    useState<PendingExternalLink | null>(null);
  const [trustedExternalLinkKeys, setTrustedExternalLinkKeys] = useState<
    string[]
  >([]);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);

  const openExternalLink = useCallback(
    async (url: string) => {
      try {
        if (onOpenExternalLink) {
          await onOpenExternalLink(url, {
            fileName,
            sourceId: sourceIdRef.current
          });
          return;
        }

        openExternalLinkInNewTab(url);
      } catch {
        showNotice('Could not open this link.');
      }
    },
    [onOpenExternalLink, fileName, sourceIdRef, showNotice]
  );

  const requestExternalLink = useCallback(
    (url: string) => {
      const trustKey = externalLinkTrustKey(url);
      if (!trustKey) {
        return;
      }

      if (trustedExternalLinkKeys.includes(trustKey)) {
        void openExternalLink(url);
        return;
      }

      setPendingExternalLink({ trustKey, url });
    },
    [trustedExternalLinkKeys, openExternalLink]
  );

  const cancelExternalLink = useCallback(() => {
    setPendingExternalLink(null);
  }, []);

  const confirmExternalLink = useCallback(
    ({ always = false }: { always?: boolean } = {}) => {
      // Read the pending link inside the updater so this callback needn't
      // depend on it (a stale closure would confirm the wrong link).
      setPendingExternalLink((link) => {
        if (!link) {
          return null;
        }

        if (always) {
          setTrustedExternalLinkKeys((current) =>
            current.includes(link.trustKey)
              ? current
              : [...current, link.trustKey]
          );
        }
        void openExternalLink(link.url);
        return null;
      });
    },
    [openExternalLink]
  );

  const reset = useCallback(() => {
    setPendingExternalLink(null);
    setTrustedExternalLinkKeys([]);
  }, []);

  // While the dialog is open, focus its primary button and let Escape dismiss.
  useEffect(() => {
    if (!pendingExternalLink) {
      return;
    }

    openButtonRef.current?.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPendingExternalLink(null);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingExternalLink]);

  return {
    pendingExternalLink,
    openButtonRef,
    requestExternalLink,
    confirmExternalLink,
    cancelExternalLink,
    reset
  };
}

function externalLinkTrustKey(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'mailto:' ? 'mailto:' : parsed.origin;
  } catch {
    return null;
  }
}

function openExternalLinkInNewTab(url: string) {
  const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
  if (!openedWindow) {
    return;
  }

  try {
    openedWindow.opener = null;
  } catch {
    // noopener is requested in the feature string; this is a defensive fallback.
  }
}
