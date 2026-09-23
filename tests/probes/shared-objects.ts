import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import { markedContent } from "./parts";

// Any reference between the two sides does it: one object a page's subtree
// reaches and the other side owns is enough to make that side's structure-parent
// key read as one both claim, so these ten routes are a breadth check rather
// than a taxonomy.
export const SHARED_ROUTES = [
  "aa",
  "bead",
  "hide-t",
  "irt",
  "next",
  "ocmd",
  "pieceinfo",
  "popup",
  "resources",
  "resources-drawn",
] as const;

export type SharedRoute = (typeof SHARED_ROUTES)[number];

export const SHARED_ROUTE_KEY = 7;
const SHARED_ROUTE_ENTRIES = [
  "actualtext",
  "alt",
  "class-summary",
  "inner-alt",
  "inner-title",
  "outer-alt",
  "outer-title",
  "title",
] as const;

export function sharedRouteMarkers(prefix: "KEEP" | "SECRET") {
  return SHARED_ROUTE_ENTRIES.map((entry) => `${prefix}-shared-${entry}`);
}

export const SHARED_ROUTE_SECRETS = sharedRouteMarkers("SECRET");

type SharedDirection = "into the deleted page" | "into the page that stays";

// `direction` decides which page owns the object holding the structure-parent
// key. The placed element always describes the owner's page, so it is `SECRET-`
// when the owner is the page being deleted and `KEEP-` when it is the one that
// stays.
export async function sharedObjectProbePdf(
  route: SharedRoute,
  placedElementNamesTheDeletedPage: boolean,
  direction: SharedDirection = "into the deleted page",
) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const leaking = direction === "into the deleted page";
  const owner = leaking ? gone : kept;
  const referrer = leaking ? kept : gone;
  const said = leaking ? "SECRET" : "KEEP";
  const control = leaking ? "KEEP" : "SECRET";
  const element = (extra: Record<string, unknown>) =>
    context.register(context.obj({ S: "P", Type: "StructElem", ...extra }));

  const figure = element({
    ActualText: PDFString.of(`${said}-shared-actualtext`),
    Alt: PDFString.of(`${said}-shared-alt`),
    C: "Cls-shared",
    K: [0],
    S: "Figure",
    T: PDFString.of(`${said}-shared-title`),
    ...(placedElementNamesTheDeletedPage && leaking ? { Pg: gone.ref } : {}),
  });
  const innerSect = element({
    Alt: PDFString.of(`${said}-shared-inner-alt`),
    K: [figure],
    S: "Sect",
    T: PDFString.of(`${said}-shared-inner-title`),
  });
  const outerSect = element({
    Alt: PDFString.of(`${said}-shared-outer-alt`),
    K: [innerSect],
    S: "Sect",
    T: PDFString.of(`${said}-shared-outer-title`),
    ...(placedElementNamesTheDeletedPage && !leaking ? { Pg: gone.ref } : {}),
  });
  const controlPara = element({
    Alt: PDFString.of(`${control}-shared-other-page-alt`),
    K: [0],
    Pg: referrer.ref,
  });

  const font = context.register(
    context.obj({ BaseFont: "Helvetica", Subtype: "Type1", Type: "Font" }),
  );
  const drawsTheXObject = route === "resources-drawn";
  const sharedResources = route.startsWith("resources");
  const holder = sharedResources
    ? context.register(
        context.flateStream(markedContent(["shared-xobject-mcid-0"]), {
          BBox: [0, 0, 612, 792],
          Resources: context.obj({ Font: context.obj({ F1: font }) }),
          StructParents: SHARED_ROUTE_KEY,
          Subtype: "Form",
          Type: "XObject",
        }),
      )
    : route === "ocmd"
      ? context.register(
          context.obj({
            OCGs: [
              context.register(
                context.obj({ Name: PDFString.of("layer"), Type: "OCG" }),
              ),
            ],
            StructParent: SHARED_ROUTE_KEY,
            Type: "OCMD",
          }),
        )
      : route === "bead"
        ? context.register(
            context.obj({
              R: [0, 0, 10, 10],
              StructParent: SHARED_ROUTE_KEY,
            }),
          )
        : context.register(
            context.obj({
              Contents: PDFString.of(`${said}-shared-note-contents`),
              Rect: [72, 72, 92, 92],
              StructParent: SHARED_ROUTE_KEY,
              Subtype: route === "popup" ? "Popup" : "Text",
              Type: "Annot",
            }),
          );

  const ownerAnnots: PDFObject[] = [];
  const referrerAnnots: PDFObject[] = [];
  const ownerResources = context.register(
    context.obj({
      Font: context.obj({ F1: font }),
      ...(sharedResources ? { XObject: context.obj({ Fm0: holder }) } : {}),
    }),
  );
  owner.node.set(PDFName.of("Resources"), ownerResources);
  referrer.node.set(
    PDFName.of("Resources"),
    sharedResources
      ? ownerResources
      : context.register(context.obj({ Font: context.obj({ F1: font }) })),
  );

  if (route === "bead") {
    owner.node.set(PDFName.of("B"), context.obj([holder]));
    referrer.node.set(
      PDFName.of("B"),
      context.obj([
        context.register(context.obj({ N: holder, R: [0, 0, 10, 10] })),
      ]),
    );
  } else if (!sharedResources) {
    const ownerAction = context.register(context.obj({ S: "Hide", T: holder }));
    ownerAnnots.push(
      route === "ocmd"
        ? context.register(
            context.obj({
              OC: holder,
              Rect: [72, 72, 92, 92],
              Subtype: "Square",
              Type: "Annot",
            }),
          )
        : holder,
    );
    if (route === "next") {
      ownerAnnots.push(
        context.register(
          context.obj({
            A: ownerAction,
            Rect: [10, 10, 20, 20],
            Subtype: "Widget",
            Type: "Annot",
          }),
        ),
      );
    }
    const referrerAnnot = context.obj({
      Rect: [72, 72, 92, 92],
      Subtype: "Text",
      Type: "Annot",
    });
    const reference: Partial<Record<SharedRoute, [string, PDFObject]>> = {
      "hide-t": ["A", context.obj({ S: "Hide", T: holder })],
      irt: ["IRT", holder],
      next: ["A", context.obj({ Next: ownerAction, S: "Hide" })],
      ocmd: ["OC", holder],
      popup: ["Popup", holder],
    };
    const named = reference[route];
    if (named) {
      referrerAnnot.set(PDFName.of(named[0]), named[1]);
    }
    referrerAnnots.push(context.register(referrerAnnot));
    if (route === "aa") {
      referrer.node.set(
        PDFName.of("AA"),
        context.obj({ O: context.obj({ S: "Hide", T: holder }) }),
      );
    }
    if (route === "pieceinfo") {
      referrer.node.set(
        PDFName.of("PieceInfo"),
        context.obj({
          SomeApp: context.obj({
            LastModified: PDFString.of("D:20240101000000Z"),
            Private: context.obj({ Item: holder }),
          }),
        }),
      );
    }
  }
  if (ownerAnnots.length > 0) {
    owner.node.set(PDFName.of("Annots"), context.obj(ownerAnnots));
  }
  if (referrerAnnots.length > 0) {
    referrer.node.set(PDFName.of("Annots"), context.obj(referrerAnnots));
  }

  const structRoot = context.register(
    context.obj({
      ClassMap: context.obj({
        "Cls-shared": context.obj({
          O: "Table",
          Summary: PDFString.of(`${said}-shared-class-summary`),
        }),
      }),
      K: [outerSect, controlPara],
      ParentTree: context.register(
        context.obj({
          Nums: [
            gone === referrer ? 0 : 1,
            context.obj([controlPara]),
            gone === referrer ? 1 : 0,
            context.obj([]),
            SHARED_ROUTE_KEY,
            sharedResources ? context.obj([figure]) : figure,
          ],
        }),
      ),
      ParentTreeNextKey: SHARED_ROUTE_KEY + 1,
      Type: "StructTreeRoot",
    }),
  );
  for (const [child, parent] of [
    [outerSect, structRoot],
    [controlPara, structRoot],
    [innerSect, outerSect],
    [figure, innerSect],
  ] as const) {
    context.lookup(child, PDFDict).set(PDFName.of("P"), parent);
  }
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  gone.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
  kept.node.set(PDFName.of("StructParents"), PDFNumber.of(1));
  const draw = " q 1 0 0 1 0 0 cm /Fm0 Do Q";
  gone.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream(
        `${markedContent(["SECRET-shared-page-content"])}${
          drawsTheXObject && owner === gone ? draw : ""
        }`,
      ),
    ),
  );
  kept.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream(
        `${markedContent(["KEEP-shared-kept-page-content"])}${
          drawsTheXObject && owner === kept ? draw : ""
        }`,
      ),
    ),
  );

  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}
