import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { PdfWorkspaceReadOnlyReason } from '../pdfProtection';

export type WorkspaceNotice = {
  id: number;
  message: string;
};

export function WorkspaceNoticeStack({
  children,
  notices,
  onDismissNotice
}: {
  children?: ReactNode;
  notices: WorkspaceNotice[];
  onDismissNotice: (id: number) => void;
}) {
  return (
    <div className="workspace-notice-stack screen-only">
      {children}
      {notices.map((notice) => (
        <div className="workspace-notice ui-frame" key={notice.id} role="status">
          <span className="workspace-notice-text">{notice.message}</span>
          <button
            aria-label="Dismiss notification"
            className="icon-button ui-button workspace-notice-close"
            onClick={() => onDismissNotice(notice.id)}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ReadOnlyBanner({
  canEditCopy,
  onEnableEditing,
  reason
}: {
  canEditCopy: boolean;
  onEnableEditing: () => void;
  reason: PdfWorkspaceReadOnlyReason;
}) {
  return (
    <div className="workspace-notice ui-frame">
      <span className="workspace-notice-text">
        {reason === 'password protected'
          ? 'This password protected file is open as read-only. Editing and printing are disabled.'
          : `This ${reason} file is open as read-only to protect the original.`}
      </span>
      {canEditCopy ? (
        <button
          className="ui-button protected-pdf-edit-button"
          onClick={onEnableEditing}
          type="button"
        >
          Edit a copy
        </button>
      ) : null}
    </div>
  );
}

export function ReadOnlyNotice({ message }: { message: string }) {
  return (
    <div className="workspace-notice ui-frame">
      <span className="workspace-notice-text">{message}</span>
    </div>
  );
}
