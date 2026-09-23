// The probes for the words a tagged PDF puts on its pages: every carrier the
// specification allows, a /ClassMap, and a description written as its own object.
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";

// Built from ISO 32000-1 Table 323 and 32000-2's structure additions, over the
// mechanisms as well as the keys, so the probe is over the specification rather
// than over the fix.
export async function taggedProbePdf(useObjectStreams: boolean) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const element = (extra: Record<string, unknown>) =>
    context.register(context.obj({ S: "P", Type: "StructElem", ...extra }));

  const attachment = context.register(
    context.obj({
      Desc: PDFString.of("SECRET-attached-file-description"),
      EF: context.obj({
        F: context.register(context.flateStream("SECRET-attached-file-bytes")),
      }),
      F: PDFString.of("SECRET-attached-file-name.txt"),
      Type: "Filespec",
      UF: PDFHexString.fromText("SECRET-attached-file-unicode-name.txt"),
    }),
  );

  // Every shape 14.7.5 allows, one element each: `attributeObject` and
  // `attributeStream` are what an attribute object may be, `/A` and `/C` the two
  // ways it may be attached.
  const attributeObject = (marker: string) =>
    context.obj({ O: "Table", Summary: PDFString.of(marker) });
  const attributeStream = (marker: string) =>
    context.register(
      context.flateStream(`${marker}-stream-bytes`, {
        O: "Table",
        Summary: PDFString.of(marker),
      }),
    );

  const onKept = element({
    Alt: PDFString.of("KEEP-alt-of-the-kept-page"),
    // One class only this element names and one it shares with an element on the
    // page that leaves; both must survive.
    C: context.register(
      context.obj([
        PDFName.of("KEEP-class-name"),
        context.register(PDFName.of("KEEP-shared-class-name")),
      ]),
    ),
    K: [0],
    Lang: PDFString.of("KEEP-lang-of-the-kept-page"),
    Pg: kept.ref,
  });
  const viaAttributeDictionary = element({
    A: attributeObject("SECRET-a-single-dictionary"),
    Pg: gone.ref,
  });
  const viaAttributeStream = element({
    A: attributeStream("SECRET-a-single-stream"),
    Pg: gone.ref,
  });
  const viaAttributeRevisions = element({
    A: [
      attributeObject("SECRET-a-array-with-revisions-first"),
      PDFNumber.of(0),
      attributeStream("SECRET-a-array-with-revisions-second"),
      PDFNumber.of(1),
    ],
    Pg: gone.ref,
  });
  const viaClassName = element({ C: "SECRET-class-name", Pg: gone.ref });
  const viaClassArray = element({
    C: ["SECRET-class-array-first", "SECRET-class-array-second"],
    Pg: gone.ref,
  });
  const viaClassRevisions = element({
    C: ["SECRET-class-with-revision", PDFNumber.of(0)],
    Pg: gone.ref,
  });
  const viaSharedClass = element({
    C: "KEEP-shared-class-name",
    Pg: gone.ref,
  });
  const unplaced = element({
    Alt: PDFString.of("KEEP-alt-of-an-element-no-page-places"),
  });
  const referenced = element({ Pg: gone.ref });
  const onGone = element({
    A: [
      context.register(
        context.obj({
          O: "UserProperties",
          P: [
            context.obj({
              N: PDFString.of("SECRET-userproperty-name"),
              V: PDFString.of("SECRET-userproperty-value"),
            }),
          ],
        }),
      ),
      context.obj({
        O: "Layout",
        Placement: "Block",
        TBorderStyle: PDFString.of("SECRET-inline-attribute"),
      }),
    ],
    ActualText: PDFString.of("SECRET-actual-text"),
    AF: [attachment],
    Alt: PDFString.of("SECRET-alt"),
    C: "SECRET-class-name",
    E: PDFString.of("SECRET-expansion"),
    ID: context.register(PDFString.of("SECRET-element-id")),
    K: [0],
    Lang: PDFString.of("SECRET-lang"),
    // A namespace the tree root does not declare; `declaredNamespace` below is the
    // same shape with the root's `/Namespaces` naming it.
    NS: context.register(
      context.obj({
        NS: PDFString.of("SECRET-namespace-uri"),
        Type: "Namespace",
      }),
    ),
    Pg: gone.ref,
    Phoneme: PDFString.of("SECRET-phoneme"),
    PhoneticAlphabet: "SECRET-phonetic-alphabet",
    R: PDFNumber.of(3),
    Ref: [referenced],
    S: "SECRET-custom-role",
    "SECRET-extension-key": PDFString.of("SECRET-extension-value"),
    T: PDFString.of("SECRET-title"),
  });
  // ISO 32000-2 puts text on the tree root as well, declared for the whole
  // document and named by no page. A file specification carries its name four
  // times over - `/F`, `/UF`, `/Desc` and the bytes - so a survivor keeps all four.
  const embedded = (marker: string) =>
    context.register(
      context.obj({
        Desc: PDFString.of(`${marker}-description`),
        EF: context.obj({
          F: context.register(context.flateStream(`${marker}-bytes`)),
        }),
        F: PDFString.of(`${marker}-name.txt`),
        Type: "Filespec",
        UF: PDFHexString.fromText(`${marker}-unicode-name.txt`),
      }),
    );
  const declaredNamespace = context.register(
    context.obj({
      NS: PDFString.of("SECRET-declared-namespace-uri"),
      RoleMapNS: context.obj({
        "SECRET-namespaced-role": "P",
      }),
      Schema: embedded("SECRET-namespace-schema"),
      Type: "Namespace",
    }),
  );
  const inNamespace = element({
    NS: declaredNamespace,
    Pg: gone.ref,
    S: "SECRET-namespaced-role",
  });

  const sect = element({
    Alt: PDFString.of("SECRET-sect-alt-with-no-page-of-its-own"),
    ID: PDFString.of("SECRET-sect-element-id"),
    K: [onGone],
    S: "Sect",
    T: PDFString.of("SECRET-sect-title-with-no-page-of-its-own"),
  });
  const spanning = element({
    Alt: PDFString.of("KEEP-alt-spanning-both-pages"),
    ID: PDFString.of("KEEP-second-element-id"),
    K: [onKept],
    Pg: gone.ref,
    S: "Sect",
  });

  const structRoot = context.register(
    context.obj({
      AF: [embedded("SECRET-tree-root-associated-file")],
      ClassMap: context.obj({
        "KEEP-class-name": context.obj({ O: "Layout", TextAlign: "End" }),
        "KEEP-shared-class-name": attributeObject("KEEP-shared-class-summary"),
        "SECRET-class-array-first": [
          attributeObject("SECRET-class-array-first-summary"),
          attributeObject("SECRET-class-array-first-second-summary"),
        ],
        "SECRET-class-array-second": attributeStream(
          "SECRET-class-array-second-summary",
        ),
        "SECRET-class-name": context.obj({
          O: "Layout",
          TextAlign: "Start",
          TBorderStyle: PDFString.of("SECRET-classmap-attribute"),
        }),
        "SECRET-class-with-revision": attributeObject(
          "SECRET-class-with-revision-summary",
        ),
      }),
      IDTree: context.obj({
        Kids: [
          context.register(
            context.obj({
              Limits: [
                PDFString.of("KEEP-element-id"),
                PDFString.of("KEEP-element-id"),
              ],
              Names: [PDFString.of("KEEP-element-id"), onKept],
            }),
          ),
          // Its greatest key is the identifier that leaves, so a /Limits the strip does
          // not rewrite goes on carrying it, and both are objects of their own.
          context.register(
            context.obj({
              Limits: context.register(
                context.obj([
                  PDFString.of("KEEP-second-element-id"),
                  PDFString.of("SECRET-element-id"),
                ]),
              ),
              Names: [
                PDFString.of("KEEP-second-element-id"),
                spanning,
                context.register(PDFString.of("SECRET-element-id")),
                onGone,
              ],
            }),
          ),
          context.register(
            context.obj({
              Limits: [
                PDFString.of("SECRET-sect-element-id"),
                PDFString.of("SECRET-sect-element-id"),
              ],
              Names: [PDFString.of("SECRET-sect-element-id"), sect],
            }),
          ),
        ],
      }),
      K: [
        sect,
        spanning,
        unplaced,
        referenced,
        inNamespace,
        viaAttributeDictionary,
        viaAttributeStream,
        viaAttributeRevisions,
        viaClassName,
        viaClassArray,
        viaClassRevisions,
        viaSharedClass,
      ],
      Namespaces: [declaredNamespace],
      ParentTree: context.register(
        context.obj({ Nums: [0, context.obj([onKept])] }),
      ),
      ParentTreeNextKey: 1,
      PronunciationLexicon: [embedded("SECRET-pronunciation-lexicon")],
      RoleMap: context.obj({
        "KEEP-kept-role": "P",
        "SECRET-custom-role": "P",
      }),
      Type: "StructTreeRoot",
    }),
  );
  for (const [child, parent] of [
    [sect, structRoot],
    [spanning, structRoot],
    [unplaced, structRoot],
    [referenced, structRoot],
    [inNamespace, structRoot],
    [viaAttributeDictionary, structRoot],
    [viaAttributeStream, structRoot],
    [viaAttributeRevisions, structRoot],
    [viaClassName, structRoot],
    [viaClassArray, structRoot],
    [viaClassRevisions, structRoot],
    [viaSharedClass, structRoot],
    [onGone, sect],
    [onKept, spanning],
  ] as const) {
    context.lookup(child, PDFDict).set(PDFName.of("P"), parent);
  }
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  kept.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
  kept.node.set(
    PDFName.of("Contents"),
    context.register(
      context.flateStream("/P <</MCID 0>> BDC BT (KEEP-page) Tj ET EMC"),
    ),
  );
  gone.node.set(
    PDFName.of("Contents"),
    context.register(context.flateStream("BT (SECRET-page) Tj ET")),
  );

  return doc.save({ updateFieldAppearances: false, useObjectStreams });
}

