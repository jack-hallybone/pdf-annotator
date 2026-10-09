import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFPageTree,
  PDFRawStream,
  PDFRef,
  PDFStream,
  ParseSpeeds,
} from "pdf-lib";
import type { PDFContext } from "pdf-lib";
import { decodedWithinBudget } from "./boundedStreamDecode";
import {
  resolvedArrayEntry,
  resolvedDictAt,
  resolvedDictEntry,
  resolvedNameEntry,
  resolvedNumberEntry,
} from "./pdfLookup";

const pdfProtectionLoadOptions = {
  ignoreEncryption: true,
  parseSpeed: ParseSpeeds.Fastest,
  updateMetadata: false,
};

const MAX_PROTECTION_FIELD_ENTRIES = 10_000;
// pdfPageOperations.ts strips exactly the streams these are found in, so the two must agree: a claim one side cannot see is left in the output.
const pdfaXmpMarkers = ["pdfaid:part", "pdfaid:conformance"];
// Shared by every compressed packet in one scan, which runs on the main thread on every open and save. A real XMP packet is kilobytes.
export const MAX_METADATA_DECODE_BYTES = 32 * 1024 * 1024;

export type PdfDocumentEditorReadOnlyReason =
  | "PDF/A compliant"
  | "ambiguous page order"
  | "password protected"
  | "signed/certified";

export async function detectReadOnlyReason(
  bytes: Uint8Array,
  pdfDoc: Pick<PDFDocumentProxy, "getMetadata" | "getPage" | "numPages"> | null,
  passwordProtected: boolean,
): Promise<PdfDocumentEditorReadOnlyReason | null> {
  if (passwordProtected) {
    return "password protected";
  }

  if (await pdfLooksEncrypted(bytes)) {
    return "password protected";
  }

  // The structural checks below read one parse: each would otherwise load the whole file again, and this runs on every open, before page 1 shows.
  let parsed: Promise<PDFDocument> | undefined;
  const parse = () => (parsed ??= loadForProtectionCheck(bytes));

  // Ahead of the two reasons that offer "Edit a copy": a copy is written the same way, so its edits would land on the same wrong pages.
  if (pdfDoc && (await pageListsDisagree(pdfDoc, parse))) {
    return "ambiguous page order";
  }

  if (await pdfLooksPdfA(bytes, pdfDoc, parse)) {
    return "PDF/A compliant";
  }

  if (
    pdfLooksSignedOrCertified(bytes) ||
    (await pdfLooksStructurallySignedOrCertified(bytes, parse))
  ) {
    return "signed/certified";
  }

  return null;
}

export async function pdfLooksEncrypted(bytes: Uint8Array) {
  if (!bytesContainPdfMarker(bytes, "/Encrypt")) {
    return false;
  }

  try {
    const pdfDoc = await PDFDocument.load(bytes, pdfProtectionLoadOptions);
    return pdfDoc.isEncrypted;
  } catch {
    return true;
  }
}

export async function pdfLooksPdfA(
  bytes: Uint8Array,
  pdfDoc?: Pick<PDFDocumentProxy, "getMetadata"> | null,
  parse = () => loadForProtectionCheck(bytes),
) {
  if (pdfLooksPdfAByRawMarkers(bytes)) {
    return true;
  }

  try {
    const metadata = await pdfDoc?.getMetadata?.();
    const rawMetadata =
      metadata?.metadata?.getRaw?.() ??
      metadata?.metadata?.get?.("pdfaid:part") ??
      metadata?.metadata?.get?.("pdfaid:conformance") ??
      "";
    if (
      typeof rawMetadata === "string" &&
      /pdfaid:part|pdfaid:conformance/i.test(rawMetadata)
    ) {
      return true;
    }
  } catch {
    // Fall through to the structural output-intent check below.
  }

  return pdfLooksStructurallyPdfA(parse);
}

export function pdfLooksSignedOrCertified(bytes: Uint8Array) {
  // A page's drawn content, an embedded image or a form field's appearance can legitimately spell out any of these marker strings - a manual, or an annotation quoting one of these key names - without the file actually being signed. Only a match outside every stream's own data can fail this file closed.
  const skip = contentStreamSpans(bytes);
  return (
    bytesContainPdfMarker(bytes, "/ByteRange", { skip }) ||
    bytesContainPdfMarker(bytes, "/DocMDP", { skip }) ||
    bytesContainPdfMarker(bytes, "/Perms", { skip }) ||
    bytesContainPdfMarker(bytes, "/SigFlags", { skip }) ||
    bytesContainPdfMarker(bytes, "/Type /Sig", { skip }) ||
    bytesContainPdfMarker(bytes, "/SubFilter /adbe.pkcs7", {
      caseInsensitive: true,
      skip,
    }) ||
    bytesContainPdfMarker(bytes, "/SubFilter /ETSI.", {
      caseInsensitive: true,
      skip,
    })
  );
}

