import type { PdfPrintTarget } from "../tabbedapp";
import { uint8ArrayToArrayBuffer } from "../bytes";
import { downloadPdfBytes } from "./localFileAccess";

// Exported so the e2e print test can wait past this rather than racing a
// separate, hand-picked window against real (and machine-dependent) PDF
// render time in the iframe.
export const PRINT_FRAME_FALLBACK_MS = 4000;
const PRINT_BLOB_REVOKE_MS = 10 * 60 * 1000;

export function browserPrintTarget(): PdfPrintTarget {
  return printPdfInFrame;
}

// Each call owns its own blob URL and iframe, never module-level state: two
// print jobs can be in flight at once, and shared state means the second
// revokes the first's URL and removes its iframe mid-print.
function printPdfInFrame(bytes: Uint8Array, outputName: string) {
  const url = URL.createObjectURL(
    new Blob([uint8ArrayToArrayBuffer(bytes)], { type: "application/pdf" }),
  );
  const frame = document.createElement("iframe");
  frame.title = "Printable PDF";
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    border: "0",
    bottom: "0",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
    position: "fixed",
    right: "0",
    width: "1px",
  });

  let blobUrl: string | null = url;
  let printFrame: HTMLIFrameElement | null = frame;

  function revokeBlobUrl() {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

  function removePrintFrame() {
    if (printFrame) {
      printFrame.remove();
      printFrame = null;
    }
  }

  function cleanupPrintResources() {
    window.clearTimeout(revokeTimer);
    removePrintFrame();
    revokeBlobUrl();
  }

  const revokeTimer = window.setTimeout(revokeBlobUrl, PRINT_BLOB_REVOKE_MS);

  return new Promise<void>((resolve) => {
    let printRequested = false;
    let settled = false;
    const fallbackTimer = window.setTimeout(
      fallbackToDownload,
      PRINT_FRAME_FALLBACK_MS,
    );

    function finish() {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(fallbackTimer);
      resolve();
    }

    function fallbackToDownload() {
      if (settled) {
        return;
      }

      // A download, never a new tab: a printable tab has to be opened without
      // `noopener`, handing a window reference to untrusted PDF bytes.
      cleanupPrintResources();
      downloadPdfBytes(bytes, outputName);
      finish();
    }

    const requestFramePrint = () => {
      if (printRequested || settled) {
        return;
      }

      printRequested = true;
      try {
        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
          throw new Error("Print frame is not available.");
        }

        frameWindow.addEventListener("afterprint", cleanupPrintResources, {
          once: true,
        });
        frameWindow.focus();
        frameWindow.print();
        finish();
      } catch {
        fallbackToDownload();
      }
    };

    frame.addEventListener(
      "load",
      () => window.setTimeout(requestFramePrint, 250),
      { once: true },
    );
    frame.addEventListener("error", fallbackToDownload, { once: true });

    frame.src = url;
    document.body.append(frame);
  });
}
