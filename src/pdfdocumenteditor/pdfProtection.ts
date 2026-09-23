import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  ParseSpeeds,
  decodePDFRawStream,
} from "pdf-lib";
import type { PDFContext } from "pdf-lib";
import {
  resolvedArrayEntry,
  resolvedDictEntry,
  resolvedNameEntry,
  resolvedNumberEntry,
} from "./pdfLookup";
import { clamp } from "./viewerConfig";

const pdfProtectionLoadOptions = {
  ignoreEncryption: true,
  parseSpeed: ParseSpeeds.Fastest,
  updateMetadata: false,
};

const MAX_PROTECTION_FIELD_ENTRIES = 10_000;
// pdfPageOperations.ts strips exactly the streams these are found in, so the
// two must agree: a claim one side cannot see is left in the output.
const pdfaXmpMarkers = ["pdfaid:part", "pdfaid:conformance"];

export type PdfDocumentEditorReadOnlyReason =
  "PDF/A compliant" | "password protected" | "signed/certified";

export async function detectReadOnlyReason(
  bytes: Uint8Array,
  pdfDoc: Pick<PDFDocumentProxy, "getMetadata"> | null,
  passwordProtected: boolean,
): Promise<PdfDocumentEditorReadOnlyReason | null> {
  if (passwordProtected) {
    return "password protected";
  }

  if (await pdfLooksEncrypted(bytes)) {
    return "password protected";
  }

  if (await pdfLooksPdfA(bytes, pdfDoc)) {
    return "PDF/A compliant";
  }

  if (
    pdfLooksSignedOrCertified(bytes) ||
    (await pdfLooksStructurallySignedOrCertified(bytes))
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
      /pdfaid:part|pdfaid:conformance|pdf\/a/i.test(rawMetadata)
    ) {
      return true;
    }
  } catch {
    // Fall through to the structural output-intent check below.
  }

  return pdfLooksStructurallyPdfA(bytes);
}

export function pdfLooksSignedOrCertified(bytes: Uint8Array) {
  return (
    bytesContainPdfMarker(bytes, "/ByteRange") ||
    bytesContainPdfMarker(bytes, "/DocMDP") ||
    bytesContainPdfMarker(bytes, "/Perms") ||
    bytesContainPdfMarker(bytes, "/SigFlags") ||
    bytesContainPdfMarker(bytes, "/Type /Sig") ||
    bytesContainPdfMarker(bytes, "/SubFilter /adbe.pkcs7", {
      caseInsensitive: true,
    }) ||
    bytesContainPdfMarker(bytes, "/SubFilter /ETSI.", {
      caseInsensitive: true,
    })
  );
}

export async function pdfLooksStructurallySignedOrCertified(bytes: Uint8Array) {
  try {
    const pdfDoc = await PDFDocument.load(bytes, pdfProtectionLoadOptions);
    return pdfDocumentLooksSignedOrCertified(pdfDoc);
  } catch {
    // Fail-closed: an unparseable form structure is treated as protected
    // rather than assumed to hold no signature.
    return true;
  }
}

async function pdfLooksStructurallyPdfA(bytes: Uint8Array) {
  try {
    const pdfDoc = await PDFDocument.load(bytes, pdfProtectionLoadOptions);
    return pdfDocumentLooksPdfA(pdfDoc);
  } catch {
    return false;
  }
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

function pdfLooksPdfAByRawMarkers(bytes: Uint8Array) {
  return (
    bytesContainPdfMarker(bytes, "pdfaid:part", { caseInsensitive: true }) ||
    bytesContainPdfMarker(bytes, "pdfaid:conformance", {
      caseInsensitive: true,
    }) ||
    bytesContainPdfMarker(bytes, "GTS_PDFA", { caseInsensitive: true }) ||
    bytesContainPdfMarker(bytes, "PDF/A", { caseInsensitive: true })
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

  // Neither cheaper check sees a claim in an undeclared, compressed packet:
  // pdf.js surfaces metadata only when the stream declares /Type /Metadata.
  return pdfAClaimingMetadataRefs(pdfDoc.context).size > 0;
}

/*
 * A stream counts as metadata when it says so or when a dictionary points at it
 * through /Metadata: without the second half, a compressed packet declaring
 * neither is invisible to the strip.
 */
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
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) {
      continue;
    }
    if (!streamDeclaresMetadata(object) && !referencedAsMetadata.has(ref.tag)) {
      continue;
    }
    if (
      bytesClaimPdfA(object.contents) ||
      bytesClaimPdfA(decodedStreamContents(object))
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

function bytesClaimPdfA(bytes: Uint8Array | null) {
  return (
    bytes !== null &&
    pdfaXmpMarkers.some((marker) =>
      bytesContainPdfMarker(bytes, marker, { caseInsensitive: true }),
    )
  );
}

// PDF/A requires an unfiltered metadata stream, so the raw scan covers
// conforming files; this catches a claim made from a compressed packet.
function decodedStreamContents(stream: PDFRawStream) {
  if (!stream.dict.get(PDFName.of("Filter"))) {
    return null;
  }

  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return null;
  }
}

function pdfDocumentLooksSignedOrCertified(pdfDoc: PDFDocument) {
  const { catalog } = pdfDoc;
  const perms = resolvedDictEntry(catalog, PDFName.of("Perms"));
  if (perms?.get(PDFName.of("DocMDP")) || perms?.get(PDFName.of("UR3"))) {
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
        // An attacker-controlled field tree must not create an unbounded walk
        // or leave a partially inspected document declared unsigned.
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
        // A malformed field entry leaves signature status unknowable, so the
        // source is preserved rather than made editable.
        return true;
      }
    }
  }
  return false;
}

// lookupMaybe throws when an entry exists with a different legal PDF type,
// which is common for form values, so these checks resolve without a requested
// type and narrow afterwards rather than call a healthy document unverifiable.

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
  options: { caseInsensitive?: boolean } = {},
) {
  return bytesContainAscii(bytes, pattern, options);
}

function bytesContainAscii(
  bytes: Uint8Array,
  pattern: string,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {},
  start = 0,
  end = bytes.length,
) {
  const needle = Array.from(pattern, (char) => char.charCodeAt(0));
  const safeStart = clamp(Math.floor(start), 0, bytes.length);
  const safeEnd = clamp(Math.floor(end), safeStart, bytes.length);
  if (needle.length === 0 || safeEnd - safeStart < needle.length) {
    return false;
  }

  for (let index = safeStart; index <= safeEnd - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      const byte = bytes[index + offset];
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
  }

  return false;
}

function asciiLower(value: number) {
  return value >= 65 && value <= 90 ? value + 32 : value;
}
