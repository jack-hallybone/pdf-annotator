// Small DOM-geometry helpers for the page scroll container, shared by the
// zoom logic (useWorkspaceZoom) and the scroll-to-page/scroll-restoration code
// in PdfWorkspace. Kept framework-free so both can import them.

export function pageElementForIndex(
  container: HTMLElement,
  pageIndex: number
) {
  return container.querySelector<HTMLElement>(
    `[data-page-index="${pageIndex}"]`
  );
}

export function pageTopInContainer(
  container: HTMLElement,
  pageElement: HTMLElement
) {
  const containerRect = container.getBoundingClientRect();
  const pageRect = pageElement.getBoundingClientRect();
  return container.scrollTop + pageRect.top - containerRect.top;
}

export function scrollContainerPaddingTop(container: HTMLElement) {
  const paddingTop = Number.parseFloat(getComputedStyle(container).paddingTop);
  return Number.isFinite(paddingTop) ? paddingTop : 0;
}