export async function pdfLooksStructurallySignedOrCertified(
  bytes: Uint8Array,
  parse = () => loadForProtectionCheck(bytes),
) {
  try {
    return pdfDocumentLooksSignedOrCertified(await parse());
  } catch {
    // Fail-closed: an unparseable form structure is treated as protected rather than assumed to hold no signature.
    return true;
  }
}

async function pdfLooksStructurallyPdfA(parse: () => Promise<PDFDocument>) {
  try {
    return pdfDocumentLooksPdfA(await parse());
  } catch {
    return false;
  }
}

// pdf.js shows the pages and pdf-lib writes them, each by index, so an annotation or a page edit lands where the reader put it only while both list the same page objects in the same order. A malformed page tree can split them - pdf.js takes a leaf with no /Type for a page where pdf-lib skips it, and /Count can hide pages from pdf.js alone - and the counts can still agree, so the objects themselves are compared.
async function pageListsDisagree(
  pdfDoc: Pick<PDFDocumentProxy, "getPage" | "numPages">,
  parse: () => Promise<PDFDocument>,
) {
  let parsedDoc: PDFDocument;
  try {
    parsedDoc = await parse();
  } catch {
    // Nothing is written to a file pdf-lib cannot parse, and the signature check below already fails it closed.
    return false;
  }

  try {
    if (pageTreeRepeatsABranch(parsedDoc)) {
      return true;
    }
    const pages = parsedDoc.getPages();
    if (pages.length !== pdfDoc.numPages) {
      return true;
    }
    for (const [index, page] of pages.entries()) {
      // The open's annotation budget check has fetched every page already, so pdf.js answers these from its cache.
      const { ref } = await pdfDoc.getPage(index + 1);
      if (
        ref?.num !== page.ref.objectNumber ||
        ref.gen !== page.ref.generationNumber
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // A page list either library cannot read to the end cannot be shown to match.
    return true;
  }
}

// pdf-lib walks the page tree with no record of where it has been, so a /Pages node listed under two parents, or under itself, is walked once for every path to it: a few kilobytes of /Kids can ask for billions of visits, all on the main thread. This visits each /Pages node once and stops at the first one it meets again, which no well-formed tree has. A page listed twice costs pdf-lib one more visit, not a multiplication, so it is left to the page-order check above.
export function pageTreeRepeatsABranch(pdfDoc: PDFDocument) {
  const root = resolvedDictEntry(pdfDoc.catalog, PDFName.of("Pages"));
  if (!(root instanceof PDFPageTree)) {
    return false;
  }

  const seen = new Set<PDFDict>([root]);
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    const kids = resolvedArrayEntry(node, PDFName.of("Kids"));
    for (let index = 0; kids && index < kids.size(); index += 1) {
      const kid = resolvedDictAt(kids, index);
      if (!(kid instanceof PDFPageTree)) {
        continue;
      }
      if (seen.has(kid)) {
        return true;
      }
      seen.add(kid);
      pending.push(kid);
    }
  }
  return false;
}

// These checks only read what this returns, so detectReadOnlyReason can hand them the same parse.
function loadForProtectionCheck(bytes: Uint8Array) {
  return PDFDocument.load(bytes, pdfProtectionLoadOptions);
}

export async function verifyEditedPdfProtectionClaims(bytes: Uint8Array) {
  const rawPdfA = pdfLooksPdfAByRawMarkers(bytes);
  const rawSigned = pdfLooksSignedOrCertified(bytes);
  try {
    const pdfDoc = await PDFDocument.load(bytes, pdfProtectionLoadOptions);
    return {
      pdfa: rawPdfA || pdfDocumentLooksPdfA(pdfDoc),
      signed: rawSigned || pdfDocumentLooksSignedOrCertified(pdfDoc),
      verified: true,
    };
  } catch {
    return { pdfa: rawPdfA, signed: rawSigned, verified: false };
  }
}

// The claim's own markers, never the words "PDF/A": a page, a note or other metadata can spell those out without claiming anything, and counting them opened such a file read-only and, once edited, stopped every save, since no strip removes the reader's own text.
function pdfLooksPdfAByRawMarkers(bytes: Uint8Array) {
  return (
    bytesContainPdfMarker(bytes, "pdfaid:part", { caseInsensitive: true }) ||
    bytesContainPdfMarker(bytes, "pdfaid:conformance", {
      caseInsensitive: true,
    }) ||
    bytesContainPdfMarker(bytes, "GTS_PDFA", { caseInsensitive: true })
  );
}

function pdfDocumentLooksPdfA(pdfDoc: PDFDocument) {
  if (
    allIndirectDicts(pdfDoc).some((dict) =>
      resolvedNameEntry(dict, PDFName.of("S"))
        ?.decodeText()
        .startsWith("GTS_PDFA"),
    )
  ) {
    return true;
  }

  // Neither cheaper check sees a claim in an undeclared, compressed packet: pdf.js surfaces metadata only when the stream declares /Type /Metadata.
  return pdfAClaimingMetadataRefs(pdfDoc.context).size > 0;
}

/* A stream counts as metadata when it says so or when a dictionary points at it through /Metadata: without the second half, a compressed packet declaring neither is invisible to the strip. */
export function pdfAClaimingMetadataRefs(context: PDFContext) {
  const metadataKey = PDFName.of("Metadata");
  const referencedAsMetadata = new Set<string>();
  for (const [, object] of context.enumerateIndirectObjects()) {
    const dict =
      object instanceof PDFDict
        ? object
        : object instanceof PDFStream
          ? object.dict
          : null;
    const ref = dict?.get(metadataKey);
    if (ref instanceof PDFRef) {
      referencedAsMetadata.add(ref.tag);
    }
  }

  const claimingRefs = new Set<PDFRef>();
  const scan = { budget: MAX_METADATA_DECODE_BYTES };
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) {
      continue;
    }
    if (!streamDeclaresMetadata(object) && !referencedAsMetadata.has(ref.tag)) {
      continue;
    }
    if (
      bytesClaimPdfA(object.contents) ||
      decodedPacketClaimsPdfA(object, scan)
    ) {
      claimingRefs.add(ref);
    }
  }
  return claimingRefs;
}

