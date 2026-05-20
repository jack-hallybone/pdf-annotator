import { useEffect, useRef, useState } from 'react';
import { AnnotationMode } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { ChevronLeft, FilePlus2, MoreVertical } from 'lucide-react';
import { rgbToHex } from '../SettingsPanel';
import { pathToViewportD, pdfRectToViewportRect } from '../pdfGeometry';
import {
  cachePageBaseRenderMode,
  cachedPageBaseRenderMode,
  canvasLooksEmpty,
  safeCanvasPixelRatio
} from '../pdfRender';
import type { LoadedPage, PageSize, PageViewport, PdfAnnotation } from '../types';
import {
  clamp,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from '../viewerConfig';

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const SIDEBAR_ICON_BUTTON_CLASS = 'ui-button grid h-8 w-8 place-items-center';
const PAGE_MENU_ITEM_CLASS =
  'ui-button rounded px-2 py-1 text-left font-medium disabled:opacity-40';

type DocumentSidebarProps = {
  activePageIndex: number;
  annotationsByPage: Map<number, PdfAnnotation[]>;
  busy: boolean;
  onAddPage: (pageIndex?: number, position?: 'before' | 'after') => void;
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
  setPageMenuIndex: (pageIndex: number | null) => void;
  showAnnotations: boolean;
  width: number;
};

export function DocumentSidebar({
  activePageIndex,
  annotationsByPage,
  busy,
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
  setPageMenuIndex,
  showAnnotations,
  width
}: DocumentSidebarProps) {
  const sidebarScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const scrollContainer = sidebarScrollRef.current;
    const activeThumbnail = scrollContainer?.querySelector<HTMLElement>(
      `[data-thumbnail-index="${activePageIndex}"]`
    );
    if (!scrollContainer || !activeThumbnail) {
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
  }, [activePageIndex, open]);

  if (!open) {
    return null;
  }

  const thumbnailWidth = Math.round(clamp(width - 52, 108, 284));

  return (
    <aside
      className="ui-frame screen-only absolute bottom-2 left-2 top-2 z-30 flex max-w-[calc(100vw-1rem)] flex-col text-app-ink sm:bottom-3 sm:left-3 sm:top-3"
      style={{ width }}
    >
      <div className="flex justify-end border-b border-app-ink/10 p-1.5">
        <button
          className={SIDEBAR_ICON_BUTTON_CLASS}
          onClick={onClose}
          title="Hide sidebar"
          type="button"
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2" ref={sidebarScrollRef}>
        {pages.map((page, index) => (
          <PageThumbnail
            active={index === activePageIndex}
            annotations={annotationsByPage.get(index) ?? EMPTY_ANNOTATIONS}
            key={index}
            menuOpen={pageMenuIndex === index}
            onAddAfter={() => onAddPage(index, 'after')}
            onAddBefore={() => onAddPage(index, 'before')}
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
            showAnnotations={showAnnotations}
            onThumbnailPageLoad={onThumbnailPageLoad}
            thumbnailWidth={thumbnailWidth}
          />
        ))}
        {pages.length > 0 ? (
          <button
            className="ui-button mb-1 flex w-full items-center justify-center gap-2 border-dashed border-app-ink/20 bg-app-ui px-2 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
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
        className="ui-button absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize rounded-r"
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
  menuOpen: boolean;
  onAddAfter: () => void;
  onAddBefore: () => void;
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
  showAnnotations: boolean;
  thumbnailWidth: number;
};

function PageThumbnail({
  active,
  annotations,
  menuOpen,
  onAddAfter,
  onAddBefore,
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
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
        }
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
      className="relative mb-3"
      data-thumbnail-index={pageIndex}
      onBlur={(event) => {
        if (menuOpen && !event.currentTarget.contains(event.relatedTarget)) {
          onMenuToggle();
        }
      }}
      ref={thumbnailRef}
    >
      <button
        className={`ui-button block w-full bg-app-ui p-1 text-left ${
          active ? 'ui-button-active' : 'border-app-ink/12'
        }`}
        onClick={onSelect}
        type="button"
      >
        <div
          className="relative mx-auto overflow-hidden bg-app-ui"
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
            <div className="absolute inset-0 grid place-items-center bg-app-bg text-[10px] font-medium text-app-ink/50">
              {pageIndex + 1}
            </div>
          )}
        </div>
        <div className="mt-1 text-center text-[11px] font-medium text-app-ink/85">
          {pageIndex + 1}
        </div>
      </button>
      <button
        className="ui-button absolute right-1 top-1 grid h-6 w-6 place-items-center bg-app-ui shadow-sm shadow-app-ink/5"
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
        <div className="ui-panel absolute right-1 top-8 z-50 grid w-36 gap-1 p-1 text-xs font-medium text-app-ink">
          <button
            className={PAGE_MENU_ITEM_CLASS}
            onClick={onAddBefore}
            type="button"
          >
            Add before
          </button>
          <button
            className={PAGE_MENU_ITEM_CLASS}
            onClick={onAddAfter}
            type="button"
          >
            Add after
          </button>
          <button
            className={PAGE_MENU_ITEM_CLASS}
            onClick={onRotate}
            type="button"
          >
            Rotate
          </button>
          <button
            className={PAGE_MENU_ITEM_CLASS}
            disabled={pageCount <= 1}
            onClick={onDelete}
            type="button"
          >
            Delete page
          </button>
        </div>
      ) : null}
    </div>
  );
}

