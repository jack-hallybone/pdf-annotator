import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnnotationMode } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  FilePlus2,
  Files,
  List,
  MessageSquareText,
  MoreVertical,
  RotateCw,
  Trash2,
} from "lucide-react";
import { foregroundOn, rgbToHex } from "../../pdfdocumenteditor";
import {
  FREE_TEXT_LINE_HEIGHT,
  freeTextVisualLines,
} from "../../pdfdocumenteditor";
import {
  annotationContentTransform,
  pathToViewportD,
  pdfRectToViewportRect,
} from "../../pdfdocumenteditor";
import {
  cachePageBaseRenderMode,
  cachedPageBaseRenderMode,
  canvasLooksEmpty,
  pageHasRenderableContent,
  releaseCanvasBuffer,
  safeCanvasPixelRatio,
} from "../../pdfdocumenteditor";
import type {
  LoadedPage,
  PageSize,
  PageViewport,
  PdfAnnotation,
  PdfOutlineEntry,
} from "../../pdfdocumenteditor";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { OutlinePanel } from "./OutlinePanel";
import { annotationListRows, prunedAnnotationFilter } from "../annotationList";
import type {
  AnnotationListFilter,
  AnnotationListRow,
} from "../annotationList";
import { clamp } from "../../pdfdocumenteditor";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_ROW_HEIGHT,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_ROW_BUFFER,
  SIDEBAR_ROW_CHROME_HEIGHT,
} from "../sidebarConfig";

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const EMPTY_ANNOTATION_ROWS: AnnotationListRow[] = [];
const SIDEBAR_ICON_BUTTON_CLASS = "icon-button ghost icon-center";
const PAGE_MENU_ITEM_CLASS = "menu-item page-menu-item";
type SidebarPageInsertKind = "blank" | "lined";

/**
 * "contents" exists only while the open document has an outline; most PDFs
 * have none.
 */
export type DocumentSidebarTab = "pages" | "annotations" | "contents";

type DocumentSidebarProps = {
  activePageIndex: number;
  annotationFilter: AnnotationListFilter;
  annotationsByPage: Map<number, PdfAnnotation[]>;
  /** Whether the core has read every page's annotations, or only the loaded pages'. */
  annotationsComplete: boolean;
  busy: boolean;
  canMergePdf?: boolean;
  onChangeAnnotationFilter: (filter: AnnotationListFilter) => void;
  onChangeTab: (tab: DocumentSidebarTab) => void;
  onEnsureAllAnnotations: () => void;
  onRevealAnnotation: (annotationId: string) => void;
  onSelectOutlineDestination: (destination: unknown) => void;
  onSetAnnotationBookmarked: (
    annotationId: string,
    bookmarked: boolean,
  ) => void;
  onSetAnnotationComment: (annotationId: string, comment: string) => void;
  outline: PdfOutlineEntry[];
  selectedAnnotationIds: string[];
  tab: DocumentSidebarTab;
  onAddPage: (
    pageIndex?: number,
    position?: "before" | "after",
    kind?: SidebarPageInsertKind,
  ) => void;
  onClose: () => void;
  onDeletePage: (pageIndex?: number) => void;
  onMergePdf: () => void;
  onMovePageDown: (pageIndex?: number) => void;
  onMovePageUp: (pageIndex?: number) => void;
  onRotatePage: (pageIndex?: number) => void;
  onSelectPage: (pageIndex: number) => void;
  onThumbnailPageLoad: (page: PDFPageProxy, pageIndex: number) => void;
  onWidthChange: (width: number) => void;
  open: boolean;
  pageSize: PageSize | null;
  pageMenuIndex: number | null;
  pdfDoc: PDFDocumentProxy | null;
  pages: LoadedPage[];
  readOnly?: boolean;
  setPageMenuIndex: (pageIndex: number | null) => void;
  showAnnotations: boolean;
  width: number;
};

