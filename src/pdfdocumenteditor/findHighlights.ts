import type { PageFindMatches } from "./documentFind";

/* Matches are coloured with the CSS Custom Highlight API, which paints ranges of the text layer without changing its DOM: pdf.js's own find wraps matches in spans, under the selection and text-highlight code that reads that DOM. Where the API is missing, find still scrolls to each match, just without the colour. The rules are in styles.css. */

const MATCH_HIGHLIGHT = "pdfdocumenteditor-find-match";
const CURRENT_HIGHLIGHT = "pdfdocumenteditor-find-current";

let registered: { current: Highlight; match: Highlight } | null | undefined;

function findHighlights() {
  if (registered === undefined) {
    registered = null;
    if (
      typeof Highlight === "function" &&
      typeof CSS !== "undefined" &&
      "highlights" in CSS
    ) {
      const match = new Highlight();
      const current = new Highlight();
      // Over the other matches' colour where the two would meet.
      current.priority = 1;
      CSS.highlights.set(MATCH_HIGHLIGHT, match);
      CSS.highlights.set(CURRENT_HIGHLIGHT, current);
      registered = { current, match };
    }
  }

  return registered;
}

/** Colours one page's matches in its text layer, and returns what takes them off again. */
export function showFindHighlights(
  textLayer: HTMLElement | null,
  matches: PageFindMatches | null,
  currentMatch: number | null,
) {
  const highlights = findHighlights();
  if (!highlights || !textLayer || !matches || matches.length === 0) {
    return () => undefined;
  }

  // The text layer draws each text item's string as one text node, in order, so an offset into the items' strings end to end is an offset into these.
  const nodes: Text[] = [];
  const starts: number[] = [];
  let length = 0;
  for (const span of textLayer.querySelectorAll('span[role="presentation"]')) {
    const node = span.firstChild;
    if (node instanceof Text) {
      nodes.push(node);
      starts.push(length);
      length += node.length;
    }
  }

  const shown: Array<[Highlight, StaticRange]> = [];
  for (let index = 0; index * 2 < matches.length; index += 1) {
    const range = textRange(
      nodes,
      starts,
      matches[index * 2],
      matches[index * 2 + 1],
    );
    if (range) {
      const highlight =
        index === currentMatch ? highlights.current : highlights.match;
      highlight.add(range);
      shown.push([highlight, range]);
    }
  }

  return () => {
    for (const [highlight, range] of shown) {
      highlight.delete(range);
    }
  };
}

function textRange(
  nodes: Text[],
  starts: number[],
  start: number,
  end: number,
) {
  const first = nodeAt(starts, start);
  const last = nodeAt(starts, end - 1);
  // Past the text layer's end: pdf.js stops drawing a page's text after so many items.
  if (first < 0 || last < 0 || end - starts[last] > nodes[last].length) {
    return null;
  }

  return new StaticRange({
    endContainer: nodes[last],
    endOffset: end - starts[last],
    startContainer: nodes[first],
    startOffset: start - starts[first],
  });
}

function nodeAt(starts: number[], offset: number) {
  let low = 0;
  let high = starts.length - 1;
  if (high < 0 || offset < 0) {
    return -1;
  }

  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}