function scheduleTemporaryPageCleanup(page: PDFPageProxy) {
  const cleanup = () => {
    try {
      page.cleanup();
    } catch (error) {
      console.error(error);
    }
  };

  if (window.requestIdleCallback) {
    window.requestIdleCallback(cleanup, { timeout: 1000 });
  } else {
    window.setTimeout(cleanup, 0);
  }
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

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          setVisible(entry.isIntersecting);
        }
      },
      { rootMargin }
    );
    observer.observe(element);
    return () => observer.disconnect();
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
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
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
          await renderThumbnail(AnnotationMode.ENABLE);
          return;
        }

        await renderThumbnail(AnnotationMode.DISABLE);
        if (
          !cancelled &&
          cachedRenderMode !== 'normal' &&
          canvasLooksEmpty(renderCanvas)
        ) {
          await renderThumbnail(AnnotationMode.ENABLE);
          if (!canvasLooksEmpty(renderCanvas)) {
            cachePageBaseRenderMode(page, 'annotationAppearance');
          }
        } else if (!cancelled) {
          cachePageBaseRenderMode(page, 'normal');
        }
      } catch (error) {
        if (!cancelled && !isRenderCancellation(error)) {
          console.error(error);
        }
      }
    }

    void renderThumbnailWithRecovery();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [page, width]);

  return <canvas className="absolute inset-0 h-full w-full" ref={canvasRef} />;
}

function isRenderCancellation(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'RenderingCancelledException' ||
      error.message.includes('cancelled'))
  );
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
      className="absolute inset-0 h-full w-full"
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
            return (
              <rect
                fill={rgbToHex(annotation.color)}
                height={Math.max(2, bounds.height)}
                key={annotation.id}
                opacity={annotation.opacity}
                width={Math.max(4, bounds.width)}
                x={bounds.x}
                y={bounds.y}
              />
            );
          }

          case 'stickyNote': {
            const bounds = pdfRectToViewportRect(annotation.rect, viewport);
            return (
              <rect
                fill={rgbToHex(annotation.color)}
                height={Math.max(8, bounds.height)}
                key={annotation.id}
                stroke="#854d0e"
                strokeWidth="1"
                width={Math.max(8, bounds.width)}
                x={bounds.x}
                y={bounds.y}
              />
            );
          }
        }
      })}
    </svg>
  );
}
