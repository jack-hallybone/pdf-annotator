import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  adjacentFindMatch,
  buildPageFindText,
  compileFindQuery,
  countFindMatches,
  findMatchBounds,
  findPageMatches,
  firstMatchFrom,
  type FindMatchPosition,
  type PageFindMatches,
  type PageFindText,
} from "./documentFind";
import type { PdfRect } from "./types";
import { useRenderLatestRef } from "./useRenderLatestRef";
import { clamp } from "./viewerConfig";

/** "n of m" for a host's find bar. */
export type PdfDocumentEditorFindResults = {
  /** False while pages are still being read, when `total` can still grow and `current` with it, and while there is no query. */
  complete: boolean;
  /** 1-based, and 0 while no match is current. */
  current: number;
  total: number;
};

export type DocumentFindMatches = {
  complete: boolean;
  current: FindMatchPosition | null;
  matchesByPage: ReadonlyMap<number, PageFindMatches>;
};

// A page's text is read once per document and kept, so a later query - or another view of the same document - searches it straight away. Keyed weakly, so a closed or replaced document takes its text with it.
type PageTextCache = {
  pending: Map<number, Promise<PageFindText | null>>;
  texts: Array<PageFindText | null | undefined>;
};

type FindAnchor = { offset: number; pageIndex: number };

type FindRun = {
  anchor: FindAnchor;
  cancelled: boolean;
  complete: boolean;
  current: FindMatchPosition | null;
  doc: PDFDocumentProxy;
  matchesByPage: Map<number, PageFindMatches>;
  pattern: RegExp;
  // An Enter pressed before the pages it would step over were read, carried out once they are.
  pendingStep: -1 | 0 | 1;
  publishedAt: number;
  // How many pages had matches when last published: matches only ever arrive a page at a time.
  publishedPages: number;
  readPages: Uint8Array;
};

const pageTextCaches = new WeakMap<PDFDocumentProxy, PageTextCache>();

// The text layer reads its items with these, so an offset into one is an offset into the other.
const TEXT_CONTENT_OPTIONS = {
  disableNormalization: true,
  includeMarkedContent: true,
};
// How long a search runs before the browser gets a turn when it has no idle time to go by: straight after a keystroke, or with no requestIdleCallback.
const FIND_SLICE_MS = 8;
// Often enough for the count to look live, rarely enough not to re-render the page column for every page read.
const FIND_PROGRESS_MS = 150;
// Reading waits for idle time, so opening, scrolling and drawing go first, but not for longer than this.
const FIND_IDLE_TIMEOUT_MS = 500;

// Nothing searched yet - or no query, which has nothing to count - so a bar reopened on its last query reads "Searching", never a stale "No matches".
const NOT_FOUND_YET: DocumentFindMatches = {
  complete: false,
  current: null,
  matchesByPage: new Map(),
};

/** Searches the document for `query` and keeps one match current. Pages are read from where the reader is onward, so the first matches show at once however long the document is. */
export function useDocumentFind({
  anchorPageIndexRef,
  onResultsChange,
  onReveal,
  pdfDoc,
  query,
}: {
  /** The page a fresh search starts from. */
  anchorPageIndexRef: RefObject<number>;
  onResultsChange?: (results: PdfDocumentEditorFindResults) => void;
  /** Brings the current match into view; `bounds` is roughly where it sits on its page, in PDF units. */
  onReveal: (pageIndex: number, bounds: PdfRect | null) => void;
  pdfDoc: PDFDocumentProxy | null;
  query: string;
}) {
  const [found, setFound] = useState(NOT_FOUND_YET);
  const runRef = useRef<FindRun | null>(null);
  // The match last shown: a new query starts from there, so typing on narrows the search in place instead of jumping back to wherever the bar was opened.
  const anchorRef = useRef<FindAnchor | null>(null);
  const onRevealRef = useRenderLatestRef(onReveal);
  const onResultsChangeRef = useRenderLatestRef(onResultsChange);

  const publish = useCallback(
    (run: FindRun, reveal: boolean) => {
      if (run.cancelled) {
        return;
      }

      run.publishedAt = performance.now();
      run.publishedPages = run.matchesByPage.size;
      const next = {
        complete: run.complete,
        current: run.current,
        matchesByPage: new Map(run.matchesByPage),
      };
      startTransition(() => setFound(next));

      const current = run.current;
      const matches = current && run.matchesByPage.get(current.pageIndex);
      if (!reveal || !current || !matches) {
        return;
      }

      const start = matches[current.matchIndex * 2];
      const end = matches[current.matchIndex * 2 + 1];
      anchorRef.current = { offset: start, pageIndex: current.pageIndex };
      const pageText = pageTextCaches.get(run.doc)?.texts[current.pageIndex];
      onRevealRef.current(
        current.pageIndex,
        pageText ? findMatchBounds(pageText, start, end) : null,
      );
    },
    [onRevealRef],
  );

  useEffect(() => {
    const pattern = compileFindQuery(query);
    if (!pattern) {
      // Closing the bar or clearing the query forgets the place, so the next search starts from the page on screen.
      anchorRef.current = null;
    }
    if (!pattern || !pdfDoc || pdfDoc.numPages === 0) {
      runRef.current = null;
      startTransition(() => setFound(NOT_FOUND_YET));
      return;
    }

    const pageCount = pdfDoc.numPages;
    const anchor =
      anchorRef.current && anchorRef.current.pageIndex < pageCount
        ? anchorRef.current
        : {
            offset: 0,
            pageIndex: clamp(anchorPageIndexRef.current, 0, pageCount - 1),
          };
    const run: FindRun = {
      anchor,
      cancelled: false,
      complete: false,
      current: null,
      doc: pdfDoc,
      matchesByPage: new Map(),
      pattern,
      pendingStep: 0,
      publishedAt: performance.now(),
      publishedPages: 0,
      readPages: new Uint8Array(pageCount),
    };
    runRef.current = run;
    // Batched with whatever the already-read pages turn up below, so the last query's matches give way to this one's in a single render.
    startTransition(() => setFound(NOT_FOUND_YET));
    void searchDocument(run, publish);

    return () => {
      run.cancelled = true;
    };
  }, [anchorPageIndexRef, pdfDoc, publish, query]);

  // Reported only when one of the three changes, since every report re-renders the host - and, like everything find draws, as a transition, so a keystroke never waits for it.
  const { complete } = found;
  const { current, total } = useMemo(
    () => countFindMatches(found.matchesByPage, found.current),
    [found],
  );
  useEffect(() => {
    startTransition(() =>
      onResultsChangeRef.current?.({ complete, current, total }),
    );
  }, [complete, current, onResultsChangeRef, total]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const run = runRef.current;
      if (run && !run.cancelled) {
        stepRun(run, direction, publish);
      }
    },
    [publish],
  );

  return { found, step };
}

