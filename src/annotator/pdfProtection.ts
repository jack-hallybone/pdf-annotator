import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, ParseSpeeds } from 'pdf-lib';

const PDF_PROTECTION_SCAN_BYTES = 4 * 1024 * 1024;
const pdfProtectionLoadOptions = {
  ignoreEncryption: true,
  parseSpeed: ParseSpeeds.Fastest,
  updateMetadata: false
};

export type PdfWorkspaceReadOnlyReason =
  | 'PDF/A compliant'
  | 'password protected'
  | 'signed/certified';

export async function detectReadOnlyReason(
  bytes: Uint8Array,
  pdfDoc: Pick<PDFDocumentProxy, 'getMetadata'> | null,
  passwordProtected: boolean
): Promise<PdfWorkspaceReadOnlyReason | null> {
  if (passwordProtected) {
    return 'password protected';
  }

  if (await pdfLooksEncrypted(bytes)) {
    return 'password protected';
  }

  if (await pdfLooksPdfA(bytes, pdfDoc)) {
    return 'PDF/A compliant';
  }

  if (pdfLooksSignedOrCertified(bytes)) {
    return 'signed/certified';
  }

  return null;
}

export async function pdfLooksEncrypted(bytes: Uint8Array) {
  if (!bytesContainPdfMarker(bytes, '/Encrypt')) {
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
  pdfDoc?: Pick<PDFDocumentProxy, 'getMetadata'> | null
) {
  if (
    bytesContainPdfMarker(bytes, 'pdfaid:part', { caseInsensitive: true }) ||
    bytesContainPdfMarker(bytes, 'pdfaid:conformance', {
      caseInsensitive: true
    }) ||
    bytesContainPdfMarker(bytes, 'GTS_PDFA', { caseInsensitive: true }) ||
    bytesContainPdfMarker(bytes, 'PDF/A', { caseInsensitive: true })
  ) {
    return true;
  }

  try {
    const metadata = await pdfDoc?.getMetadata?.();
    const rawMetadata =
      metadata?.metadata?.getRaw?.() ??
      metadata?.metadata?.get?.('pdfaid:part') ??
      metadata?.metadata?.get?.('pdfaid:conformance') ??
      '';
    return typeof rawMetadata === 'string'
      ? /pdfaid:part|pdfaid:conformance|pdf\/a/i.test(rawMetadata)
      : false;
  } catch {
    return false;
  }
}

export function pdfLooksSignedOrCertified(bytes: Uint8Array) {
  return (
    bytesContainPdfMarker(bytes, '/ByteRange') ||
    bytesContainPdfMarker(bytes, '/DocMDP') ||
    bytesContainPdfMarker(bytes, '/Perms') ||
    bytesContainPdfMarker(bytes, '/SigFlags') ||
    bytesContainPdfMarker(bytes, '/Type /Sig') ||
    bytesContainPdfMarker(bytes, '/SubFilter /adbe.pkcs7', {
      caseInsensitive: true
    }) ||
    bytesContainPdfMarker(bytes, '/SubFilter /ETSI.', {
      caseInsensitive: true
    })
  );
}

export function bytesContainPdfMarker(
  bytes: Uint8Array,
  pattern: string,
  options: { caseInsensitive?: boolean } = {}
) {
  for (const [start, end] of pdfMarkerScanRanges(bytes.length)) {
    if (bytesContainAscii(bytes, pattern, options, start, end)) {
      return true;
    }
  }

  return false;
}

function pdfMarkerScanRanges(length: number): Array<[number, number]> {
  if (length <= PDF_PROTECTION_SCAN_BYTES * 2) {
    return [[0, length]];
  }

  return [
    [0, PDF_PROTECTION_SCAN_BYTES],
    [length - PDF_PROTECTION_SCAN_BYTES, length]
  ];
}

function bytesContainAscii(
  bytes: Uint8Array,
  pattern: string,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {},
  start = 0,
  end = bytes.length
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
        (!caseInsensitive ||
          asciiLower(byte) !== asciiLower(expected))
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
