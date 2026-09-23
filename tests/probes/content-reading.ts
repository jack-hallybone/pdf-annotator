// The probes for the content-stream scan itself: what only looks like a page
// drawing an XObject, the caps the scan is bounded by, and a repeated figure.
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFStream,
  PDFString,
} from "pdf-lib";
import { markedContent } from "./parts";

export const CONTENT_READING_SHAPES = [
  {
    keptContent: "BT /F1 12 Tf 72 700 Td (/Fm0 Do) Tj ET",
    name: "a text string",
  },
  { keptContent: "% /Fm0 Do\n", name: "a comment" },
  {
    keptContent: "q BI /W 7 /H 1 /BPC 8 /CS /G ID /Fm0 Do EI Q",
    name: "an inline image's data",
  },
  {
    // The walk does not type-check, so neither does this: `Do` takes the name
    // immediately before it, and an operator in between has consumed it.
    keptContent: "q /Fm0 gs Q Do",
    name: "a name another operator already took",
  },
  { drawnByTheKeptPage: true, keptContent: "", name: "an actual Do" },
] as const;

export async function contentReadingProbePdf(
  keptContent: string,
  drawnByTheKeptPage: boolean,
  selfDrawing = false,
) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const font = context.register(
    context.obj({ BaseFont: "Helvetica", Subtype: "Type1", Type: "Font" }),
  );
  const shared = context.register(
    context.flateStream(
      // A form XObject that draws itself: the walk has to stop, and still read the
      // marked content it holds.
      `${markedContent(["shared-xobject-mcid-0"])}${selfDrawing ? "\nq /Fm0 Do Q" : ""}`,
      {
        BBox: [0, 0, 612, 120],
        StructParents: 7,
        Subtype: "Form",
        Type: "XObject",
      },
    ),
  );
  const resources = context.register(
    context.obj({
      Font: context.obj({ F1: font }),
      XObject: context.obj({ Fm0: shared }),
    }),
  );
  context
    .lookup(shared, PDFStream)
    ?.dict.set(PDFName.of("Resources"), resources);
  for (const [index, page] of [gone, kept].entries()) {
    page.node.set(PDFName.of("Resources"), resources);
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
  }
  gone.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream(
        `${markedContent(["SECRET-content-gone-page"])}\nq /Fm0 Do Q`,
      ),
    ),
  );
  kept.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream(
        `${markedContent(["KEEP-content-kept-page"])}\n${keptContent}${
          drawnByTheKeptPage ? "\nq /Fm0 Do Q" : ""
        }`,
      ),
    ),
  );

  const figure = context.register(
    context.obj({
      Alt: PDFString.of("SECRET-content-alt"),
      K: [0],
      Pg: gone.ref,
      S: "Figure",
      T: PDFString.of("SECRET-content-title"),
      Type: "StructElem",
    }),
  );
  const structRoot = context.register(
    context.obj({
      K: [figure],
      ParentTree: context.register(
        context.obj({
          Nums: [
            0,
            context.obj([]),
            1,
            context.obj([]),
            7,
            context.obj([figure]),
          ],
        }),
      ),
      ParentTreeNextKey: 8,
      Type: "StructTreeRoot",
    }),
  );
  context.lookup(figure, PDFDict).set(PDFName.of("P"), structRoot);
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));

  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}

// The scan is bounded twice: how far one `Do` may nest, and how much may be
// decoded in all. A file that reaches either gets the reachability answer and is
// reported, because that answer may leave a deleted page's description behind.
export async function cappedContentProbePdf(shape: "deep" | "long") {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const form = (contents: string, extra: Record<string, unknown> = {}) =>
    context.register(
      context.flateStream(contents, {
        BBox: [0, 0, 612, 120],
        Subtype: "Form",
        Type: "XObject",
        ...extra,
      }),
    );

  let inner = form(markedContent(["capped-xobject-mcid-0"]), {
    StructParents: 7,
  });
  // Deeper than MAX_CONTENT_SCAN_DEPTH, or wider than the byte budget: 40 MiB of
  // comments, which flate stores in a few kilobytes and the scan has to decode.
  const levels = shape === "deep" ? 24 : 1;
  const padding =
    shape === "long" ? `%${"x".repeat(1024)}\n`.repeat(40 * 1024) : "";
  for (let level = 0; level < levels; level += 1) {
    inner = form(`${padding}q /Fm${level} Do Q`, {
      Resources: context.obj({
        XObject: context.obj({ [`Fm${level}`]: inner }),
      }),
    });
  }

  const resources = context.register(
    context.obj({ XObject: context.obj({ Top: inner }) }),
  );
  for (const [index, page] of [gone, kept].entries()) {
    page.node.set(PDFName.of("Resources"), resources);
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
    page.node.set(
      PDFName.of("Contents"),
      context.register(context.flateStream("q /Top Do Q")),
    );
  }

  const figure = context.register(
    context.obj({
      Alt: PDFString.of("SECRET-capped-alt"),
      K: [0],
      Pg: gone.ref,
      S: "Figure",
      Type: "StructElem",
    }),
  );
  const structRoot = context.register(
    context.obj({
      K: [figure],
      ParentTree: context.register(
        context.obj({
          Nums: [
            0,
            context.obj([]),
            1,
            context.obj([]),
            7,
            context.obj([figure]),
          ],
        }),
      ),
      ParentTreeNextKey: 8,
      Type: "StructTreeRoot",
    }),
  );
  context.lookup(figure, PDFDict).set(PDFName.of("P"), structRoot);
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));

  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}

// The same stream is never read twice. Eleven form XObjects, each drawing the
// next one twice: read once each that is eleven small streams; read once per
// path it is two thousand, which spends the whole byte budget.
export async function repeatedDrawProbePdf() {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const padding = `%${"x".repeat(1023)}\n`.repeat(32);
  const form = (contents: string, extra: Record<string, unknown> = {}) =>
    context.register(
      context.flateStream(contents, {
        BBox: [0, 0, 612, 120],
        Subtype: "Form",
        Type: "XObject",
        ...extra,
      }),
    );

  let level = form(padding);
  for (let depth = 0; depth < 11; depth += 1) {
    level = form(`${padding}q /Fm Do Q q /Fm Do Q`, {
      Resources: context.obj({ XObject: context.obj({ Fm: level }) }),
    });
  }
  // The key nothing draws: only the content could decide it, so a scan that ran
  // out of budget has not decided it.
  const undrawn = form(markedContent(["repeated-undrawn-mcid-0"]), {
    StructParents: 7,
  });

  const resources = context.register(
    context.obj({ XObject: context.obj({ Top: level, Undrawn: undrawn }) }),
  );
  for (const [index, page] of [gone, kept].entries()) {
    page.node.set(PDFName.of("Resources"), resources);
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
    page.node.set(
      PDFName.of("Contents"),
      context.register(context.flateStream("q /Top Do Q")),
    );
  }

  const figure = context.register(
    context.obj({
      Alt: PDFString.of("SECRET-repeated-alt"),
      K: [0],
      Pg: gone.ref,
      S: "Figure",
      Type: "StructElem",
    }),
  );
  const structRoot = context.register(
    context.obj({
      K: [figure],
      ParentTree: context.register(
        context.obj({
          Nums: [
            0,
            context.obj([]),
            1,
            context.obj([]),
            7,
            context.obj([figure]),
          ],
        }),
      ),
      ParentTreeNextKey: 8,
      Type: "StructTreeRoot",
    }),
  );
  context.lookup(figure, PDFDict).set(PDFName.of("P"), structRoot);
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));

  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}