// Four shapes, each one change from the first, with the same class named in all
// four: `in-tree` keeps it because an element on the page that stays names it,
// while the others leave the walk unable to reach every element.
export async function classMapProbePdf(
  shape: "complete" | "cyclic" | "in-tree" | "parent-tree-only" | "ref-only",
) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const element = (extra: Record<string, unknown>) =>
    context.register(context.obj({ S: "P", Type: "StructElem", ...extra }));

  const namesTheClass = shape !== "complete" && shape !== "cyclic";
  const onKept = element({
    K: [0],
    Pg: kept.ref,
    ...(namesTheClass ? { C: "shared-class" } : {}),
  });
  const onGone = element({
    C: "shared-class",
    K: [0],
    Pg: gone.ref,
    ...(shape === "ref-only" ? { Ref: [onKept] } : {}),
  });
  const children = [onGone];
  if (shape !== "parent-tree-only" && shape !== "ref-only") {
    children.push(onKept);
  }
  if (shape === "cyclic") {
    // Two elements that are each other's child: the walk cannot finish reading them,
    // so it cannot say a class has no user left.
    const first = element({ Pg: gone.ref });
    const second = element({ K: [first], Pg: gone.ref });
    context.lookup(first, PDFDict).set(PDFName.of("K"), context.obj([second]));
    children.push(second);
  }

  const structRoot = context.register(
    context.obj({
      ClassMap: context.obj({
        "shared-class": context.obj({
          O: "Table",
          Summary: PDFString.of("SHARED-class-attribute-text"),
        }),
      }),
      K: children,
      ParentTree: context.register(
        context.obj({
          Nums: [
            0,
            context.obj([onGone]),
            1,
            context.obj(shape === "ref-only" ? [] : [onKept]),
          ],
        }),
      ),
      ParentTreeNextKey: 2,
      Type: "StructTreeRoot",
    }),
  );
  for (const child of [...children, onKept]) {
    context.lookup(child, PDFDict).set(PDFName.of("P"), structRoot);
  }
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  gone.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
  kept.node.set(PDFName.of("StructParents"), PDFNumber.of(1));
  for (const page of [gone, kept]) {
    page.node.set(
      PDFName.of("Contents"),
      context.register(context.flateStream("/P <</MCID 0>> BDC BT ET EMC")),
    );
  }
  return doc.save({ updateFieldAppearances: false });
}

