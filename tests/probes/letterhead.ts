// The probes for a form XObject more than one page can reach: a letterhead in
// every page's own /Resources, and one an inherited /Resources holds two Do
// levels down.
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import { markedContent } from "./parts";

// Every page can reach the one form XObject, so reachability says nothing and
// which pages draw it - in the content streams - is the answer.
export const LETTERHEAD_ENTRIES = [
  "LETTERHEAD-ACTUAL",
  "LETTERHEAD-ALT",
  "LETTERHEAD-CLASS-SUMMARY",
  "LETTERHEAD-INNER-ALT",
  "LETTERHEAD-INNER-TITLE",
  "LETTERHEAD-OUTER-ALT",
  "LETTERHEAD-OUTER-TITLE",
  "LETTERHEAD-TITLE",
];

export type LetterheadDrawing =
  "every page" | "only the page that goes" | "only the pages that stay";

export async function letterheadProbePdf(
  drawnBy: LetterheadDrawing,
  namesItsPage = true,
  unreadableContent = false,
) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const pages = [
    doc.addPage([612, 792]),
    doc.addPage([612, 792]),
    doc.addPage([612, 792]),
  ];
  const element = (extra: Record<string, unknown>) =>
    context.register(context.obj({ S: "P", Type: "StructElem", ...extra }));
  const font = context.register(
    context.obj({ BaseFont: "Helvetica", Subtype: "Type1", Type: "Font" }),
  );
  const letterhead = context.register(
    context.flateStream(markedContent(["LETTERHEAD-DRAWN-CONTENT"]), {
      BBox: [0, 0, 612, 120],
      Resources: context.obj({ Font: context.obj({ F1: font }) }),
      StructParents: 7,
      Subtype: "Form",
      Type: "XObject",
    }),
  );

  const figure = element({
    ActualText: PDFString.of("LETTERHEAD-ACTUAL"),
    Alt: PDFString.of("LETTERHEAD-ALT"),
    C: "Cls-letterhead",
    K: [0],
    S: "Figure",
    T: PDFString.of("LETTERHEAD-TITLE"),
    ...(namesItsPage ? { Pg: pages[1].ref } : {}),
  });
  const innerSect = element({
    Alt: PDFString.of("LETTERHEAD-INNER-ALT"),
    K: [figure],
    S: "Sect",
    T: PDFString.of("LETTERHEAD-INNER-TITLE"),
  });
  const bodyOnAKeptPage = element({
    Alt: PDFString.of("KEEP-letterhead-body-alt"),
    K: [0],
    Pg: pages[0].ref,
  });
  const outerSect = element({
    Alt: PDFString.of("LETTERHEAD-OUTER-ALT"),
    K: [innerSect, bodyOnAKeptPage],
    S: "Sect",
    T: PDFString.of("LETTERHEAD-OUTER-TITLE"),
  });

  pages.forEach((page, index) => {
    const goes = index === 1;
    const draws =
      drawnBy === "every page" ||
      (drawnBy === "only the page that goes") === goes;
    // Its own `/Resources` dictionary: what is shared is the XObject, which is what
    // makes this different from the shared-dictionary case.
    page.node.set(
      PDFName.of("Resources"),
      context.register(
        context.obj({
          Font: context.obj({ F1: font }),
          XObject: context.obj({ Fm0: letterhead }),
        }),
      ),
    );
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
    const drawn = draws ? "\nq 1 0 0 1 0 672 cm /Fm0 Do Q" : "";
    page.node.set(
      PDFName.of("Contents"),
      context.register(
        unreadableContent && draws
          ? // A stream that says it is deflated and is not: the scan cannot
            // read it, so it cannot say what this page draws.
            PDFRawStream.of(
              context.obj({ Filter: "FlateDecode", Length: 5 }),
              new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
            )
          : context.flateStream(
              `${markedContent([`PAGE-${index}-CONTENT`])}${drawn}`,
            ),
      ),
    );
  });

  const structRoot = context.register(
    context.obj({
      ClassMap: context.obj({
        "Cls-letterhead": context.obj({
          O: "Table",
          Summary: PDFString.of("LETTERHEAD-CLASS-SUMMARY"),
        }),
      }),
      K: [outerSect],
      ParentTree: context.register(
        context.obj({
          Nums: [
            0,
            context.obj([bodyOnAKeptPage]),
            1,
            context.obj([]),
            2,
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
  for (const [child, parent] of [
    [outerSect, structRoot],
    [innerSect, outerSect],
    [bodyOnAKeptPage, outerSect],
    [figure, innerSect],
  ] as const) {
    context.lookup(child, PDFDict).set(PDFName.of("P"), parent);
  }
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));

  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}

// A page inherits `/Resources` from its ancestor node, so no page's own
// reference closure reaches an XObject held there. The probe puts the key one
// level further down as well, so nothing is answered unless the walk both climbs
// `/Parent` for the resources and follows the `Do` inside a form XObject.
export const INHERITED_RESOURCE_ENTRIES = ["alt", "actualtext", "title"];

export async function inheritedResourcesProbePdf(
  drawnBy: "the page that goes" | "the page that stays",
  otherPageReachesIt = false,
) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const drawing = drawnBy === "the page that goes" ? gone : kept;
  const said = drawnBy === "the page that goes" ? "SECRET" : "KEEP";
  const font = context.register(
    context.obj({ BaseFont: "Helvetica", Subtype: "Type1", Type: "Font" }),
  );

  const inner = context.register(
    context.flateStream(markedContent(["inner-xobject-mcid-0"]), {
      BBox: [0, 0, 612, 120],
      Resources: context.obj({ Font: context.obj({ F1: font }) }),
      StructParents: 7,
      Subtype: "Form",
      Type: "XObject",
    }),
  );
  const outer = context.register(
    context.flateStream("q 1 0 0 1 0 0 cm /Fm1 Do Q", {
      BBox: [0, 0, 612, 120],
      Resources: context.obj({ XObject: context.obj({ Fm1: inner }) }),
      Subtype: "Form",
      Type: "XObject",
    }),
  );

  const pagesNode = doc.catalog.lookup(PDFName.of("Pages"), PDFDict);
  pagesNode.set(
    PDFName.of("Resources"),
    context.register(
      context.obj({
        Font: context.obj({ F1: font }),
        XObject: context.obj({ Fm0: outer }),
      }),
    ),
  );
  for (const [index, page] of [gone, kept].entries()) {
    page.node.delete(PDFName.of("Resources"));
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
    page.node.set(
      PDFName.of("Contents"),
      context.register(
        context.flateStream(
          `${markedContent([`${index === 0 ? "SECRET" : "KEEP"}-inherited-page-${index}`])}${
            page === drawing ? "\nq 1 0 0 1 0 600 cm /Fm0 Do Q" : ""
          }`,
        ),
      ),
    );
  }
  if (otherPageReachesIt) {
    // The page that does not draw it can still reach it: its own `/Resources` names
    // the same inner XObject, and reaching is not drawing.
    const other = drawing === gone ? kept : gone;
    other.node.set(
      PDFName.of("Resources"),
      context.register(
        context.obj({
          Font: context.obj({ F1: font }),
          XObject: context.obj({ Fm1: inner }),
        }),
      ),
    );
  }

  const figure = context.register(
    context.obj({
      ActualText: PDFString.of(`${said}-inherited-actualtext`),
      Alt: PDFString.of(`${said}-inherited-alt`),
      K: [0],
      Pg: gone.ref,
      S: "Figure",
      T: PDFString.of(`${said}-inherited-title`),
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
