// The two dialogs the tabbedapp shell renders over the core: the password prompt for
// an encrypted document, and the confirmation for an external link.
import { useId, useRef } from "react";
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
  onAlways,
  onCancel,
  onOpen,
  openButtonRef,
}: {
  link: PendingExternalLink;
  onAlways: () => void;
  onCancel: () => void;
  onOpen: () => void;
  openButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
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
        {/* Rendered as stored, not re-derived: PendingExternalLink.url is
            already the sanitized string that will be opened. */}
        <p className="dialog-body external-link-url text-mono">{link.url}</p>
        <div className="dialog-actions">
          <button className="" onClick={onCancel} type="button">
            Cancel
          </button>
          {/* The scope label comes from PendingExternalLink so the button
              promises exactly what confirmExternalLink stores: this origin, or
              this mailto recipient - not every link in the document. */}
          <button
            className=""
            onClick={onAlways}
            title={`Always open links to ${link.trustScopeLabel} from this document, without asking again`}
            type="button"
          >
            {`Always allow ${link.trustScopeLabel} in this document`}
          </button>
          <button
            className="primary"
            onClick={onOpen}
            ref={openButtonRef}
            type="button"
          >
            Open
          </button>
        </div>
      </section>
    </div>
  );
}
