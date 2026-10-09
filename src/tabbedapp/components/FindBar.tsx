import { startTransition, type RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { PdfDocumentEditorFindResults } from "../../pdfdocumenteditor";

const ICON_BUTTON_CLASS = "icon-button ghost icon-center";

/** Rides in the notice stack, so it floats over the page on a wide screen and docks above it on a narrow one, as notices do; its own shape is the floating controls'. */
export function FindBar({
  inputRef,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
  query,
  results,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onQueryChange: (query: string) => void;
  // The field's text when the bar opens, and the query the count is for, which can be a key behind it.
  query: string;
  results: PdfDocumentEditorFindResults;
}) {
  const noMatches = results.total === 0;

  return (
    <div
      aria-label="Find in document"
      className="panel raised find-bar row nowrap xs"
      // The stack holds its notices while focus is among them, to give a reader time; focus here is the search's, so theirs keep counting down.
      onFocus={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Kept from the core's own Escape, which blurs whatever has focus - by then, the element the bar has just handed it back to.
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      // The Enter or Escape that ends an IME composition is the composition's, so neither the bar nor the document's shortcuts see it. Safari marks it only by keyCode 229.
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          event.stopPropagation();
        }
      }}
      role="search"
    >
      <input
        aria-label="Find in document"
        autoComplete="off"
        className="find-bar-input"
        defaultValue={query}
        enterKeyHint="search"
        // Uncontrolled, and the query handed on as a transition: the field shows each key at once, and the search's re-render of the document comes after.
        onChange={(event) => {
          const value = event.target.value;
          startTransition(() => onQueryChange(value));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              onPrevious();
            } else {
              onNext();
            }
          }
        }}
        placeholder="Find in document"
        ref={inputRef}
        spellCheck={false}
      />
      <span className="find-bar-count" role="status">
        {findCountText(query, results)}
      </span>
      <button
        aria-label="Previous match"
        className={ICON_BUTTON_CLASS}
        disabled={noMatches}
        onClick={onPrevious}
        title="Previous match"
        type="button"
      >
        <ChevronUp size={16} />
      </button>
      <button
        aria-label="Next match"
        className={ICON_BUTTON_CLASS}
        disabled={noMatches}
        onClick={onNext}
        title="Next match"
        type="button"
      >
        <ChevronDown size={16} />
      </button>
      <button
        aria-label="Close find"
        className={ICON_BUTTON_CLASS}
        onClick={onClose}
        title="Close find"
        type="button"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function findCountText(query: string, results: PdfDocumentEditorFindResults) {
  if (!query.trim()) {
    return "";
  }

  if (results.current > 0) {
    return `${results.current} of ${results.total}`;
  }

  return results.complete ? "No matches" : "Searching...";
}
