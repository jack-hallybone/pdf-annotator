import {
  PDFContext,
  PDFDocument,
  PDFRawStream,
  ParseSpeeds,
  decodePDFRawStream,
  type PDFDict,
} from "pdf-lib";
import { pdfAClaimingMetadataRefs } from "./pdfProtection";

// No ordinary object or cross-reference stream decodes to anything near this, nor does the metadata scan, which stops at 32 MB. A bomb reaches it in well under a second.
const MAX_DECODED_STREAM_BYTES = 64 * 1024 * 1024;

let streamStopped = false;

// pdf-lib parses on past an object stream it cannot decode, whether the stream is malformed or ran out of memory, so a parse that finishes shows nothing: the editor's own parse would spend the same time and memory before giving up the same way. Every pdf-lib decoder grows its output through one method of the class they share, which pdf-lib does not export. Called once in the worker, never on the page, this wraps that method so a stream stops the moment it would pass the limit, and the check notes that it did.
export function stopStreamsDecodingPastLimit() {
  const sample = decodePDFRawStream(
    PDFRawStream.of(
      PDFContext.create().obj({ Filter: "ASCIIHexDecode" }) as PDFDict,
      new Uint8Array(),
    ),
  );
  const decodeStream = Object.getPrototypeOf(Object.getPrototypeOf(sample)) as {
    ensureBuffer: (this: unknown, requested: number) => Uint8Array;
  };
  const ensureBuffer = decodeStream.ensureBuffer;
  // Stops the worker from starting, so every file is refused, rather than letting a later pdf-lib pass unchecked. tests/pdf-read-check.test.ts catches a change this cannot see.
  if (typeof ensureBuffer !== "function") {
    throw new Error(
      "pdf-lib's decoders have changed: the read check cannot cap them.",
    );
  }
  decodeStream.ensureBuffer = function (requested) {
    if (requested > MAX_DECODED_STREAM_BYTES) {
      streamStopped = true;
      throw new RangeError("A stream decodes past the read check's limit.");
    }
    return ensureBuffer.call(this, requested);
  };
}

// The reads the editor makes of a new file's bytes before showing it, whose cost the file sets, not its size: the parse, which inflates every object and cross-reference stream whole, and the PDF/A metadata scan. "read" once they are done, or have failed as the editor's own then fail, having spent no more; "refused" when a stream would decode past the limit. pdfParseGate.ts runs this in a worker, within a time limit. A page delete's content scan is not among these reads: it stops at its own budget (pdfPageOperations.ts).
export async function readAsTheEditorWould(bytes: Uint8Array) {
  streamStopped = false;
  try {
    // The protection check's options. The editor's other loads parse the same way and only then refuse an encrypted file.
    const pdfDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      parseSpeed: ParseSpeeds.Fastest,
      updateMetadata: false,
    });
    pdfAClaimingMetadataRefs(pdfDoc.context);
  } catch {
    // The editor's own reads get exactly this far, and no further.
  }
  return streamStopped ? "refused" : "read";
}