type Publish = (run: FindRun, reveal: boolean) => void;

async function searchDocument(run: FindRun, publish: Publish) {
  const cache = pageTextCacheFor(run.doc);
  const pageCount = run.readPages.length;
  // A slice straight away, so the pages already read are searched before the next frame; after that, only time the browser says it has spare.
  let idle = sliceFromNow();

  for (let step = 0; step < pageCount; step += 1) {
    if (idle.timeRemaining() <= 0) {
      if (
        run.matchesByPage.size > run.publishedPages &&
        performance.now() - run.publishedAt > FIND_PROGRESS_MS
      ) {
        publish(run, false);
      }
      idle = await whenIdle();
      if (run.cancelled) {
        return;
      }
    }

    const pageIndex = (run.anchor.pageIndex + step) % pageCount;
    let pageText = cache.texts[pageIndex];
    if (pageText === undefined) {
      pageText = await readPageText(run.doc, cache, pageIndex);
      if (run.cancelled) {
        return;
      }
    }
    searchPage(run, pageIndex, pageText, publish);
  }

  run.complete = true;
  // Every match on the starting page came before the reader's place, and there are none elsewhere: wrap round to the first.
  const wrapped = !run.current && run.matchesByPage.has(run.anchor.pageIndex);
  if (wrapped) {
    run.current = { matchIndex: 0, pageIndex: run.anchor.pageIndex };
  }
  publish(run, wrapped);
}

function searchPage(
  run: FindRun,
  pageIndex: number,
  pageText: PageFindText | null,
  publish: Publish,
) {
  run.readPages[pageIndex] = 1;
  const matches = pageText ? findPageMatches(pageText, run.pattern) : null;
  if (matches && matches.length > 0) {
    run.matchesByPage.set(pageIndex, matches);
    const first =
      pageIndex === run.anchor.pageIndex
        ? firstMatchFrom(matches, run.anchor.offset)
        : 0;
    if (!run.current && first >= 0) {
      run.current = { matchIndex: first, pageIndex };
      publish(run, true);
      return;
    }
  }

  if (run.pendingStep !== 0) {
    stepRun(run, run.pendingStep, publish);
  }
}

function stepRun(run: FindRun, direction: 1 | -1, publish: Publish) {
  // Nothing to step from yet; the first match found is shown regardless.
  if (!run.current) {
    return;
  }

  const next = adjacentFindMatch(
    run.current,
    direction,
    run.matchesByPage,
    run.readPages,
  );
  run.pendingStep = next ? 0 : direction;
  if (next) {
    run.current = next;
    publish(run, true);
  }
}

function pageTextCacheFor(doc: PDFDocumentProxy) {
  let cache = pageTextCaches.get(doc);
  if (!cache) {
    cache = { pending: new Map(), texts: [] };
    pageTextCaches.set(doc, cache);
  }
  return cache;
}

function readPageText(
  doc: PDFDocumentProxy,
  cache: PageTextCache,
  pageIndex: number,
) {
  let pending = cache.pending.get(pageIndex);
  if (!pending) {
    pending = doc
      .getPage(pageIndex + 1)
      .then((page) => page.getTextContent(TEXT_CONTENT_OPTIONS))
      .then((content) => buildPageFindText(content.items))
      // Searched as empty rather than ending the search: the other pages may still hold the match.
      .catch(() => null)
      .then((pageText) => {
        cache.texts[pageIndex] = pageText;
        cache.pending.delete(pageIndex);
        return pageText;
      });
    cache.pending.set(pageIndex, pending);
  }
  return pending;
}

type IdleTime = Pick<IdleDeadline, "timeRemaining">;

// Pages are read back to back for as long as an idle period lasts, which is up to 50ms with the page at rest and next to nothing while it scrolls or draws.
function whenIdle() {
  return new Promise<IdleTime>((resolve) => {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(resolve, { timeout: FIND_IDLE_TIMEOUT_MS });
    } else {
      window.setTimeout(() => resolve(sliceFromNow()), 0);
    }
  });
}

function sliceFromNow(): IdleTime {
  const end = performance.now() + FIND_SLICE_MS;
  return { timeRemaining: () => Math.max(0, end - performance.now()) };
}