function streamDeclaresMetadata(stream: PDFRawStream) {
  const type = resolvedNameEntry(stream.dict, PDFName.of("Type"))?.asString();
  const subtype = resolvedNameEntry(
    stream.dict,
    PDFName.of("Subtype"),
  )?.asString();
  return type === "/Metadata" || subtype === "/XML";
}

function bytesClaimPdfA(bytes: Uint8Array) {
  return pdfaXmpMarkers.some((marker) =>
    bytesContainPdfMarker(bytes, marker, { caseInsensitive: true }),
  );
}

// PDF/A requires an unfiltered metadata stream, so the raw scan covers conforming files; this catches a claim made from a compressed packet. A packet past the budget counts as a claim, as an unreadable signature field counts as a signature: otherwise enough padding would carry a claim through an edit, and a save would leave it in unseen.
function decodedPacketClaimsPdfA(
  stream: PDFRawStream,
  scan: { budget: number },
) {
  if (!stream.dict.get(PDFName.of("Filter"))) {
    return false;
  }

  const decoded = decodedWithinBudget(stream, scan.budget);
  if (!decoded.ok) {
    return decoded.overBudget;
  }
  scan.budget -= decoded.bytes.length;
  return bytesClaimPdfA(decoded.bytes);
}

/* The rest of a claiming packet is the file's own title, authors, DOI and the like, which a reference manager reads, so the strip takes out only the pdfaid properties where it can. Null sends the packet whole, as every claiming packet once went: it isn't strict UTF-8, its claim takes some other form, or what is left would still trip the raw-marker check saveEditedPdf verifies its output with. */
export function metadataStreamWithoutPdfAClaim(
  stream: PDFRawStream,
  scan: { budget: number },
) {
  let packet = stream.contents;
  if (stream.dict.get(PDFName.of("Filter"))) {
    const decoded = decodedWithinBudget(stream, scan.budget);
    if (!decoded.ok) {
      return null;
    }
    scan.budget -= decoded.bytes.length;
    packet = decoded.bytes;
  }

  let xmp: string;
  try {
    // ignoreBOM keeps a leading byte-order mark, so every byte the edits below leave alone is written back as it was.
    xmp = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      packet,
    );
  } catch {
    return null;
  }
  // UTF-16 or UTF-32 text with no byte-order mark is valid UTF-8 too, and its NULs give it away.
  if (xmp.includes("\u0000")) {
    return null;
  }

  // Each pattern opens with "<pdfaid:" or a single space, never a repeat such as \s+, which a packet's padding would make the engine retry from every position in it.
  const kept = new TextEncoder().encode(
    xmp
      .replace(/<pdfaid:\w+(?:\s[^<>]*)?\/>/gi, "")
      .replace(/<pdfaid:(\w+)(?:\s[^<>]*)?>[^<]*<\/pdfaid:\1\s*>/gi, "")
      .replace(/\spdfaid:\w+\s*=\s*(?:"[^"<]*"|'[^'<]*')/gi, ""),
  );
  if (pdfLooksPdfAByRawMarkers(kept)) {
    return null;
  }

  // Written unfiltered, as PDF/A asks of metadata, so the byte scans read it as it stands.
  const dict = stream.dict.clone();
  for (const key of ["Filter", "DecodeParms", "DL", "Length"]) {
    dict.delete(PDFName.of(key));
  }
  return PDFRawStream.of(dict, kept);
}

