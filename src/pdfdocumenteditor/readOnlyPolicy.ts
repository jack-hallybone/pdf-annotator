import type { PdfDocumentEditorReadOnlyReason } from "./pdfProtection";

export function canEditReadOnlyCopy(
  reason: PdfDocumentEditorReadOnlyReason | null,
) {
  return reason !== null && reason !== "password protected";
}

export function canCreateOutputCopy(
  reason: PdfDocumentEditorReadOnlyReason | null,
) {
  return reason !== "password protected";
}
