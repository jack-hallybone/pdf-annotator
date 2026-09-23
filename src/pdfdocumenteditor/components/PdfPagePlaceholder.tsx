import type { PageSize } from "../types";

// Holds a page's space in the scroll flow until it renders, so the scrollbar
// does not jump as pages arrive.
export function PdfPagePlaceholder({
  pageIndex,
  pageSize,
  scale,
}: {
  pageIndex: number;
  pageSize: PageSize | null;
  scale: number;
}) {
  const width = (pageSize?.width ?? 612) * scale;
  const height = (pageSize?.height ?? 792) * scale;

  return (
    <article
      aria-label={`Loading page ${pageIndex + 1}`}
      className="pdfdocumenteditor-page-placeholder"
      style={{ height, width }}
    >
      Page {pageIndex + 1}
    </article>
  );
}
