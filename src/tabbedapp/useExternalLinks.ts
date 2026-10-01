import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PdfExternalLinkOpener } from "../pdfdocumenteditor";
import { safePdfExternalUrl } from "../pdfdocumenteditor/pdfLinks";
import type { ShowNoticeOptions } from "./useTabbedAppNotices";

export type PendingExternalLink = {
  trustKey: string;
  // What `trustKey` covers, in words, derived beside the key so what the user is told cannot drift from what is stored.
  trustScopeLabel: string;
  // Never the raw PDF url: this is sanitized, and is the same string both the dialog renders and openExternalLink opens.
  url: string;
};

type ExternalLinksParams = {
  onOpenExternalLink?: PdfExternalLinkOpener;
  fileName: string;
  sourceIdRef: RefObject<string>;
  showNotice: (message: string, options?: ShowNoticeOptions) => void;
};

type ExternalLinksApi = {
  pendingExternalLink: PendingExternalLink | null;
  cancelButtonRef: RefObject<HTMLButtonElement | null>;
  requestExternalLink: (url: string) => void;
  confirmExternalLink: (options?: { always?: boolean }) => void;
  cancelExternalLink: () => void;
  // Clears the confirmation dialog and the per-document trust list.
  reset: () => void;
};

// A PDF-embedded link is never opened silently, and the trust list "always" writes to is per-document, in memory, and never persisted.
export function useExternalLinks({
  onOpenExternalLink,
  fileName,
  sourceIdRef,
  showNotice,
}: ExternalLinksParams): ExternalLinksApi {
  const [pendingExternalLink, setPendingExternalLink] =
    useState<PendingExternalLink | null>(null);
  const [trustedExternalLinkKeys, setTrustedExternalLinkKeys] = useState<
    string[]
  >([]);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const openExternalLink = useCallback(
    async (url: string) => {
      // Re-checked at the point that calls window.open: the guarantee that no javascript: or data: URL is ever opened belongs here, not upstream.
      const safeUrl = safePdfExternalUrl(url);
      if (!safeUrl) {
        showNotice(
          "This link uses an unsupported address and was not opened.",
          {
            tone: "warning",
          },
        );
        return;
      }

      try {
        if (onOpenExternalLink) {
          await onOpenExternalLink(safeUrl, {
            fileName,
            sourceId: sourceIdRef.current,
          });
          return;
        }

        openExternalLinkInNewTab(safeUrl);
      } catch {
        showNotice("Could not open this link.", { tone: "danger" });
      }
    },
    [onOpenExternalLink, fileName, sourceIdRef, showNotice],
  );

  const requestExternalLink = useCallback(
    (url: string) => {
      const link = externalLinkRequest(url);
      if (!link) {
        return;
      }

      if (
        trustedExternalLinkKeys.includes(link.trustKey) &&
        !mailtoNeedsPrompt(link.url)
      ) {
        void openExternalLink(link.url);
        return;
      }

      setPendingExternalLink(link);
    },
    [trustedExternalLinkKeys, openExternalLink],
  );

  const cancelExternalLink = useCallback(() => {
    setPendingExternalLink(null);
  }, []);

  const confirmExternalLink = useCallback(
    ({ always = false }: { always?: boolean } = {}) => {
      // Read the pending link inside the updater so this callback needn't depend on it (a stale closure would confirm the wrong link).
      setPendingExternalLink((link) => {
        if (!link) {
          return null;
        }

        if (always) {
          setTrustedExternalLinkKeys((current) =>
            current.includes(link.trustKey)
              ? current
              : [...current, link.trustKey],
          );
        }
        void openExternalLink(link.url);
        return null;
      });
    },
    [openExternalLink],
  );

  const reset = useCallback(() => {
    setPendingExternalLink(null);
    setTrustedExternalLinkKeys([]);
  }, []);

  // While the dialog is open, focus Cancel and let Escape dismiss. Never Open: Enter on a link opens this dialog, and that key held down repeats into whatever it focuses.
  useEffect(() => {
    if (!pendingExternalLink) {
      return;
    }

    cancelButtonRef.current?.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPendingExternalLink(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingExternalLink]);

  return {
    pendingExternalLink,
    cancelButtonRef,
    requestExternalLink,
    confirmExternalLink,
    cancelExternalLink,
    reset,
  };
}

// Null for anything outside the allowlist, so a link that would be refused never reaches the dialog.
function externalLinkRequest(url: string): PendingExternalLink | null {
  const safeUrl = safePdfExternalUrl(url);
  if (!safeUrl) {
    return null;
  }

  try {
    const parsed = new URL(safeUrl);
    if (parsed.protocol === "mailto:") {
      // Per recipient list, never per scheme: a blanket `mailto:` key would let one approved address approve every other mailto in the document.
      return {
        trustKey: `mailto:${parsed.pathname}`,
        trustScopeLabel: parsed.pathname,
        url: safeUrl,
      };
    }

    return {
      trustKey: parsed.origin,
      trustScopeLabel: parsed.origin,
      url: safeUrl,
    };
  } catch {
    return null;
  }
}

// A mailto trust key covers the address part alone, but the query can name recipients too (to, cc, bcc, reply-to, or a field a mail client knows and this list does not), so a trusted mail link still asks unless its query carries nothing but these.
const SILENT_MAILTO_FIELDS = new Set(["subject", "body"]);

function mailtoNeedsPrompt(url: string) {
  const parsed = new URL(url);
  // URLSearchParams has decoded each name, so a percent-encoded, padded or differently cased "bcc" is still caught.
  return (
    parsed.protocol === "mailto:" &&
    [...parsed.searchParams.keys()].some(
      (name) => !SILENT_MAILTO_FIELDS.has(name.trim().toLowerCase()),
    )
  );
}

function openExternalLinkInNewTab(url: string) {
  const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
  if (!openedWindow) {
    return;
  }

  try {
    openedWindow.opener = null;
  } catch {
    // A fallback: `noopener` is already in the feature string.
  }
}
