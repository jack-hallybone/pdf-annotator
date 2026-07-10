import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnnotationMode } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { ChevronLeft, FilePlus2, MoreVertical, RotateCw, Trash2 } from 'lucide-react';
import { rgbToHex } from '../annotationColors';
import { FREE_TEXT_LINE_HEIGHT, freeTextVisualLines } from '../freeTextLayout';
import {
  annotationContentTransform,
  pathToViewportD,
  pdfRectToViewportRect
} from '../pdfGeometry';
import {
  cachePageBaseRenderMode,
  cachedPageBaseRenderMode,
  canvasLooksEmpty,
  pageHasRenderableContent,
  safeCanvasPixelRatio
} from '../pdfRender';
import type { LoadedPage, PageSize, PageViewport, PdfAnnotation } from '../types';
import {
  clamp,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_ROW_HEIGHT,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_ROW_BUFFER,
  SIDEBAR_ROW_CHROME_HEIGHT
} from '../viewerConfig';

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const SIDEBAR_ICON_BUTTON_CLASS = 'icon-button ui-button';
const PAGE_MENU_ITEM_CLASS = 'page-menu-item ui-button';
type SidebarPageInsertKind = 'blank' | 'lined';

type DocumentSidebarProps = {
  activePageIndex: number;
  annotationsByPage: Map<number, PdfAnnotation[]>;
  busy: boolean;
  canMergePdf?: boolean;
  onAddPage: (
    pageIndex?: number,
    position?: 'before' | 'after',
    kind?: SidebarPageInsertKind
  ) => void;
  onClose: () => void;
  onDeletePage: (pageIndex?: number) => void;
  onMergePdf: () => void;
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
  annotationsByPage,
  busy,
  canMergePdf = false,
  onAddPage,
  onClose,
  onDeletePage,
  onMergePdf,
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
  width
}: DocumentSidebarProps) {
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const [scrollMetrics, setScrollMetrics] = useState({
    clientHeight: 0,
    scrollTop: 0
  });
  const thumbnailWidth = Math.round(clamp(width - 52, 108, 284));
  const estimatedRowHeight = Math.max(
    SIDEBAR_MIN_ROW_HEIGHT,
    thumbnailWidth * ((pageSize?.height ?? 792) / (pageSize?.width ?? 612)) +
      SIDEBAR_ROW_CHROME_HEIGHT
  );

  useEffect(() => {
    if (busy && pageMenuIndex !== null) {
      setPageMenuIndex(null);
    }
  }, [busy, pageMenuIndex, setPageMenuIndex]);

  // Tracks scroll position/viewport height so only thumbnails near the
  // visible range are mounted (see thumbnail windowing below), instead of
  // every page's thumbnail mounting a DOM node + IntersectionObserver
  // registration upfront regardless of document length.
  useLayoutEffect(() => {
    if (!open) {
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
          scrollTop: container.scrollTop
        };
        return current.clientHeight === next.clientHeight &&
          current.scrollTop === next.scrollTop
          ? current
          : next;
      });
    };

    updateMetrics();
    container.addEventListener('scroll', updateMetrics, { passive: true });
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(container);
    return () => {
      container.removeEventListener('scroll', updateMetrics);
      observer.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const scrollContainer = sidebarScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const activeThumbnail = scrollContainer.querySelector<HTMLElement>(
      `[data-thumbnail-index="${activePageIndex}"]`
    );

    if (!activeThumbnail) {
      // The active page's thumbnail isn't currently mounted (windowing
      // above only renders thumbnails near the current scroll position).
      // Jump to an estimated position instead of forcing it into the
      // render range - that would require rendering everything between
      // the current scroll position and the active page, which can be
      // most of the document if they're far apart. The jump changes
      // scroll position, which updates the rendered window naturally, so
      // this doesn't need pixel-perfect centering.
      const maxScrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight
      );
      scrollContainer.scrollTo({
        top: clamp(
          activePageIndex * estimatedRowHeight -
            scrollContainer.clientHeight / 2,
          0,
          maxScrollTop
        ),
        behavior: 'auto'
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
      behavior: 'auto'
    });
  }, [activePageIndex, estimatedRowHeight, open]);

  if (!open) {
    return null;
  }

  // The active page's thumbnail is handled separately above: if it's ever
  // outside this window, the scroll-to-active effect jumps the scroll
  // position toward it (updating scrollMetrics, which re-derives this
  // window), rather than this window being forced to always span it -
  // that could otherwise force-render most of the document when the
  // active page and current scroll position are far apart.
  const pageCount = pages.length;
  const startIndex = Math.max(
    0,
    Math.floor(scrollMetrics.scrollTop / estimatedRowHeight) -
      SIDEBAR_ROW_BUFFER
  );
  const endIndex = Math.min(
    pageCount - 1,
    Math.ceil(
      (scrollMetrics.scrollTop + scrollMetrics.clientHeight) /
        estimatedRowHeight
    ) + SIDEBAR_ROW_BUFFER
  );
  const topSpacerHeight = Math.max(0, startIndex) * estimatedRowHeight;
  const bottomSpacerHeight =
    Math.max(0, pageCount - 1 - endIndex) * estimatedRowHeight;

  return (
    <aside
      className="document-sidebar ui-frame screen-only"
      style={{ width }}
    >
      <div className="document-sidebar-header">
        <button
          className={SIDEBAR_ICON_BUTTON_CLASS}
          onClick={onClose}
          title="Hide sidebar"
          type="button"
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="document-sidebar-scroll" ref={sidebarScrollRef}>
        {topSpacerHeight > 0 ? (
          <div aria-hidden="true" style={{ height: topSpacerHeight }} />
        ) : null}
        {pages.slice(startIndex, endIndex + 1).map((page, offset) => {
          const index = startIndex + offset;
          return (
            <PageThumbnail
              active={index === activePageIndex}
              annotations={annotationsByPage.get(index) ?? EMPTY_ANNOTATIONS}
              key={index}
              menuOpen={pageMenuIndex === index}
              onAddBlankAfter={() => onAddPage(index, 'after', 'blank')}
              onAddBlankBefore={() => onAddPage(index, 'before', 'blank')}
              onAddLinedAfter={() => onAddPage(index, 'after', 'lined')}
              onAddLinedBefore={() => onAddPage(index, 'before', 'lined')}
              onDelete={() => onDeletePage(index)}
              onMenuToggle={() =>
                setPageMenuIndex(pageMenuIndex === index ? null : index)
              }
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
            className="merge-pdf-button ui-button"
            disabled={busy || readOnly}
            onClick={onMergePdf}
            title="Add PDF"
            type="button"
          >
            <FilePlus2 size={14} />
            Merge PDF
          </button>
        ) : null}
      </div>

      <button
        aria-label="Resize pages sidebar"
        className="sidebar-resize-handle ui-button"
        onPointerDown={(event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = width;

          function handlePointerMove(moveEvent: PointerEvent) {
            onWidthChange(
              clamp(
                startWidth + moveEvent.clientX - startX,
                SIDEBAR_MIN_WIDTH,
                SIDEBAR_MAX_WIDTH
              )
            );
          }

          function handlePointerUp() {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
          }

          window.addEventListener('pointermove', handlePointerMove);
          window.addEventListener('pointerup', handlePointerUp);
        }}
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
  thumbnailWidth
}: PageThumbnailProps) {
  const [thumbnailRef, thumbnailVisible] =
    useElementVisibility<HTMLDivElement>('400px');
  const [thumbnailPage, setThumbnailPage] = useState<PDFPageProxy | null>(null);
  const displayPage = page ?? thumbnailPage;
  const viewport = displayPage?.getViewport({ scale: 1 });
  const thumbnailSize = {
    width: viewport?.width ?? pageSize?.width ?? 612,
    height: viewport?.height ?? pageSize?.height ?? 792
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
        // Thumbnail stays a blank placeholder, which is visible feedback on
        // its own - not worth a separate notice for every failed thumbnail.
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
        className={`page-thumbnail-button ui-button ${
          active ? 'ui-button-active' : 'page-thumbnail-button-inactive'
        }`}
        disabled={busy}
        onClick={onSelect}
        type="button"
      >
        <div
          className="page-thumbnail-preview"
          style={{
            aspectRatio: `${thumbnailSize.width} / ${thumbnailSize.height}`,
            width: thumbnailWidth
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
            <div className="page-thumbnail-placeholder">
              {pageIndex + 1}
            </div>
          )}
        </div>
        <div className="page-thumbnail-number">
          {pageIndex + 1}
        </div>
      </button>
      <button
        className="page-thumbnail-menu-toggle ui-button"
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
        <div className="page-menu ui-panel">
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={busy || readOnly}
            onClick={onRotate}
            type="button"
          >
            <RotateCw className="page-menu-item-icon" size={14} />
            <span>Rotate</span>
          </button>
          <div className="page-menu-separator" role="separator" />
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
          <div className="page-menu-separator" role="separator" />
          <button
            className={PAGE_MENU_ITEM_CLASS}
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
  return (
    <span className="page-menu-insert-icon page-menu-item-icon">
      <FilePlus2 size={14} />
      {lined ? (
        <span className="page-menu-insert-lines" aria-hidden="true">
          <span />
          <span />
        </span>
      ) : null}
    </span>
  );
}

function scheduleTemporaryPageCleanup(page: PDFPageProxy) {
  const cleanup = () => {
    try {
      page.cleanup();
    } catch {
      // Internal resource bookkeeping only - nothing for the user to act on.
    }
  };

  if (window.requestIdleCallback) {
    window.requestIdleCallback(cleanup, { timeout: 1000 });
  } else {
    window.setTimeout(cleanup, 0);
  }
}

// Page thumbnails (one per PDF page, potentially hundreds) each call
// useElementVisibility. A shared IntersectionObserver per rootMargin, keyed
// by target element, avoids spinning up a separate observer per thumbnail.
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
      { rootMargin }
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

    if (!('IntersectionObserver' in window)) {
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
  width
}: {
  page: PDFPageProxy;
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    const baseViewport = page.getViewport({ scale: 1 });
    const renderScale = width / baseViewport.width;
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }
    const renderCanvas = canvas;

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    const renderContext = context;

    const pixelRatio = safeCanvasPixelRatio(
      viewport.width,
      viewport.height,
      window.devicePixelRatio || 1
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
        viewport
      });
      await renderTask.promise;
    }

    async function renderThumbnailWithRecovery() {
      try {
        const cachedRenderMode = cachedPageBaseRenderMode(page);
        if (cachedRenderMode === 'annotationAppearance') {
          const hasPageContent = await pageHasRenderableContent(page);
          await renderThumbnail(
            hasPageContent ? AnnotationMode.DISABLE : AnnotationMode.ENABLE
          );
          if (hasPageContent) {
            cachePageBaseRenderMode(page, 'normal');
          }
          return;
        }

        await renderThumbnail(AnnotationMode.DISABLE);
        if (
          !cancelled &&
          cachedRenderMode !== 'normal' &&
          canvasLooksEmpty(renderCanvas)
        ) {
          const hasPageContent = await pageHasRenderableContent(page);
          if (!hasPageContent || cancelled) {
            if (!cancelled) {
              await renderThumbnail(AnnotationMode.ENABLE);
              if (!canvasLooksEmpty(renderCanvas)) {
                cachePageBaseRenderMode(page, 'annotationAppearance');
              }
            }
            return;
          }

          cachePageBaseRenderMode(page, 'normal');
        } else if (!cancelled) {
          cachePageBaseRenderMode(page, 'normal');
        }
      } catch {
        // Thumbnail stays a blank placeholder, which is visible feedback on
        // its own - not worth a separate notice for every failed thumbnail.
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

function releaseCanvasBuffer(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

function ThumbnailAnnotations({
  annotations,
  height,
  viewport,
  width
}: {
  annotations: PdfAnnotation[];
  height: number;
  viewport: PageViewport;
  width: number;
}) {
  return (
    <svg
      className="thumbnail-annotations"
      viewBox={`0 0 ${width} ${height}`}
    >
      {annotations.map((annotation) => {
        switch (annotation.kind) {
          case 'textHighlight':
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

          case 'draw':
          case 'freehandHighlight':
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
                  annotation.kind === 'freehandHighlight'
                    ? annotation.width
                    : annotation.width * 0.7
                )}
              />
            ));

          case 'freeText': {
            const bounds = pdfRectToViewportRect(annotation.rect, viewport);
            const { transform } = annotationContentTransform(
              bounds,
              viewport,
              annotation.rotation ?? 0
            );
            const fontSize = Math.max(4, annotation.fontSize * viewport.scale);
            const lineHeight = fontSize * FREE_TEXT_LINE_HEIGHT;
            const lines = freeTextVisualLines(
              annotation.text,
              annotation.fontSize,
              Math.abs(annotation.rect.x2 - annotation.rect.x1)
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

          case 'stickyNote': {
            const bounds = pdfRectToViewportRect(annotation.rect, viewport);
            return (
              <rect
                fill={rgbToHex(annotation.color)}
                height={Math.max(8, bounds.height)}
                key={annotation.id}
                stroke="var(--pdfa-ink)"
                strokeOpacity="0.62"
                strokeWidth="1"
                width={Math.max(8, bounds.width)}
                x={bounds.x}
                y={bounds.y}
              />
            );
          }

          case 'imageStamp': {
            const bounds = pdfRectToViewportRect(annotation.rect, viewport);
            const { localWidth, localHeight, transform } = annotationContentTransform(
              bounds,
              viewport,
              annotation.rotation ?? 0
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