// `/Alt` is allowed to be an object of its own, and taking the entry off the
// element leaves the string object in the context. It cannot simply be deleted
// either, because two elements may share one string.
export async function sharedAltProbePdf(shared: boolean) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const gone = doc.addPage([612, 792]);
  const kept = doc.addPage([612, 792]);
  const goneAlt = context.register(
    PDFString.of("SECRET-alt-written-as-its-own-object"),
  );
  const goneAttribute = context.register(
    context.obj({
      O: "UserProperties",
      P: [
        context.obj({
          N: PDFString.of("SECRET-property-two-levels-down"),
          V: PDFString.of("SECRET-property-value-two-levels-down"),
        }),
      ],
    }),
  );
  const keptAlt = shared
    ? goneAlt
    : context.register(PDFString.of("KEEP-alt-of-its-own"));
  const keptAttribute = shared
    ? goneAttribute
    : context.register(
        context.obj({
          O: "UserProperties",
          P: [
            context.obj({
              N: PDFString.of("KEEP-attribute-of-its-own"),
              V: PDFString.of("KEEP-attribute-of-its-own"),
            }),
          ],
        }),
      );
  doc.catalog.set(
    PDFName.of("StructTreeRoot"),
    context.register(
      context.obj({
        K: [
          context.register(
            context.obj({
              A: goneAttribute,
              Alt: goneAlt,
              Pg: gone.ref,
              S: "P",
              Type: "StructElem",
            }),
          ),
          context.register(
            context.obj({
              A: keptAttribute,
              Alt: keptAlt,
              Pg: kept.ref,
              S: "P",
              Type: "StructElem",
            }),
          ),
        ],
        Type: "StructTreeRoot",
      }),
    ),
  );
  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}