function pdfDocumentLooksSignedOrCertified(pdfDoc: PDFDocument) {
  const { catalog } = pdfDoc;
  const perms = resolvedDictEntry(catalog, PDFName.of("Perms"));
  if (perms?.get(PDFName.of("DocMDP")) || perms?.get(PDFName.of("UR3"))) {
    return true;
  }

  // The long-term-validation certificate/VRI store: present only alongside a signature, and pdfPageOperations.ts strips it in the same pass as /Sig.
  if (catalog.has(PDFName.of("DSS"))) {
    return true;
  }

  const acroForm = resolvedDictEntry(catalog, PDFName.of("AcroForm"));
  const sigFlags = acroForm
    ? resolvedNumberEntry(acroForm, PDFName.of("SigFlags"))?.asNumber()
    : undefined;
  if (sigFlags && sigFlags > 0) {
    return true;
  }

  const fields = acroForm
    ? resolvedArrayEntry(acroForm, PDFName.of("Fields"))
    : undefined;
  if (fields && fieldTreeContainsSignature(fields)) {
    return true;
  }

  return allIndirectDicts(pdfDoc).some((dict) => {
    const type = resolvedNameEntry(dict, PDFName.of("Type"))?.decodeText();
    return type === "Sig" || dict.has(PDFName.of("ByteRange"));
  });
}

function fieldTreeContainsSignature(fields: PDFArray) {
  const stack: PDFArray[] = [fields];
  const visitedRefs = new Set<string>();
  const visitedDicts = new Set<PDFDict>();
  let inspectedEntries = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (let index = 0; index < current.size(); index += 1) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_PROTECTION_FIELD_ENTRIES) {
        // An attacker-controlled field tree must not create an unbounded walk or leave a partially inspected document declared unsigned.
        return true;
      }

      try {
        const raw = current.get(index);
        if (raw instanceof PDFRef) {
          const key = raw.toString();
          if (visitedRefs.has(key)) {
            continue;
          }
          visitedRefs.add(key);
        }
        const resolved = current.lookup(index);
        const field = resolved instanceof PDFDict ? resolved : undefined;
        if (!field || visitedDicts.has(field)) {
          continue;
        }
        visitedDicts.add(field);
        const fieldType = resolvedNameEntry(
          field,
          PDFName.of("FT"),
        )?.decodeText();
        const value = resolvedDictEntry(field, PDFName.of("V"));
        const valueType = value
          ? resolvedNameEntry(value, PDFName.of("Type"))?.decodeText()
          : undefined;
        if (fieldType === "Sig" || valueType === "Sig") {
          return true;
        }
        const kids = resolvedArrayEntry(field, PDFName.of("Kids"));
        if (kids) {
          stack.push(kids);
        }
      } catch {
        // A malformed field entry leaves signature status unknowable, so the source is preserved rather than made editable.
        return true;
      }
    }
  }
  return false;
}

// lookupMaybe throws when an entry exists with a different legal PDF type, which is common for form values, so these checks resolve without a requested type and narrow afterwards rather than call a healthy document unverifiable.

function allIndirectDicts(pdfDoc: PDFDocument) {
  const dicts: PDFDict[] = [pdfDoc.catalog];
  for (const [, object] of pdfDoc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      dicts.push(object);
    } else if (object instanceof PDFStream) {
      dicts.push(object.dict);
    }
  }
  return dicts;
}