export function DocumentSidebar({
  activePageIndex,
  annotationFilter,
  annotationsByPage,
  annotationsComplete,
  busy,
  canMergePdf = false,
  onAddPage,
  onChangeAnnotationFilter,
  onChangeTab,
  onEnsureAllAnnotations,
  onRevealAnnotation,
  onSelectOutlineDestination,
  onSetAnnotationBookmarked,
  onSetAnnotationComment,
  outline,
  selectedAnnotationIds,
  tab,
  onClose,
  onDeletePage,
  onMergePdf,
  onMovePageDown,
  onMovePageUp,
  onRotatePage,
  onSelectPage,
  onThumbnailPageLoad,
  onWidthChange,
  open,
  pageSize,
  pageMenuIndex,
  pdfDoc,
  pages,
  readOnly = false,
  setPageMenuIndex,
  showAnnotations,
  width,
}: DocumentSidebarProps) {
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [scrollMetrics, setScrollMetrics] = useState({
    clientHeight: 0,
    scrollTop: 0,
  });
  const thumbnailWidth = Math.round(clamp(width - 52, 108, 284));
  const estimatedRowHeight = Math.max(
    SIDEBAR_MIN_ROW_HEIGHT,
    thumbnailWidth * ((pageSize?.height ?? 792) / (pageSize?.width ?? 612)) +
      SIDEBAR_ROW_CHROME_HEIGHT,
  );

  useEffect(() => {
    if (busy && pageMenuIndex !== null) {
      setPageMenuIndex(null);
    }
  }, [busy, pageMenuIndex, setPageMenuIndex]);

  // Asked when the panel opens, not at load.
  useEffect(() => {
    if (open && tab === "annotations" && !annotationsComplete) {
      onEnsureAllAnnotations();
    }
    // pdfDoc, because a new document needs a new pass even when the flag is
    // already false from its predecessor's.
  }, [annotationsComplete, onEnsureAllAnnotations, open, pdfDoc, tab]);

  // Opening a document with no outline while the contents tab is showing
  // would otherwise leave the sidebar on a tab that no longer exists.
  useEffect(() => {
    if (tab === "contents" && outline.length === 0) {
      onChangeTab("pages");
    }
  }, [onChangeTab, outline.length, tab]);

  // Drives the thumbnail windowing below.
  useLayoutEffect(() => {
    if (!open || tab !== "pages") {
      return;
    }

    const container = sidebarScrollRef.current;
    if (!container) {
      return;
    }

    const updateMetrics = () => {
      setScrollMetrics((current) => {
        const next = {
          clientHeight: container.clientHeight,
          scrollTop: container.scrollTop,
        };
        return current.clientHeight === next.clientHeight &&
          current.scrollTop === next.scrollTop
          ? current
          : next;
      });
    };

    updateMetrics();
    container.addEventListener("scroll", updateMetrics, { passive: true });
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(container);
    return () => {
      container.removeEventListener("scroll", updateMetrics);
      observer.disconnect();
    };
  }, [open, tab]);

  useEffect(() => {
    if (!open || tab !== "pages") {
      return;
    }

    const scrollContainer = sidebarScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const activeThumbnail = scrollContainer.querySelector<HTMLElement>(
      `[data-thumbnail-index="${activePageIndex}"]`,
    );

    if (!activeThumbnail) {
      // Not mounted: jump to an estimate rather than force it into the
      // window, which would render everything in between.
      const maxScrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight,
      );
      scrollContainer.scrollTo({
        top: clamp(
          activePageIndex * estimatedRowHeight -
            scrollContainer.clientHeight / 2,
          0,
          maxScrollTop,
        ),
        behavior: "auto",
      });
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const thumbnailRect = activeThumbnail.getBoundingClientRect();
    const padding = 12;
    const aboveView = thumbnailRect.top < containerRect.top + padding;
    const belowView = thumbnailRect.bottom > containerRect.bottom - padding;

    if (!aboveView && !belowView) {
      return;
    }

    scrollContainer.scrollTo({
      top:
        scrollContainer.scrollTop +
        thumbnailRect.top -
        containerRect.top -
        (scrollContainer.clientHeight - activeThumbnail.offsetHeight) / 2,
      behavior: "auto",
    });
  }, [activePageIndex, estimatedRowHeight, open, tab]);

  if (!open) {
    return null;
  }

  // This window must not be widened to span the active page: the effect above
  // scrolls toward it instead, which moves the window on its own.
  const pageCount = pages.length;
  const startIndex = Math.max(
    0,
    Math.floor(scrollMetrics.scrollTop / estimatedRowHeight) -
      SIDEBAR_ROW_BUFFER,
  );
  const endIndex = Math.min(
    pageCount - 1,
    Math.ceil(
      (scrollMetrics.scrollTop + scrollMetrics.clientHeight) /
        estimatedRowHeight,
    ) + SIDEBAR_ROW_BUFFER,
  );
  const topSpacerHeight = Math.max(0, startIndex) * estimatedRowHeight;
  const bottomSpacerHeight =
    Math.max(0, pageCount - 1 - endIndex) * estimatedRowHeight;
  // Only while that panel shows: this sorts every annotation, and the sidebar
  // re-renders on every scroll of the page list.
  const rows =
    tab === "annotations"
      ? annotationListRows(annotationsByPage)
      : EMPTY_ANNOTATION_ROWS;
  const filter = prunedAnnotationFilter(annotationFilter, rows);
  const tabs: { icon: ReactNode; id: DocumentSidebarTab; label: string }[] = [
    { icon: <Files size={17} />, id: "pages", label: "Pages" },
    {
      icon: <MessageSquareText size={17} />,
      id: "annotations",
      label: "Annotations",
    },
    // Only for a document that has one; see DocumentSidebarTab.
    ...(outline.length > 0
      ? [
          {
            icon: <List size={17} />,
            id: "contents" as const,
            label: "Contents",
          },
        ]
      : []),
  ];

  return (
    <aside
      className="document-sidebar panel raised z-panel no-print"
      style={{ width }}
    >
      <div className="document-sidebar-header row nowrap">
        <div
          aria-label="Sidebar panels"
          className="document-sidebar-tabs"
          role="tablist"
        >
          {tabs.map((item) => (
            <button
              aria-controls={`${panelId}-${item.id}`}
              aria-selected={tab === item.id}
              className="document-sidebar-tab row nowrap xxs"
              id={`${panelId}-tab-${item.id}`}
              key={item.id}
              onClick={() => onChangeTab(item.id)}
              role="tab"
              title={item.label}
              type="button"
            >
              <span aria-hidden="true" className="document-sidebar-tab-icon">
                {item.icon}
              </span>
              <span className="document-sidebar-tab-label truncate">
                {item.label}
              </span>
            </button>
          ))}
        </div>
        <button
          aria-label="Hide sidebar"
          className={SIDEBAR_ICON_BUTTON_CLASS}
          onClick={onClose}
          type="button"
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <div
        aria-labelledby={`${panelId}-tab-${tab}`}
        className="document-sidebar-scroll grow"
        id={`${panelId}-${tab}`}
        ref={sidebarScrollRef}
        role="tabpanel"
        tabIndex={0}
      >
        {tab === "annotations" ? (
          <AnnotationsPanel
            complete={annotationsComplete}
            filter={filter}
            onChangeFilter={onChangeAnnotationFilter}
            onRevealAnnotation={onRevealAnnotation}
            onSetBookmarked={onSetAnnotationBookmarked}
            onSetComment={onSetAnnotationComment}
            readOnly={readOnly}
            rows={rows}
            selectedAnnotationIds={selectedAnnotationIds}
          />
        ) : null}
        {tab === "contents" ? (
          <OutlinePanel
            entries={outline}
            onSelectDestination={onSelectOutlineDestination}
          />
        ) : null}
        {tab !== "pages" ? null : (
          <>
            {topSpacerHeight > 0 ? (
              <div aria-hidden="true" style={{ height: topSpacerHeight }} />
            ) : null}
            {pages.slice(startIndex, endIndex + 1).map((page, offset) => {
              const index = startIndex + offset;
              return (
                <PageThumbnail
                  active={index === activePageIndex}
                  annotations={
                    annotationsByPage.get(index) ?? EMPTY_ANNOTATIONS
                  }
                  key={index}
                  menuOpen={pageMenuIndex === index}
                  onAddBlankAfter={() => onAddPage(index, "after", "blank")}
                  onAddBlankBefore={() => onAddPage(index, "before", "blank")}
                  onAddLinedAfter={() => onAddPage(index, "after", "lined")}
                  onAddLinedBefore={() => onAddPage(index, "before", "lined")}
                  onDelete={() => onDeletePage(index)}
                  onMenuToggle={() =>
                    setPageMenuIndex(pageMenuIndex === index ? null : index)
                  }
                  onMoveDown={() => onMovePageDown(index)}
                  onMoveUp={() => onMovePageUp(index)}
                  onRotate={() => onRotatePage(index)}
                  onSelect={() => onSelectPage(index)}
                  page={page}
                  pageCount={pages.length}
                  pageIndex={index}
                  pageSize={pageSize}
                  pdfDoc={pdfDoc}
                  readOnly={readOnly}
                  busy={busy}
                  showAnnotations={showAnnotations}
                  onThumbnailPageLoad={onThumbnailPageLoad}
                  thumbnailWidth={thumbnailWidth}
                />
              );
            })}
            {bottomSpacerHeight > 0 ? (
              <div aria-hidden="true" style={{ height: bottomSpacerHeight }} />
            ) : null}
            {canMergePdf && pages.length > 0 ? (
              <button
                className="merge-pdf-button row nowrap"
                disabled={busy || readOnly}
                onClick={onMergePdf}
                title="Add PDF"
                type="button"
              >
                <FilePlus2 size={14} />
                Add PDF
              </button>
            ) : null}
          </>
        )}
      </div>

      <button
        aria-label="Resize pages sidebar"
        aria-orientation="vertical"
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuenow={width}
        className="sidebar-resize-handle ghost"
        onKeyDown={(event) => {
          const step = event.shiftKey ? 24 : 8;
          const nextWidth =
            event.key === "ArrowLeft"
              ? width - step
              : event.key === "ArrowRight"
                ? width + step
                : event.key === "Home"
                  ? SIDEBAR_MIN_WIDTH
                  : event.key === "End"
                    ? SIDEBAR_MAX_WIDTH
                    : null;
          if (nextWidth === null) {
            return;
          }

          event.preventDefault();
          onWidthChange(clamp(nextWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = width;

          function handlePointerMove(moveEvent: PointerEvent) {
            onWidthChange(
              clamp(
                startWidth + moveEvent.clientX - startX,
                SIDEBAR_MIN_WIDTH,
                SIDEBAR_MAX_WIDTH,
              ),
            );
          }

          function handlePointerUp() {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
          }

          window.addEventListener("pointermove", handlePointerMove);
          window.addEventListener("pointerup", handlePointerUp);
        }}
        role="separator"
        type="button"
      />
    </aside>
  );
}

type PageThumbnailProps = {
  active: boolean;
  annotations: PdfAnnotation[];
  busy: boolean;
  menuOpen: boolean;
  onAddBlankAfter: () => void;
  onAddBlankBefore: () => void;
  onAddLinedAfter: () => void;
  onAddLinedBefore: () => void;
  onDelete: () => void;
  onMenuToggle: () => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRotate: () => void;
  onSelect: () => void;
  onThumbnailPageLoad: (page: PDFPageProxy, pageIndex: number) => void;
  page: LoadedPage;
  pageCount: number;
  pageIndex: number;
  pageSize: PageSize | null;
  pdfDoc: PDFDocumentProxy | null;
  readOnly: boolean;
  showAnnotations: boolean;
  thumbnailWidth: number;
};

function PageThumbnail({
  active,
  annotations,
  busy,
  menuOpen,
  onAddBlankAfter,
  onAddBlankBefore,
  onAddLinedAfter,
  onAddLinedBefore,
  onDelete,
  onMenuToggle,
  onMoveDown,
  onMoveUp,
  onRotate,
  onSelect,
  onThumbnailPageLoad,
  page,
  pageCount,
  pageIndex,
  pageSize,
  pdfDoc,
  readOnly,
  showAnnotations,
  thumbnailWidth,
}: PageThumbnailProps) {
  const [thumbnailRef, thumbnailVisible] =
    useElementVisibility<HTMLDivElement>("400px");
  const [thumbnailPage, setThumbnailPage] = useState<PDFPageProxy | null>(null);
  const displayPage = page ?? thumbnailPage;
  const viewport = displayPage?.getViewport({ scale: 1 });
  const thumbnailSize = {
    width: viewport?.width ?? pageSize?.width ?? 612,
    height: viewport?.height ?? pageSize?.height ?? 792,
  };

  useEffect(() => {
    if (page || !thumbnailVisible || !pdfDoc) {
      setThumbnailPage(null);
      return;
    }

    let cancelled = false;
    let loadedPage: PDFPageProxy | null = null;

    void pdfDoc
      .getPage(pageIndex + 1)
      .then((nextPage) => {
        loadedPage = nextPage;
        if (cancelled) {
          scheduleTemporaryPageCleanup(nextPage);
          return;
        }

        setThumbnailPage(nextPage);
        onThumbnailPageLoad(nextPage, pageIndex);
      })
      .catch(() => {
        // The blank placeholder is feedback enough.
      });

    return () => {
      cancelled = true;
      if (loadedPage) {
        scheduleTemporaryPageCleanup(loadedPage);
      }
    };
  }, [onThumbnailPageLoad, page, pageIndex, pdfDoc, thumbnailVisible]);

  return (
    <div
      className="page-thumbnail"
      data-thumbnail-index={pageIndex}
      onBlur={(event) => {
        if (menuOpen && !event.currentTarget.contains(event.relatedTarget)) {
          onMenuToggle();
        }
      }}
      ref={thumbnailRef}
    >
      <button
        aria-current={active ? "page" : undefined}
        aria-label={`Page ${pageIndex + 1}`}
        className={`page-thumbnail-button ${
          active ? "selected" : "page-thumbnail-button-inactive"
        }`}
        disabled={busy}
        onClick={onSelect}
        type="button"
      >
        <div
          className="page-thumbnail-preview"
          style={{
            aspectRatio: `${thumbnailSize.width} / ${thumbnailSize.height}`,
            width: thumbnailWidth,
          }}
        >
          {displayPage && viewport && thumbnailVisible ? (
            <>
              <ThumbnailPageCanvas page={displayPage} width={thumbnailWidth} />
              {showAnnotations ? (
                <ThumbnailAnnotations
                  annotations={annotations}
                  height={viewport.height}
                  viewport={viewport}
                  width={viewport.width}
                />
              ) : null}
            </>
          ) : (
            <div className="page-thumbnail-placeholder">{pageIndex + 1}</div>
          )}
        </div>
        <div className="page-thumbnail-number">{pageIndex + 1}</div>
      </button>
      <button
        aria-expanded={menuOpen}
        aria-label={`Actions for page ${pageIndex + 1}`}
        className="page-thumbnail-menu-toggle icon-center"
        disabled={busy || readOnly}
        onClick={(event) => {
          event.stopPropagation();
          onMenuToggle();
        }}
        title="Page actions"
        type="button"
      >
        <MoreVertical size={14} />
      </button>
      {menuOpen ? (
        <div className="panel floating menu page-menu z-dropdown">
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly}
            onClick={onRotate}
            type="button"
          >
            <RotateCw className="page-menu-item-icon" size={14} />
            <span>Rotate</span>
          </button>
          <div className="menu-separator" role="separator" />
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly || pageIndex === 0}
            onClick={onMoveUp}
            type="button"
          >
            <ChevronUp className="page-menu-item-icon" size={14} />
            <span>Move up (before)</span>
          </button>
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly || pageIndex === pageCount - 1}
            onClick={onMoveDown}
            type="button"
          >
            <ChevronDown className="page-menu-item-icon" size={14} />
            <span>Move down (after)</span>
          </button>
          <div className="menu-separator" role="separator" />
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly}
            onClick={onAddBlankBefore}
            type="button"
          >
            <PageInsertIcon lined={false} />
            <span>Add blank before</span>
          </button>
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly}
            onClick={onAddLinedBefore}
            type="button"
          >
            <PageInsertIcon lined />
            <span>Add lined before</span>
          </button>
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly}
            onClick={onAddBlankAfter}
            type="button"
          >
            <PageInsertIcon lined={false} />
            <span>Add blank after</span>
          </button>
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly}
            onClick={onAddLinedAfter}
            type="button"
          >
            <PageInsertIcon lined />
            <span>Add lined after</span>
          </button>
          <div className="menu-separator" role="separator" />
          <button
            className={`${PAGE_MENU_ITEM_CLASS} page-menu-item-danger`}
            disabled={busy || readOnly || pageCount <= 1}
            onClick={onDelete}
            type="button"
          >
            <Trash2 className="page-menu-item-icon" size={14} />
            <span>Delete page</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PageInsertIcon({ lined }: { lined: boolean }) {
  if (!lined) {
    return <FilePlus2 className="page-menu-item-icon" size={14} />;
  }

  return (
    <svg
      aria-hidden="true"
      className="page-menu-item-icon"
      fill="none"
      height={14}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={14}
    >
      {/* file-plus-corner's own outline and folded corner, so the "+" reads
          the same badge as the plain add-page icon beside it. */}
      <path d="M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M14 19h6" />
      <path d="M17 16v6" />
      {/* Two ruled lines, clear of the "+" badge's corner, for "lined". */}
      <path d="M8 12h7" />
      <path d="M8 16h5" />
    </svg>
  );
}

