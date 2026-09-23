const PDF_LINK_REL = "noopener noreferrer nofollow";
const PDF_LINK_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

type PdfLinkServiceOptions = {
  onExternalLinkRequest: (url: string) => void;
  onNavigateDestination: (destination: string | unknown[]) => void;
  onNavigatePage: (pageIndex: number) => void;
  pageCount: number;
  pageIndex: number;
};

export function createPdfLinkService({
  onExternalLinkRequest,
  onNavigateDestination,
  onNavigatePage,
  pageCount,
  pageIndex,
}: PdfLinkServiceOptions) {
  return {
    externalLinkEnabled: true,
    externalLinkTarget: 2,
    externalLinkRel: PDF_LINK_REL,
    eventBus: {
      dispatch: () => undefined,
    },
    addLinkAttributes: (link: HTMLAnchorElement, url: string) => {
      const safeUrl = safePdfExternalUrl(url);
      if (!safeUrl) {
        link.removeAttribute("href");
        link.title = "Blocked unsupported PDF link";
        link.classList.add("pdfdocumenteditor-blocked-link");
        return;
      }

      link.removeAttribute("href");
      link.rel = PDF_LINK_REL;
      link.referrerPolicy = "no-referrer";
      link.role = "link";
      link.tabIndex = 0;
      link.target = "_blank";
      // The element has no text of its own, and pdf.js gives it only a
      // `title`, which is the last resort in the accessible-name algorithm and
      // never reaches a touch user.
      link.title = safeUrl;
      link.setAttribute("aria-label", `Open link: ${safeUrl}`);
      link.classList.add("pdfdocumenteditor-external-link");
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        onExternalLinkRequest(safeUrl);
      });
      link.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        onExternalLinkRequest(safeUrl);
      });
    },
    getDestinationHash: () => "#",
    getAnchorUrl: (hash: string) => hash || "#",
    goToDestination: (destination: string | unknown[]) => {
      onNavigateDestination(destination);
    },
    goToPage: (pageNumber: number) => {
      if (Number.isFinite(pageNumber)) {
        onNavigatePage(pageNumber - 1);
      }
    },
    executeNamedAction: (action: string) => {
      switch (action) {
        case "FirstPage":
          onNavigatePage(0);
          break;
        case "PrevPage":
          onNavigatePage(pageIndex - 1);
          break;
        case "NextPage":
          onNavigatePage(pageIndex + 1);
          break;
        case "LastPage":
          onNavigatePage(pageCount - 1);
          break;
      }
    },
    executeSetOCGState: () => undefined,
    cachePageRef: () => undefined,
  };
}

// Exported so the point that calls window.open re-applies the same allowlist
// rather than trusting that a caller upstream sanitized first.
export function safePdfExternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!PDF_LINK_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }

    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return null;
  }
}

export const downloadManager = {
  openOrDownloadData: () => undefined,
  downloadData: () => undefined,
};
