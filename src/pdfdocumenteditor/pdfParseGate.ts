// pdf-lib parses and decodes on whatever thread calls it, and nothing caps what a stream inflates to: a file of a few kilobytes can inflate to gigabytes, freezing or crashing the tab, and every open document's unsaved work with it. So a new file's bytes reach pdf-lib on the main thread only after a worker has made the same reads, within a time limit and with no stream decoding past 64 MB (pdfParseCheck.ts). A file that breaks either limit is refused, and the worker is ended, its memory with it. pdf-lib's own output from bytes that passed needs no check of its own: it holds nothing those bytes did not.
//
// The time limit covers a file made of many streams, each under 64 MB. It grows with the file, as an ordinary file's read does: about 0.13 s per MB in Chromium when measured on 2026-09-30 (3 s for a 2,000-page, 24 MB book), so a flat limit would refuse large books on slower devices. Four times that rate, on top of 5 s, leaves room for a device several times slower.
const PDF_READ_BASE_MS = 5_000;
const PDF_READ_MS_PER_MB = 500;

// Never rejects: it is started beside pdf.js's own load, which can fail first and leave it unawaited.
export function pdfReadsWithinLimits(bytes: Uint8Array) {
  const limitMs =
    PDF_READ_BASE_MS + (bytes.byteLength / 1_048_576) * PDF_READ_MS_PER_MB;
  return new Promise<boolean>((resolve) => {
    let worker: Worker | undefined;
    const finish = (read: boolean) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(read);
    };
    const timer = setTimeout(() => finish(false), limitMs);
    try {
      worker = new Worker(
        new URL("./pdfParseCheck.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener("message", (event: MessageEvent<string>) =>
        finish(event.data === "read"),
      );
      // A worker that cannot start, or dies, has not shown the file is safe to read.
      worker.addEventListener("error", () => finish(false));
      // A copy, transferred: the caller keeps its bytes, and the worker's go with it.
      const copy = bytes.slice();
      worker.postMessage(copy, [copy.buffer]);
    } catch {
      finish(false);
    }
  });
}
