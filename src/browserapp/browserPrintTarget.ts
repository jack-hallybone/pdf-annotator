import type { PdfPrintTarget } from '../workspace';
import { uint8ArrayToArrayBuffer } from '../bytes';
import { safePdfFileName } from '../fileNames';

const PRINT_FRAME_FALLBACK_MS = 4000;
const PRINT_BLOB_REVOKE_MS = 10 * 60 * 1000;

export function browserPrintTarget(): PdfPrintTarget {
  return printPdfInFrame;
}

// Each call owns its own blob URL/iframe rather than sharing module-level
// state: this app is a multi-tab/multi-document shell, so two Print
// invocations can legitimately be in flight at once (printing from two tabs
// back to back, or clicking Print again before the first print dialog has
// closed). Shared state here previously meant the second call's setup would
// revoke the first call's still-in-use blob URL and rip its iframe out of
// the DOM, breaking/blanking whichever print job was still open.
function printPdfInFrame(bytes: Uint8Array, outputName: string) {
  const url = URL.createObjectURL(
    new Blob([uint8ArrayToArrayBuffer(bytes)], { type: 'application/pdf' })
  );
  const frame = document.createElement('iframe');
  frame.title = 'Printable PDF';
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    border: '0',
    bottom: '0',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    position: 'fixed',
    right: '0',
    width: '1px'
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
      fallbackToTabOrDownload,
      PRINT_FRAME_FALLBACK_MS
    );

    function finish() {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(fallbackTimer);
      resolve();
    }

    function fallbackToTabOrDownload() {
      if (settled) {
        return;
      }

      removePrintFrame();
      if (!openPrintablePdfInTab(url)) {
        downloadPdfBytes(bytes, outputName);
      }
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
          throw new Error('Print frame is not available.');
        }

        frameWindow.addEventListener('afterprint', cleanupPrintResources, {
          once: true
        });
        frameWindow.focus();
        frameWindow.print();
        finish();
      } catch {
        fallbackToTabOrDownload();
      }
    };

    frame.addEventListener(
      'load',
      () => window.setTimeout(requestFramePrint, 250),
      { once: true }
    );
    frame.addEventListener('error', fallbackToTabOrDownload, { once: true });

    frame.src = url;
    document.body.append(frame);
  });
}

function openPrintablePdfInTab(url: string) {
  const printWindow = window.open(url, '_blank', 'noopener,noreferrer');
  if (!printWindow) {
    return false;
  }

  try {
    printWindow.opener = null;
  } catch {
    // The fallback tab can still be printed manually.
  }

  let printRequested = false;
  const requestPrint = () => {
    if (printRequested) {
      return;
    }

    printRequested = true;
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      // The PDF tab remains usable even if automatic print is blocked.
    }
  };

  try {
    printWindow.addEventListener(
      'load',
      () => window.setTimeout(requestPrint, 250),
      { once: true }
    );
  } catch {
    // The timeout fallback below still leaves the PDF tab available.
  }

  window.setTimeout(requestPrint, 1500);
  return true;
}

function downloadPdfBytes(bytes: Uint8Array, outputName: string) {
  const blob = new Blob([uint8ArrayToArrayBuffer(bytes)], {
    type: 'application/pdf'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safePdfFileName(outputName);
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
