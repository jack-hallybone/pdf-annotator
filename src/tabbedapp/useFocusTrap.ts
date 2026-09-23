import { useEffect, type RefObject } from "react";

/*
 * `aria-modal="true"` is only a declaration; Tab still walks out into the page
 * behind.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  /** For when whatever opened the dialog is gone by the time it closes. */
  fallbackRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const container = active ? containerRef.current : null;
    if (!container) {
      return;
    }

    const restoreTo = document.activeElement;

    // Read fresh every time: a list captured on open would send focus to a
    // control that has since been disabled or removed.
    const focusable = () =>
      [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        },
      );

    if (!container.contains(document.activeElement)) {
      (focusable()[0] ?? container).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) {
        return;
      }

      const items = focusable();
      if (items.length === 0) {
        // Nothing to move to, so stay put.
        event.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const outside = !container.contains(current);

      if (
        event.shiftKey
          ? current === first || outside
          : current === last || outside
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };

    // Capture, so a dialog's own Tab handling cannot swallow this first.
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      // The fallback is read at cleanup, not captured on open: it may have
      // re-rendered since.
      const target =
        restoreTo instanceof HTMLElement && restoreTo.isConnected
          ? restoreTo
          : // eslint-disable-next-line react-hooks/exhaustive-deps
            fallbackRef?.current;
      target?.focus();
    };
  }, [active, containerRef, fallbackRef]);
}