function scheduleTemporaryPageCleanup(page: PDFPageProxy) {
  const cleanup = () => {
    try {
      page.cleanup();
    } catch {
      // Internal bookkeeping; nothing for the user to act on.
    }
  };

  if (window.requestIdleCallback) {
    window.requestIdleCallback(cleanup, { timeout: 1000 });
  } else {
    window.setTimeout(cleanup, 0);
  }
}

// One observer per rootMargin rather than one per thumbnail, of which a long
// document has hundreds.
const sharedIntersectionObservers = new Map<
  string,
  {
    observer: IntersectionObserver;
    callbacks: WeakMap<Element, (visible: boolean) => void>;
  }
>();

function getSharedIntersectionObserver(rootMargin: string) {
  let entry = sharedIntersectionObservers.get(rootMargin);
  if (!entry) {
    const callbacks = new WeakMap<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          callbacks.get(entry.target)?.(entry.isIntersecting);
        }
      },
      { rootMargin },
    );
    entry = { observer, callbacks };
    sharedIntersectionObservers.set(rootMargin, entry);
  }
  return entry;
}

function useElementVisibility<T extends Element>(rootMargin: string) {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    const { observer, callbacks } = getSharedIntersectionObserver(rootMargin);
    callbacks.set(element, setVisible);
    observer.observe(element);
    return () => {
      observer.unobserve(element);
      callbacks.delete(element);
    };
  }, [rootMargin]);

  return [ref, visible] as const;
}

