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
      fallbackToDownload,
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

    function fallbackToDownload() {
      if (settled) {
        return;
      }

      // Deliberately a download rather than "open the PDF in a new tab so the
      // user can print it there": that tab would have to be opened without
      // `noopener` to be usable, which hands a window reference to a document
      // whose bytes came from an untrusted PDF. (It also silently did nothing
      // before - `window.open` returns null whenever `noopener` is set, so
      // the tab attempt could never succeed and every print already landed
      // here.) A downloaded copy prints from any local PDF reader.
      //
      // Full cleanup rather than just dropping the frame: nothing is going to
      // print from this blob URL now, and the download below builds its own,
      // so there's no reason to hold the document's bytes alive until the
      // 10-minute revoke timer fires.
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
          throw new Error('Print frame is not available.');
        }

        frameWindow.addEventListener('afterprint', cleanupPrintResources, {
          once: true
        });
        frameWindow.focus();
        frameWindow.print();
        finish();
      } catch {
        fallbackToDownload();
      }
    };

    frame.addEventListener(
      'load',
      () => window.setTimeout(requestFramePrint, 250),
      { once: true }
    );
    frame.addEventListener('error', fallbackToDownload, { once: true });

    frame.src = url;
    document.body.append(frame);
  });
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
