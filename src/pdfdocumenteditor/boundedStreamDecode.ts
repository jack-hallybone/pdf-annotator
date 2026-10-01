import { PDFRawStream, decodePDFRawStream } from "pdf-lib";
import type { PDFStream } from "pdf-lib";

// Read a stream in pulls this size rather than one decode() call, so a stream that expands past the remaining budget (a decompression bomb, or simply a lot of legitimate content) is caught as soon as it does, not after the whole thing has already been inflated into memory to find out.
const DECODE_CHUNK_BYTES = 1024 * 1024;

export type BoundedDecode =
  { ok: true; bytes: Uint8Array } | { ok: false; overBudget: boolean };

// A malicious /FlateDecode stream can claim only a few compressed bytes and still expand to gigabytes; decoding it whole before checking its size would pay for that expansion just to find out. This reads it in bounded pulls instead of one decode() call, so a stream that grows past the remaining budget is caught as soon as it does, not after the whole thing has already been inflated into memory to find out. (A ratio-based check against the compressed size alone was tried and dropped: legitimate, ordinary page content can compress at ratios well past what a fixed "suspicious" cutoff could allow without also catching real pages that are not a threat, and a cutoff loose enough to spare them is too loose to tell a small-and-dangerous stream from a small-and-fine one either.) getBytes() still decodes one whole deflate block per pull with no size cap of its own, so this bounds how OFTEN the budget is checked, not what a single pull can produce: a stream hand-built as one giant block can still land far past budget in one call. zlib-style encoders end a block every few MB of output at most.
export function decodedWithinBudget(
  stream: PDFStream,
  budget: number,
): BoundedDecode {
  if (!(stream instanceof PDFRawStream)) {
    return { ok: false, overBudget: false };
  }

  try {
    const source = decodePDFRawStream(stream);
    // Never actually a Uint8ClampedArray here - forceClamped is left at its default false - but getBytes' own type covers both.
    const pieces: (Uint8Array | Uint8ClampedArray)[] = [];
    let total = 0;
    while (!source.isEmpty) {
      const chunk = source.getBytes(DECODE_CHUNK_BYTES);
      if (chunk.length === 0) {
        break;
      }
      total += chunk.length;
      if (total > budget) {
        return { ok: false, overBudget: true };
      }
      // Copied out: a decode stream's own buffer can be reallocated by a later pull, which would silently invalidate an earlier subarray.
      pieces.push(chunk.slice());
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.length;
    }
    return { ok: true, bytes: joined };
  } catch {
    return { ok: false, overBudget: false };
  }
}
