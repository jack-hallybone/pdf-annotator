/*
 * pdf.js hands the outline tree over already parsed; everything below is about
 * not trusting it.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import { boundedDocumentLine } from "./untrustedText";

export type PdfOutlineEntry = {
  id: string;
  bold: boolean;
  italic: boolean;
  items: PdfOutlineEntry[];
  title: string;
  /** Handed straight back to goToDestination and never rendered. */
  destination: unknown;
};

// A document is free to declare a million entries, or to nest them until a
// recursive render blows the stack.
const MAX_OUTLINE_ENTRIES = 2000;
const MAX_OUTLINE_DEPTH = 12;
const MAX_OUTLINE_TITLE_LENGTH = 300;

type RawOutlineItem = {
  bold?: unknown;
  italic?: unknown;
  items?: unknown;
  title?: unknown;
  dest?: unknown;
};

export async function loadPdfOutline(
  pdfDoc: PDFDocumentProxy,
): Promise<PdfOutlineEntry[]> {
  let raw: unknown;
  try {
    raw = await pdfDoc.getOutline();
  } catch {
    // A broken outline is not a broken document; the pages still render.
    return [];
  }

  return sanitizeOutlineItems(raw, {
    depth: 0,
    path: "o",
    remaining: { count: MAX_OUTLINE_ENTRIES },
  });
}

function sanitizeOutlineItems(
  raw: unknown,
  context: { depth: number; path: string; remaining: { count: number } },
): PdfOutlineEntry[] {
  if (!Array.isArray(raw) || context.depth >= MAX_OUTLINE_DEPTH) {
    return [];
  }

  const entries: PdfOutlineEntry[] = [];
  for (const [index, item] of raw.entries()) {
    if (context.remaining.count <= 0) {
      break;
    }
    if (!item || typeof item !== "object") {
      continue;
    }

    const outlineItem = item as RawOutlineItem;
    const title = boundedDocumentLine(
      outlineItem.title,
      MAX_OUTLINE_TITLE_LENGTH,
    );
    const destination = usableDestination(outlineItem.dest);
    const path = `${context.path}.${index}`;
    context.remaining.count -= 1;
    const items = sanitizeOutlineItems(outlineItem.items, {
      depth: context.depth + 1,
      path,
      remaining: context.remaining,
    });

    // A titleless entry with no children says nothing and goes nowhere.
    if (!title && items.length === 0) {
      continue;
    }

    entries.push({
      id: path,
      bold: outlineItem.bold === true,
      italic: outlineItem.italic === true,
      items,
      // Named so the row is announceable rather than an empty button.
      title: title || "Untitled",
      destination,
    });
  }

  return entries;
}

/**
 * A named destination or an explicit array; anything else is dropped and the
 * entry renders as a plain heading.
 */
function usableDestination(dest: unknown) {
  if (typeof dest === "string") {
    return dest.length > 0 && dest.length <= MAX_OUTLINE_TITLE_LENGTH
      ? dest
      : null;
  }

  return Array.isArray(dest) && dest.length > 0 ? dest : null;
}
