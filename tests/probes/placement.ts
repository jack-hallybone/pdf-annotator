import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import { markedContent, numberTree } from "./parts";

// `/Pg` is the optional half of placement (Table 323): the placement a reader
// uses is a page's `/StructParents` key into the tree root's `/ParentTree`,
// indexed by `/MCID`, and that key is claimed by whatever object holds it.
const PLACEMENT_KEYS = {
  annotation: 2,
  gonePage: 0,
  keptPage: 1,
  unclaimed: 4,
  xObject: 3,
};

export async function placementProbePdf(
  useObjectStreams: boolean,
  spelling: "kids" | "nums",
  resources: "own" | "shared",
) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const element = (extra: Record<string, unknown>) =>
    context.register(context.obj({ S: "P", Type: "StructElem", ...extra }));

  // No `/Pg` of their own, none inherited: the `/ParentTree` is the only thing
  // that places any of these three.
  const byPageKey = element({
    Alt: PDFString.of("SECRET-placed-by-the-deleted-page-key"),
    K: [0],
  });
  const byAnnotationKey = element({
    Alt: PDFString.of("SECRET-placed-by-an-annotation-key"),
    S: "Figure",
  });
  const byXObjectKey = element({
    Alt: PDFString.of("SECRET-placed-by-a-form-xobject-key"),
    K: [0],
  });
  const byXObjectKeyWithPage = element({
    Alt: PDFString.of("SECRET-placed-by-a-form-xobject-key-with-a-page"),
    K: [1],
    Pg: gone.ref,
  });
  const keptByPageKey = element({
    Alt: PDFString.of("KEEP-placed-by-the-kept-page-key"),
    K: [0],
  });
  const byUnclaimedKey = element({
    Alt: PDFString.of("KEEP-placed-by-a-key-no-object-claims"),
  });

  const mixedGone = element({
    Alt: PDFString.of("SECRET-mixed-leaf-on-the-deleted-page"),
    K: [1],
  });
  const mixedKept = element({
    Alt: PDFString.of("KEEP-mixed-leaf-on-the-kept-page"),
    K: [2],
    Pg: kept.ref,
  });
  const mixedSect = element({
    Alt: PDFString.of("KEEP-mixed-section-spanning-both-pages"),
    K: [mixedGone, mixedKept],
    S: "Sect",
  });

  const contradictedChild = element({
    ActualText: PDFString.of("KEEP-actualtext-the-parent-tree-keeps"),
    Alt: PDFString.of("KEEP-alt-the-parent-tree-places-on-the-kept-page"),
    K: [1],
  });
  const contradictingSect = element({
    Alt: PDFString.of("KEEP-section-whose-child-the-parent-tree-keeps"),
    K: [contradictedChild],
    Pg: gone.ref,
    S: "Sect",
  });
  const mirrored = element({
    Alt: PDFString.of("KEEP-alt-whose-pg-names-the-page-that-stays"),
    K: [2],
    Pg: kept.ref,
  });

  const structRoot = context.register(
    context.obj({
      K: [
        byPageKey,
        byAnnotationKey,
        byXObjectKey,
        byXObjectKeyWithPage,
        byUnclaimedKey,
        keptByPageKey,
        mixedSect,
        contradictingSect,
        mirrored,
      ],
      ParentTree: numberTree(
        context,
        [
          [
            PLACEMENT_KEYS.gonePage,
            context.obj([byPageKey, mixedGone, mirrored]),
          ],
          [
            PLACEMENT_KEYS.keptPage,
            context.obj([keptByPageKey, contradictedChild, mixedKept]),
          ],
          [PLACEMENT_KEYS.annotation, byAnnotationKey],
          [
            PLACEMENT_KEYS.xObject,
            context.register(context.obj([byXObjectKey, byXObjectKeyWithPage])),
          ],
          [PLACEMENT_KEYS.unclaimed, context.obj([byUnclaimedKey])],
        ],
        spelling,
      ),
      ParentTreeNextKey: 5,
      Type: "StructTreeRoot",
    }),
  );
  for (const [child, parent] of [
    [byPageKey, structRoot],
    [byAnnotationKey, structRoot],
    [byXObjectKey, structRoot],
    [byXObjectKeyWithPage, structRoot],
    [byUnclaimedKey, structRoot],
    [keptByPageKey, structRoot],
    [mixedSect, structRoot],
    [contradictingSect, structRoot],
    [mirrored, structRoot],
    [mixedGone, mixedSect],
    [mixedKept, mixedSect],
    [contradictedChild, contradictingSect],
  ] as const) {
    context.lookup(child, PDFDict).set(PDFName.of("P"), parent);
  }
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));

  const font = context.register(
    context.obj({ BaseFont: "Helvetica", Subtype: "Type1", Type: "Font" }),
  );
  const formXObject = context.register(
    context.flateStream(markedContent(["xobject-mcid-0", "xobject-mcid-1"]), {
      BBox: [0, 0, 612, 792],
      Resources: context.obj({ Font: context.obj({ F1: font }) }),
      StructParents: PLACEMENT_KEYS.xObject,
      Subtype: "Form",
      Type: "XObject",
    }),
  );
  gone.node.set(
    PDFName.of("StructParents"),
    PDFNumber.of(PLACEMENT_KEYS.gonePage),
  );
  // pdf-lib's `copyPages` - what merge, insert and extract all use - hands the copy
  // the same `/Resources`, so two pages sharing one dictionary is the ordinary case.
  const goneResources = context.register(
    context.obj({
      Font: context.obj({ F1: font }),
      XObject: context.obj({ Fm0: formXObject }),
    }),
  );
  gone.node.set(PDFName.of("Resources"), goneResources);
  gone.node.set(
    PDFName.of("Annots"),
    context.obj([
      context.register(
        context.obj({
          Rect: [72, 72, 92, 92],
          StructParent: PLACEMENT_KEYS.annotation,
          Subtype: "Square",
          Type: "Annot",
        }),
      ),
    ]),
  );
  gone.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream(
        markedContent(["gone-mcid-0", "gone-mcid-1", "gone-mcid-2"]),
      ),
    ),
  );
  kept.node.set(
    PDFName.of("StructParents"),
    context.register(PDFNumber.of(PLACEMENT_KEYS.keptPage)),
  );
  kept.node.set(
    PDFName.of("Annots"),
    context.obj([
      context.register(
        context.obj({
          Dest: [gone.ref, "Fit"],
          Rect: [72, 72, 92, 92],
          Subtype: "Link",
          Type: "Annot",
        }),
      ),
    ]),
  );
  kept.node.set(
    PDFName.of("Resources"),
    resources === "shared"
      ? goneResources
      : context.register(context.obj({ Font: context.obj({ F1: font }) })),
  );
  kept.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream(
        markedContent(["kept-mcid-0", "kept-mcid-1", "kept-mcid-2"]),
      ),
    ),
  );

  return doc.save({ updateFieldAppearances: false, useObjectStreams });
}
