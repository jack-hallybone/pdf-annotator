import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { PdfDocumentEditorNoticeTone } from "../../pdfdocumenteditor";
import type { PdfDocumentEditorReadOnlyReason } from "../../pdfdocumenteditor";

// The core's vocabulary, so what it can raise and what this can render cannot drift apart.
type TabbedAppNoticeTone = PdfDocumentEditorNoticeTone;

export type TabbedAppNotice = {
  id: number;
  message: string;
  tone?: TabbedAppNoticeTone;
};

// `alert` interrupts, `status` waits for a pause.
function noticeRole(tone: TabbedAppNoticeTone | undefined) {
  return tone === "danger" ? "alert" : "status";
}

function toneClass(tone: TabbedAppNoticeTone | undefined) {
  return tone ? ` ${tone}` : "";
}

export function TabbedAppNoticeStack({
  children,
  notices,
  onDismissNotice,
  onPauseTimers,
  onResumeTimers,
}: {
  children?: ReactNode;
  notices: TabbedAppNotice[];
  onDismissNotice: (id: number) => void;
  onPauseTimers?: () => void;
  onResumeTimers?: () => void;
}) {
  // React's focus events bubble, so the relatedTarget check is what keeps focus moving between controls inside the stack from reading as departure.
  return (
    <div
      className="tabbedapp-notice-stack toast inline no-print stack"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          onResumeTimers?.();
        }
      }}
      onFocus={onPauseTimers}
      onMouseEnter={onPauseTimers}
      onMouseLeave={onResumeTimers}
    >
      {children}
      {notices.map((notice) => (
        <div
          className={`panel banner tabbedapp-notice${toneClass(notice.tone)}`}
          key={notice.id}
          role={noticeRole(notice.tone)}
        >
          <p className="banner-title tabbedapp-notice-text">{notice.message}</p>
          <div className="banner-actions">
            <button
              aria-label="Dismiss notification"
              className="icon-button ghost icon-center"
              onClick={() => onDismissNotice(notice.id)}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ReadOnlyBanner({
  canEditCopy,
  canUnlockOriginal,
  onEnableEditing,
  onUnlockOriginal,
  reason,
}: {
  canEditCopy: boolean;
  canUnlockOriginal: boolean;
  onEnableEditing: () => void;
  onUnlockOriginal: () => void;
  reason: PdfDocumentEditorReadOnlyReason;
}) {
  return (
    <div className="panel banner warning tabbedapp-notice">
      <p className="banner-title tabbedapp-notice-text">
        {reason === "password protected"
          ? "This password protected file is open as read-only. Editing and printing are disabled."
          : reason === "ambiguous page order"
            ? "This file's page structure is malformed, so it is open as read-only: an edit could land on the wrong page."
            : `This ${reason} file is open as read-only to protect the original.`}
      </p>
      {canEditCopy ? (
        <div className="banner-actions protected-pdf-actions">
          <button
            className="protected-pdf-edit-button compact"
            onClick={onEnableEditing}
            type="button"
          >
            Edit a copy
          </button>
          {canUnlockOriginal ? (
            <button
              className="protected-pdf-edit-button compact"
              onClick={onUnlockOriginal}
              type="button"
            >
              Unlock original
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