function bytesContainPdfMarker(
  bytes: Uint8Array,
  pattern: string,
  {
    caseInsensitive = false,
    skip,
  }: {
    caseInsensitive?: boolean;
    skip?: ReadonlyArray<readonly [number, number]>;
  } = {},
) {
  const needle = Array.from(pattern, (char) => char.charCodeAt(0));
  if (needle.length === 0 || bytes.length < needle.length) {
    return false;
  }

  const lastStart = bytes.length - needle.length;
  // The check below decodes a #xx escape at any position, the first included ("/S /#47TS_PDFA1"), so a "#" opens a candidate too.
  const nextStart = firstByteFinder(bytes, [
    caseInsensitive ? asciiLower(needle[0]) : needle[0],
    caseInsensitive ? asciiUpper(needle[0]) : needle[0],
    0x23,
  ]);
  // `skip` is produced in ascending, non-overlapping order, so one forward pointer keeps this in step with `index` instead of rescanning it per byte.
  let skipIndex = 0;
  let index = nextStart(0);
  while (index !== -1 && index <= lastStart) {
    while (skip && skipIndex < skip.length && index >= skip[skipIndex][1]) {
      skipIndex += 1;
    }
    const span = skip?.[skipIndex];
    if (span && index >= span[0]) {
      index = nextStart(span[1]);
      continue;
    }

    let matched = true;
    let at = index;
    for (let offset = 0; offset < needle.length; offset += 1) {
      // A PDF name can spell any byte as #xx, in either hex case, and a validator that decodes it still sees "/ByteR#61nge" as "/ByteRange".
      const escaped =
        bytes[at] === 0x23 &&
        hexDigit(bytes[at + 1]) !== -1 &&
        hexDigit(bytes[at + 2]) !== -1;
      const byte = escaped
        ? hexDigit(bytes[at + 1]) * 16 + hexDigit(bytes[at + 2])
        : bytes[at];
      at += escaped ? 3 : 1;
      const expected = needle[offset];
      if (
        byte !== expected &&
        (!caseInsensitive || asciiLower(byte) !== asciiLower(expected))
      ) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
    index = nextStart(index + 1);
  }

  return false;
}

// Every open runs these scans over the whole file before page 1 shows, so candidates come from the engine's native search for the bytes a match can open with, rather than a byte-by-byte loop in script. Each byte keeps its own next position and moves on only once passed, so a byte the file never contains is searched for once.
function firstByteFinder(bytes: Uint8Array, openers: readonly number[]) {
  const wanted = Array.from(new Set(openers));
  const next = wanted.map((opener) => bytes.indexOf(opener));
  return (from: number) => {
    let nearest = -1;
    for (let slot = 0; slot < wanted.length; slot += 1) {
      if (next[slot] !== -1 && next[slot] < from) {
        next[slot] = bytes.indexOf(wanted[slot], from);
      }
      if (next[slot] !== -1 && (nearest === -1 || next[slot] < nearest)) {
        nearest = next[slot];
      }
    }
    return nearest;
  };
}

function asciiLower(value: number) {
  return value >= 65 && value <= 90 ? value + 32 : value;
}

function asciiUpper(value: number) {
  return value >= 97 && value <= 122 ? value - 32 : value;
}

// One hex digit's value, in either case, or -1.
function hexDigit(value: number | undefined) {
  if (value === undefined) {
    return -1;
  }
  if (value >= 0x30 && value <= 0x39) {
    return value - 0x30;
  }
  const lower = asciiLower(value);
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

// The byte ranges between a `stream` keyword and its `endstream`: a page's drawn content, an embedded image, a font program, a form field's appearance. Structural PDF syntax - the dictionaries a marker scan is actually meant to see - never sits inside one.
function contentStreamSpans(bytes: Uint8Array): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let searchFrom = 0;
  while (searchFrom < bytes.length) {
    const streamAt = indexOfAscii(bytes, "stream", searchFrom);
    if (streamAt === -1) {
      break;
    }

    // "endstream" ends in "stream"; that occurrence starts no content of its own.
    if (
      streamAt >= 3 &&
      bytes[streamAt - 3] === 0x65 && // e
      bytes[streamAt - 2] === 0x6e && // n
      bytes[streamAt - 1] === 0x64 // d
    ) {
      searchFrom = streamAt + "stream".length;
      continue;
    }

    const contentStart = streamAt + "stream".length;
    const endAt = indexOfAscii(bytes, "endstream", contentStart);
    if (endAt === -1) {
      // Unterminated at the end of a truncated file: everything after it is still stream data, not a dictionary.
      spans.push([contentStart, bytes.length]);
      break;
    }

    spans.push([contentStart, endAt]);
    searchFrom = endAt + "endstream".length;
  }
  return spans;
}

function indexOfAscii(bytes: Uint8Array, pattern: string, start: number) {
  const needle = Array.from(pattern, (char) => char.charCodeAt(0));
  const lastStart = bytes.length - needle.length;
  // A native search for the first byte, for the same reason as firstByteFinder.
  for (
    let index = bytes.indexOf(needle[0], start);
    index !== -1 && index <= lastStart;
    index = bytes.indexOf(needle[0], index + 1)
  ) {
    let matched = true;
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}
