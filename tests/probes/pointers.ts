// The probes for what a delete does to the pointers a reader follows: every
// container that can name a page or a form field from outside it, and a button
// whose export values are indexed by its widget list.
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFPage,
} from "pdf-lib";

// One of everything that can name a page or a form field from outside it, so the
// sweep is over a measured set; page 0 is the one that leaves.
export async function pointerProbePdf(useObjectStreams: boolean) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const annot = (page: typeof gone, extra: Record<string, unknown>) =>
    context.register(
      context.obj({
        P: page.ref,
        Rect: [72, 300, 300, 320],
        Type: "Annot",
        ...extra,
      }),
    );

  const merged = annot(gone, {
    FT: "Tx",
    Subtype: "Widget",
    T: PDFString.of("merged"),
    V: PDFString.of("SECRET-merged-value"),
  });
  const holderlessWidget = annot(gone, { Subtype: "Widget" });
  const holderless = context.register(
    context.obj({
      FT: "Tx",
      Kids: [holderlessWidget],
      T: PDFString.of("holderless"),
      V: PDFString.of("SECRET-holderless-value"),
    }),
  );
  context
    .lookup(holderlessWidget, PDFDict)
    .set(PDFName.of("Parent"), holderless);

  const surviving = context.register(
    context.obj({
      FT: "Tx",
      T: PDFString.of("surviving"),
      V: PDFString.of("KEEP-value"),
    }),
  );
  const survivingKids = [
    annot(gone, { Subtype: "Widget" }),
    annot(kept, { Subtype: "Widget" }),
  ];
  context
    .lookup(surviving, PDFDict)
    .set(PDFName.of("Kids"), context.obj(survivingKids));
  for (const kid of survivingKids) {
    context.lookup(kid, PDFDict).set(PDFName.of("Parent"), surviving);
  }

  const radioKids = [
    annot(gone, { Subtype: "Widget" }),
    annot(kept, { Subtype: "Widget" }),
  ];
  const radio = context.register(
    context.obj({
      FT: "Btn",
      Ff: 32768,
      Kids: radioKids,
      Opt: [
        PDFString.of("EXPORT-of-the-deleted-page"),
        PDFString.of("EXPORT-of-the-kept-page"),
      ],
      T: PDFString.of("radio"),
    }),
  );
  for (const kid of radioKids) {
    context.lookup(kid, PDFDict).set(PDFName.of("Parent"), radio);
  }

  const button = annot(kept, {
    A: { Fields: [merged, holderless, surviving], S: "ResetForm" },
    FT: "Btn",
    Subtype: "Widget",
    T: PDFString.of("button"),
  });

  const note = annot(gone, {
    Contents: PDFHexString.fromText("SECRET-note-on-the-deleted-page"),
    Subtype: "Text",
  });
  const popup = annot(gone, { Rect: [0, 0, 10, 10], Subtype: "Popup" });
  const keptNote = annot(kept, {
    Contents: PDFHexString.fromText("KEEP-note"),
    Popup: popup,
    Subtype: "Text",
  });
  context.lookup(popup, PDFDict).set(PDFName.of("Parent"), keptNote);
  const keptReply = annot(kept, {
    Contents: PDFHexString.fromText("KEEP-reply"),
    IRT: note,
    Subtype: "Text",
  });
  const keptLink = annot(kept, { Dest: [gone.ref, "Fit"], Subtype: "Link" });

  gone.node.set(
    PDFName.of("Annots"),
    context.obj([
      merged,
      holderlessWidget,
      survivingKids[0],
      radioKids[0],
      note,
      popup,
    ]),
  );
  kept.node.set(
    PDFName.of("Annots"),
    context.obj([
      survivingKids[1],
      radioKids[1],
      button,
      keptNote,
      keptReply,
      keptLink,
    ]),
  );
  doc.catalog.set(
    PDFName.of("AcroForm"),
    context.obj({
      CO: [merged, holderless, surviving, radio],
      Fields: [merged, holderless, surviving, radio, button],
    }),
  );

  const outlineToGone = context.register(
    context.obj({
      Dest: [gone.ref, "Fit"],
      Title: PDFHexString.fromText("KEEP-outline-to-deleted"),
    }),
  );
  const outlineToKept = context.register(
    context.obj({
      A: { D: [kept.ref, "Fit"], S: "GoTo" },
      Title: PDFHexString.fromText("KEEP-outline-to-kept"),
    }),
  );
  context.lookup(outlineToGone, PDFDict).set(PDFName.of("Next"), outlineToKept);
  context.lookup(outlineToKept, PDFDict).set(PDFName.of("Prev"), outlineToGone);
  doc.catalog.set(
    PDFName.of("Outlines"),
    context.register(
      context.obj({
        Count: 2,
        First: outlineToGone,
        Last: outlineToKept,
        Type: "Outlines",
      }),
    ),
  );
  doc.catalog.set(PDFName.of("OpenAction"), context.obj([gone.ref, "Fit"]));
  doc.catalog.set(
    PDFName.of("Names"),
    context.register(
      context.obj({
        Dests: context.register(
          context.obj({
            Names: [
              PDFString.of("KEEP-dest-on-kept-page"),
              context.obj([kept.ref, PDFName.of("Fit")]),
              PDFString.of("dest-on-deleted-page"),
              context.obj([gone.ref, PDFName.of("Fit")]),
            ],
          }),
        ),
      }),
    ),
  );
  const bead = context.register(
    context.obj({ P: gone.ref, R: [0, 0, 10, 10], Type: "Bead" }),
  );
  const thread = context.register(
    context.obj({
      F: bead,
      I: { Title: PDFString.of("KEEP-thread") },
      Type: "Thread",
    }),
  );
  for (const key of ["N", "T", "V"]) {
    context
      .lookup(bead, PDFDict)
      .set(PDFName.of(key), key === "T" ? thread : bead);
  }
  doc.catalog.set(PDFName.of("Threads"), context.obj([thread]));

  const goneElement = context.register(
    context.obj({
      Alt: PDFString.of("SECRET-alt-on-the-deleted-page"),
      K: [{ Obj: note, Type: "OBJR" }],
      Pg: gone.ref,
      S: "P",
      Type: "StructElem",
    }),
  );
  const keptElement = context.register(
    context.obj({
      Alt: PDFString.of("KEEP-alt-on-the-kept-page"),
      K: [0],
      Pg: kept.ref,
      S: "P",
      Type: "StructElem",
    }),
  );
  const structRoot = context.register(
    context.obj({
      K: [goneElement, keptElement],
      ParentTree: context.register(
        context.obj({ Nums: [0, context.obj([keptElement])] }),
      ),
      ParentTreeNextKey: 1,
      Type: "StructTreeRoot",
    }),
  );
  for (const element of [goneElement, keptElement]) {
    context.lookup(element, PDFDict).set(PDFName.of("P"), structRoot);
  }
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  kept.node.set(PDFName.of("StructParents"), PDFNumber.of(0));

  const ocg = context.register(
    context.obj({ Name: PDFHexString.fromText("KEEP-ocg"), Type: "OCG" }),
  );
  const keptXObject = context.register(
    context.flateStream("(KEEP-xobject) Tj", {
      BBox: [0, 0, 10, 10],
      OC: ocg,
      Subtype: "Form",
      Type: "XObject",
    }),
  );
  doc.catalog.set(
    PDFName.of("OCProperties"),
    context.obj({ D: { ON: [ocg] }, OCGs: [ocg] }),
  );
  kept.node.set(
    PDFName.of("Resources"),
    context.obj({ XObject: { Fm0: keptXObject } }),
  );
  kept.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream("/P <</MCID 0>> BDC BT (KEEP-kept-page) Tj ET EMC"),
    ),
  );
  gone.node.set(
    PDFName.of("Contents"),
    context.register(context.flateStream("BT (SECRET-deleted-page) Tj ET")),
  );

  return doc.save({ updateFieldAppearances: false, useObjectStreams });
}

