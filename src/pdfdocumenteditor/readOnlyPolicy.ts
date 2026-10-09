import type { PdfDocumentEditorReadOnlyReason } from "./pdfProtection";

// Only for a claim the writer strips from the copy it writes. A copy is otherwise written just like the original, so any other reason holds for it too.
export function canEditReadOnlyCopy(
  reason: PdfDocumentEditorReadOnlyReason | null,
) {
  return reason === "PDF/A compliant" || reason === "signed/certified";
}

export function canCreateOutputCopy(
  reason: PdfDocumentEditorReadOnlyReason | null,
) {
  return reason !== "password protected";
}

// "Edit a copy" and "Unlock original" both leave the original's bytes in place, PDF/A claim and signature included, so until the first save every file the tab produces has to come out of the writer, which strips them, edited or not.
export function isProtectedCopy(
  reason: PdfDocumentEditorReadOnlyReason | null | undefined,
  editingEnabled: boolean | undefined,
) {
  return Boolean(reason) && editingEnabled === true;
}
