// The two dialogs the tabbedapp shell renders over the core: the password prompt for an encrypted document, and the confirmation for an external link.
import { useId, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import type { PendingExternalLink } from "../useExternalLinks";
import { useFocusTrap } from "../useFocusTrap";

export function PasswordUnlockForm({
  failed,
  inputRef,
  onSubmit,
}: {
  failed: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const passwordInputId = useId();

  return (
    <form className="password-unlock-form stack" onSubmit={onSubmit}>
      <label className="password-unlock-label" htmlFor={passwordInputId}>
        This file is password protected.
      </label>
      <div className="password-unlock-row row nowrap md">
        <input
          aria-invalid={failed ? "true" : undefined}
          autoComplete="off"
          autoFocus
          className="password-unlock-input"
          id={passwordInputId}
          placeholder="Password"
          ref={inputRef}
          type="password"
        />
        <button className="password-unlock-button" type="submit">
          Unlock
        </button>
      </div>
    </form>
  );
}

export function ExternalLinkDialog({
  link,
  onCancel,
  onOpen,
  cancelButtonRef,
}: {
  link: PendingExternalLink;
  onCancel: () => void;
  onOpen: (always: boolean) => void;
  cancelButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const titleId = useId();
  const alwaysId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const [always, setAlways] = useState(false);
  useFocusTrap(dialogRef, true);

  return (
    <div
      className="backdrop z-dialog-backdrop external-link-backdrop no-print"
      onPointerDown={onCancel}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="panel floating dialog external-link-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <h2 className="dialog-title" id={titleId}>
          External link
        </h2>
        <p className="dialog-body">
          This file wants to open the following link:
        </p>
        {/* Rendered as stored, not re-derived: PendingExternalLink.url is already the sanitized string that will be opened. */}
        <p className="dialog-body external-link-url text-mono">{link.url}</p>
        {/* A box, not a third button: its label wraps however long the origin, where a button that long pushed Open onto a row of its own. The scope label comes from PendingExternalLink so the box promises exactly what confirmExternalLink stores: this origin, or this mailto recipient - not every link in the document. */}
        <label className="external-link-always row nowrap" htmlFor={alwaysId}>
          <input
            checked={always}
            id={alwaysId}
            onChange={(event) => setAlways(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{`Always allow links to ${link.trustScopeLabel} in this document`}</span>
        </label>
        <div className="dialog-actions">
          <button onClick={onCancel} ref={cancelButtonRef} type="button">
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => onOpen(always)}
            type="button"
          >
            Open
          </button>
        </div>
      </section>
    </div>
  );
}