// A button's `/Opt` is indexed by `/Kids` position, and both shapes here - `/Opt`
// inherited from a parent field, which is spec-legal, and an `/Opt` a different
// size from `/Kids` - once left the surviving widget holding the deleted
// widget's export value.
export async function buttonProbePdf(shape: "inherited" | "size-mismatch") {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const widget = (page: PDFPage, state: string) =>
    context.register(
      context.obj({
        AS: state,
        F: 4,
        P: page.ref,
        Rect: [10, 10, 30, 30],
        Subtype: "Widget",
        Type: "Annot",
      }),
    );
  const onGone = widget(gone, "SECRET-on-state-of-the-deleted-widget");
  const onKept = widget(kept, "KEEP-on-state-of-the-surviving-widget");

  const exports = [
    PDFString.of("SECRET-export-of-the-deleted-widget"),
    PDFString.of("KEEP-export-of-the-surviving-widget"),
  ];
  const radio =
    shape === "inherited"
      ? context.register(
          context.obj({ Kids: [onGone, onKept], T: PDFString.of("radio") }),
        )
      : context.register(
          context.obj({
            FT: "Btn",
            Ff: 32768,
            Kids: [onGone, onKept],
            Opt: [...exports, PDFString.of("KEEP-export-nothing-is-at")],
            T: PDFString.of("radio"),
          }),
        );
  const root =
    shape === "inherited"
      ? context.register(
          context.obj({
            FT: "Btn",
            Ff: 32768,
            Kids: [radio],
            Opt: exports,
            T: PDFString.of("group"),
          }),
        )
      : radio;
  if (shape === "inherited") {
    context.lookup(radio, PDFDict).set(PDFName.of("Parent"), root);
  }
  for (const kid of [onGone, onKept]) {
    context.lookup(kid, PDFDict).set(PDFName.of("Parent"), radio);
  }
  gone.node.set(PDFName.of("Annots"), context.obj([onGone]));
  kept.node.set(PDFName.of("Annots"), context.obj([onKept]));
  doc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(
      context.obj({ DA: PDFString.of("/Helv 0 Tf 0 g"), Fields: [root] }),
    ),
  );
  return doc.save({ updateFieldAppearances: false });
}