function ThumbnailPageCanvas({
  page,
  width,
}: {
  page: PDFPageProxy;
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    const baseViewport = page.getViewport({ scale: 1 });
    const renderScale = width / baseViewport.width;
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }
    const renderCanvas = canvas;

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const renderContext = context;

    const pixelRatio = safeCanvasPixelRatio(
      viewport.width,
      viewport.height,
      window.devicePixelRatio || 1,
    );
    canvas.width = Math.ceil(viewport.width * pixelRatio);
    canvas.height = Math.ceil(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    async function renderThumbnail(annotationMode: number) {
      renderContext.clearRect(0, 0, viewport.width, viewport.height);
      renderTask = page.render({
        annotationMode,
        canvas: renderCanvas,
        canvasContext: renderContext,
        viewport,
      });
      await renderTask.promise;
    }

    async function renderThumbnailWithRecovery() {
      try {
        const cachedRenderMode = cachedPageBaseRenderMode(page);
        if (cachedRenderMode === "annotationAppearance") {
          const hasPageContent = await pageHasRenderableContent(page);
          await renderThumbnail(
            hasPageContent ? AnnotationMode.DISABLE : AnnotationMode.ENABLE,
          );
          if (hasPageContent) {
            cachePageBaseRenderMode(page, "normal");
          }
          return;
        }

        await renderThumbnail(AnnotationMode.DISABLE);
        if (
          !cancelled &&
          cachedRenderMode !== "normal" &&
          canvasLooksEmpty(renderCanvas)
        ) {
          const hasPageContent = await pageHasRenderableContent(page);
          if (!hasPageContent || cancelled) {
            if (!cancelled) {
              await renderThumbnail(AnnotationMode.ENABLE);
              if (!canvasLooksEmpty(renderCanvas)) {
                cachePageBaseRenderMode(page, "annotationAppearance");
              }
            }
            return;
          }

          cachePageBaseRenderMode(page, "normal");
        } else if (!cancelled) {
          cachePageBaseRenderMode(page, "normal");
        }
      } catch {
        // The blank placeholder is feedback enough.
      }
    }

    void renderThumbnailWithRecovery();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      releaseCanvasBuffer(renderCanvas);
    };
  }, [page, width]);

  return <canvas className="thumbnail-canvas" ref={canvasRef} />;
}

