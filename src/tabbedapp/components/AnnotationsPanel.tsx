import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { MAX_ANNOTATION_COMMENT_LENGTH } from "../../pdfdocumenteditor";
import type { PdfAnnotation } from "../../pdfdocumenteditor";
import {
  annotationColorCounts,
  filterAnnotationRows,
  toggleColorFilter,
} from "../annotationList";
import type {
  AnnotationListFilter,
  AnnotationListRow,
} from "../annotationList";

/**
 * The open row follows the viewport selection but never drives it: a selection
 * would raise the core's editing popover under this very panel.
 */
export function AnnotationsPanel({
  complete,
  filter,
  onChangeFilter,
  onRevealAnnotation,
  onSetBookmarked,
  onSetComment,
  readOnly,
  rows,
  selectedAnnotationIds,
}: {
  /** Until this is true, an empty list does not mean the document has none. */
  complete: boolean;
  filter: AnnotationListFilter;
  onChangeFilter: (filter: AnnotationListFilter) => void;
  onRevealAnnotation: (annotationId: string) => void;
  onSetBookmarked: (annotationId: string, bookmarked: boolean) => void;
  onSetComment: (annotationId: string, comment: string) => void;
  readOnly: boolean;
  rows: AnnotationListRow[];
  selectedAnnotationIds: string[];
}) {
  const colorCounts = annotationColorCounts(rows);
  const visibleRows = filterAnnotationRows(rows, filter);
  const bookmarkedCount = rows.filter((row) => row.bookmarked).length;
  const selectedId =
    selectedAnnotationIds.length === 1 ? selectedAnnotationIds[0] : null;
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const openId = selectedId ?? openRowId;

  return (
    <div className="annotations-panel">
      {rows.length > 0 ? (
        <div className="annotations-filter row nowrap xs">
          <div
            aria-label="Filter annotations by colour"
            className="annotations-swatches row xxs"
            role="group"
          >
            {colorCounts.map(({ colorKey, count }, index) => {
              const active = filter.colorKeys.includes(colorKey);
              return (
                <button
                  aria-label={`Colour ${index + 1}, ${count} annotation${count === 1 ? "" : "s"}`}
                  aria-pressed={active}
                  className={`annotations-swatch ${active ? "selected" : ""}`}
                  key={colorKey}
                  onClick={() =>
                    onChangeFilter(toggleColorFilter(filter, colorKey))
                  }
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="annotations-swatch-chip"
                    style={{ background: colorKey }}
                  />
                </button>
              );
            })}
          </div>
          <button
            aria-label={`Show starred only (${bookmarkedCount})`}
            aria-pressed={filter.bookmarkedOnly}
            className={`annotations-star-filter icon-center ${
              filter.bookmarkedOnly ? "selected" : ""
            }`}
            onClick={() =>
              onChangeFilter({
                ...filter,
                bookmarkedOnly: !filter.bookmarkedOnly,
              })
            }
            type="button"
          >
            <Star
              className="annotations-star-icon"
              fill={filter.bookmarkedOnly ? "currentColor" : "none"}
              size={15}
            />
          </button>
        </div>
      ) : null}

      {visibleRows.length === 0 ? (
        <p className="annotations-empty">
          {rows.length > 0
            ? "No annotations match the current filter."
            : complete
              ? "No annotations in this document yet."
              : "Reading the rest of the document\u2026"}
        </p>
      ) : (
        <ul aria-label="Annotations" className="annotations-list stack xs">
          {visibleRows.map((row) => (
            <AnnotationRow
              key={row.id}
              onReveal={() => {
                setOpenRowId(row.id);
                onRevealAnnotation(row.id);
              }}
              onSetBookmarked={(bookmarked) =>
                onSetBookmarked(row.id, bookmarked)
              }
              onSetComment={(comment) => onSetComment(row.id, comment)}
              readOnly={readOnly}
              row={row}
              selected={row.id === openId}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AnnotationRow({
  onReveal,
  onSetBookmarked,
  onSetComment,
  readOnly,
  row,
  selected,
}: {
  onReveal: () => void;
  onSetBookmarked: (bookmarked: boolean) => void;
  onSetComment: (comment: string) => void;
  readOnly: boolean;
  row: AnnotationListRow;
  selected: boolean;
}) {
  const itemRef = useRef<HTMLLIElement>(null);

  // Selecting a mark on the page brings its row into view here.
  useEffect(() => {
    if (selected) {
      itemRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  return (
    <li
      className={`annotation-row ${selected ? "annotation-row-selected" : ""}`}
      ref={itemRef}
    >
      <div className="annotation-row-head row start nowrap xxs">
        <button
          className="annotation-row-open ghost row start nowrap xs grow"
          onClick={onReveal}
          type="button"
        >
          <span
            aria-hidden="true"
            className="annotation-row-swatch"
            style={row.colorKey ? { background: row.colorKey } : undefined}
          />
          <span className="annotation-row-text stack xxs">
            <span className="annotation-row-meta">
              {row.kindLabel} &middot; page {row.pageIndex + 1}
            </span>
            <span className="annotation-row-quote">
              {row.quote || "No text"}
            </span>
          </span>
        </button>
        <button
          aria-label={
            row.bookmarked
              ? `Unstar ${row.kindLabel} on page ${row.pageIndex + 1}`
              : `Star ${row.kindLabel} on page ${row.pageIndex + 1}`
          }
          aria-pressed={row.bookmarked}
          className={`annotation-row-star icon-center ${
            row.bookmarked ? "selected" : ""
          }`}
          disabled={readOnly}
          onClick={() => onSetBookmarked(!row.bookmarked)}
          type="button"
        >
          <Star
            className="annotations-star-icon"
            fill={row.bookmarked ? "currentColor" : "none"}
            size={14}
          />
        </button>
      </div>

      {selected && row.commentable && !readOnly ? (
        <CommentEditor
          annotation={row.annotation}
          comment={row.comment}
          onSetComment={onSetComment}
        />
      ) : row.commentable && row.comment ? (
        <p className="annotation-row-comment">{row.comment}</p>
      ) : null}
    </li>
  );
}

/**
 * Uncontrolled while focused, so a keystroke is not a round trip through the
 * core's annotation state; committed on blur and on every pause.
 */
function CommentEditor({
  annotation,
  comment,
  onSetComment,
}: {
  annotation: PdfAnnotation;
  comment: string;
  onSetComment: (comment: string) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const field = inputRef.current;
    if (field && document.activeElement !== field) {
      field.value = comment;
    }
  }, [annotation.id, comment]);

  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current);
      }
    },
    [],
  );

  const commit = () => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    onSetComment(inputRef.current?.value ?? "");
  };

  return (
    <label className="annotation-comment-field stack xxs">
      <span className="annotation-comment-label">Comment</span>
      <textarea
        className="annotation-comment-input"
        defaultValue={comment}
        maxLength={MAX_ANNOTATION_COMMENT_LENGTH}
        onBlur={commit}
        onChange={() => {
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
          }
          commitTimerRef.current = window.setTimeout(commit, 400);
        }}
        placeholder="Add a comment"
        ref={inputRef}
        rows={2}
      />
    </label>
  );
}
