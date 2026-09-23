import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  type PDFObject,
} from "pdf-lib";

// A byte scan answers "is this text still in the file?" wrongly in both
// directions - a page's text is written as `<hex> Tj` inside a deflated content
// stream, so a file full of the word reads clean, and a run of digits in a font
// table reads as a hit - so the document is walked object by object.

export async function markersIn(bytes: Uint8Array, pattern: RegExp) {
  const pdfDoc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const found = new Set<string>();
  for (const [, object] of pdfDoc.context.enumerateIndirectObjects()) {
    for (const marker of markersOf(object, pattern)) {
      found.add(marker);
    }
  }
  return found;
}

export function matches(text: string, pattern: RegExp) {
  return text.match(new RegExp(pattern.source, "g")) ?? [];
}

function markersOf(object: PDFObject, pattern: RegExp, depth = 0): string[] {
  if (depth > 32) {
    return [];
  }
  if (object instanceof PDFString || object instanceof PDFHexString) {
    return matches(object.decodeText(), pattern);
  }
  if (object instanceof PDFName || object instanceof PDFNumber) {
    return matches(object.toString(), pattern);
  }
  if (object instanceof PDFArray) {
    return object
      .asArray()
      .flatMap((value) => markersOf(value, pattern, depth + 1));
  }
  if (object instanceof PDFStream) {
    return [
      ...markersOf(object.dict, pattern, depth + 1),
      ...matches(streamText(object), pattern),
    ];
  }
  if (object instanceof PDFDict) {
    return object
      .entries()
      .flatMap(([key, value]) => [
        ...matches(key.toString(), pattern),
        ...markersOf(value, pattern, depth + 1),
      ]);
  }
  return [];
}

export function streamText(object: PDFStream) {
  if (!(object instanceof PDFRawStream)) {
    return "";
  }

  const raw = Buffer.from(object.contents);
  const filter = object.dict.get(PDFName.of("Filter"));
  const flate = PDFName.of("FlateDecode");
  const deflated =
    filter === flate ||
    (filter instanceof PDFArray && filter.asArray().includes(flate));
  let text: string;
  try {
    text = (deflated ? inflateSync(raw) : raw).toString("latin1");
  } catch {
    text = raw.toString("latin1");
  }

  // The decoded hex runs are appended rather than substituted, so a marker written
  // plainly and one written as `<hex>` are both visible.
  return `${text}\n${decodeHexRuns(text)}`;
}

function decodeHexRuns(text: string) {
  return text.replace(/<([0-9A-Fa-f\s]+)>/g, (whole, hex: string) => {
    const clean = hex.replace(/\s+/g, "");
    return clean.length % 2 === 0
      ? Buffer.from(clean, "hex").toString("latin1")
      : whole;
  });
}