function ThumbnailAnnotations({
  annotations,
  height,
  viewport,
  width,
}: {
  annotations: PdfAnnotation[];
  height: number;
  viewport: PageViewport;
  width: number;
}) {
  return (
    <svg className="thumbnail-annotations" viewBox={`0 0 ${width} ${height}`}>
      {annotations.map((annotation) => {
        switch (annotation.kind) {
          case "textHighlight":
            return annotation.rects.map((rect, index) => {
              const bounds = pdfRectToViewportRect(rect, viewport);
              return (
                <rect
                  fill={rgbToHex(annotation.color)}
                  height={bounds.height}
                  key={`${annotation.id}-${index}`}
                  opacity={annotation.opacity}
                  width={bounds.width}
                  x={bounds.x}
                  y={bounds.y}
                />
              );
            });

          case "draw":
          case "freehandHighlight":
            return annotation.paths.map((path, index) => (
              <path
                d={pathToViewportD(path, viewport)}
                fill="none"
                key={`${annotation.id}-${index}`}
                opacity={annotation.opacity}
                stroke={rgbToHex(annotation.color)}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={Math.max(
                  1,
                  annotation.kind === "freehandHighlight"
                    ? annotation.width
                    : annotation.width * 0.7,
                )}
              />
            ));

          case "freeText": {
            const bounds = pdfRectToViewportRect(annotation.rect, viewport);
            const { transform } = annotationContentTransform(
              bounds,
              viewport,
              annotation.rotation ?? 0,
            );
            const fontSize = Math.max(4, annotation.fontSize * viewport.scale);
            const lineHeight = fontSize * FREE_TEXT_LINE_HEIGHT;
            const lines = freeTextVisualLines(
              annotation.text,
              annotation.fontSize,
              Math.abs(annotation.rect.x2 - annotation.rect.x1),
            );
            return (
              <g key={annotation.id} transform={transform}>
                {lines.map((line, index) => (
                  <text
                    dominantBaseline="text-before-edge"
                    fill={rgbToHex(annotation.color)}
                    fontSize={fontSize}
                    key={index}
                    opacity={annotation.opacity}
                    x={0}
                    y={index * lineHeight}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          }

          case "stickyNote": {
            const bounds = pdfRectToViewportRect(annotation.rect, viewport);
            return (
              <rect
                fill={rgbToHex(annotation.color)}
                height={Math.max(8, bounds.height)}
                key={annotation.id}
                // On the note's own colour, so never the theme ink.
                stroke={foregroundOn(annotation.color)}
                strokeOpacity="0.62"
                strokeWidth="1"
                width={Math.max(8, bounds.width)}
                x={bounds.x}
                y={bounds.y}
              />
            );
          }

          case "imageStamp": {
            const bounds = pdfRectToViewportRect(annotation.rect, viewport);
            const { localWidth, localHeight, transform } =
              annotationContentTransform(
                bounds,
                viewport,
                annotation.rotation ?? 0,
              );
            return (
              <image
                height={Math.max(4, localHeight)}
                href={`data:${annotation.mimeType};base64,${annotation.imageData}`}
                key={annotation.id}
                preserveAspectRatio="xMidYMid meet"
                transform={transform}
                width={Math.max(4, localWidth)}
              />
            );
          }
        }
      })}
    </svg>
  );
}
