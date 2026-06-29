import type { PdfWorkspaceReadOnlyReason } from './pdfProtection';

export function canEditReadOnlyCopy(
  reason: PdfWorkspaceReadOnlyReason | null
) {
  return reason !== null && reason !== 'password protected';
}

export function canCreateOutputCopy(reason: PdfWorkspaceReadOnlyReason | null) {
  return reason !== 'password protected';
}
