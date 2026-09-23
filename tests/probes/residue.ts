import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFStream,
  PDFString,
} from "pdf-lib";

// pdf-lib's removePage takes the leaf out of the page tree and leaves everything
// it referenced in the context, and save() writes every indirect object it knows
// about, so this probe page owns one of everything a page can own that could
// carry text a reader wrote.

/** Two pages: page 0 owns the secrets, page 1 owns the controls. */
export async function probePdf(useObjectStreams: boolean) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  const stream = (
    contents: string,
    extra: Parameters<typeof context.flateStream>[1] = {},
  ) => context.register(context.flateStream(contents, extra));

  const page0 = doc.addPage([612, 792]);
  const page1 = doc.addPage([612, 792]);

  const sharedFont = context.register(
    context.obj({
      BaseFont: "Helvetica",
      Name: "SHARED-font",
      Subtype: "Type1",
      Type: "Font",
    }),
  );
  const sharedXObject = stream("(SHARED-xobject) Tj", {
    BBox: [0, 0, 10, 10],
    Subtype: "Form",
    Type: "XObject",
  });

  const appearance = stream("(SECRET-appearance-text) Tj", {
    BBox: [0, 0, 20, 20],
    Subtype: "Form",
    Type: "XObject",
  });
  const popup = context.register(
    context.obj({
      Contents: PDFHexString.fromText("SECRET-popup-contents"),
      Rect: [100, 700, 300, 800],
      Subtype: "Popup",
      Type: "Annot",
    }),
  );
  const note = context.register(
    context.obj({
      AP: { N: appearance },
      Contents: PDFHexString.fromText("SECRET-note-contents"),
      NM: PDFString.of("note-A"),
      P: page0.ref,
      Popup: popup,
      RC: PDFString.of("<body>SECRET-rich-text</body>"),
      Rect: [72, 700, 92, 720],
      Subtype: "Text",
      T: PDFString.of("SECRET-author-name"),
      Type: "Annot",
    }),
  );
  context.lookup(popup, PDFDict).set(PDFName.of("Parent"), note);
  const freeText = context.register(
    context.obj({
      Contents: PDFHexString.fromText("SECRET-freetext-contents"),
      P: page0.ref,
      RC: stream("<body>SECRET-rich-text-stream</body>"),
      Rect: [72, 600, 300, 660],
      Subtype: "FreeText",
      Type: "Annot",
    }),
  );
  const reply = context.register(
    context.obj({
      Contents: PDFHexString.fromText("SECRET-reply-contents"),
      IRT: note,
      P: page0.ref,
      Rect: [72, 500, 92, 520],
      Subtype: "Text",
      Type: "Annot",
    }),
  );
  const attachment = context.register(
    context.obj({
      Contents: PDFHexString.fromText("SECRET-attachment-contents"),
      FS: {
        EF: {
          F: stream("SECRET-embedded-file-bytes", {
            Subtype: "application/octet-stream",
            Type: "EmbeddedFile",
          }),
        },
        F: PDFString.of("SECRET-attachment-name.txt"),
        Type: "Filespec",
      },
      P: page0.ref,
      Rect: [72, 400, 92, 420],
      Subtype: "FileAttachment",
      Type: "Annot",
    }),
  );
  const widget = context.register(
    context.obj({
      FT: "Tx",
      P: page0.ref,
      Rect: [72, 300, 300, 320],
      Subtype: "Widget",
      T: PDFString.of("field-on-page-0"),
      Type: "Annot",
      V: PDFString.of("SECRET-form-field-value"),
    }),
  );
  const link = context.register(
    context.obj({
      A: { S: "URI", URI: PDFString.of("https://example.invalid/SECRET-uri") },
      P: page0.ref,
      Rect: [72, 200, 300, 220],
      Subtype: "Link",
      Type: "Annot",
    }),
  );
  // The other storage spelling: the dictionary written straight into /Annots,
  // which has no object of its own though what it points at does.
  const directNote = {
    AP: {
      N: stream("(SECRET-direct-appearance) Tj", { BBox: [0, 0, 20, 20] }),
    },
    Contents: PDFHexString.fromText("SECRET-direct-note-contents"),
    P: page0.ref,
    Rect: [72, 100, 92, 120],
    Subtype: "Text",
    Type: "Annot",
  };
  page0.node.set(
    PDFName.of("Annots"),
    context.obj([
      note,
      popup,
      freeText,
      reply,
      attachment,
      widget,
      link,
      directNote,
    ]),
  );
  page0.node.set(
    PDFName.of("Contents"),
    stream("BT (SECRET-page-content) Tj ET"),
  );
  const pageXObject = stream("(SECRET-page-xobject) Tj", {
    BBox: [0, 0, 10, 10],
    Subtype: "Form",
    Type: "XObject",
  });
  page0.node.set(
    PDFName.of("Resources"),
    context.obj({
      Font: { F1: sharedFont },
      XObject: { Fm0: pageXObject, Fm1: sharedXObject },
    }),
  );
  page0.node.set(
    PDFName.of("Metadata"),
    stream(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title>SECRET-page-xmp</dc:title></x:xmpmeta>',
      { Subtype: "XML", Type: "Metadata" },
    ),
  );
  page0.node.set(
    PDFName.of("PieceInfo"),
    context.obj({ SomeApp: { Private: PDFString.of("SECRET-pieceinfo") } }),
  );
  page0.node.set(
    PDFName.of("Thumb"),
    stream("SECRET-thumbnail-bytes", {
      BitsPerComponent: 8,
      ColorSpace: "DeviceGray",
      Height: 1,
      Subtype: "Image",
      Type: "XObject",
      Width: 1,
    }),
  );

  const keptNote = context.register(
    context.obj({
      Contents: PDFHexString.fromText("KEEP-note-contents"),
      P: page1.ref,
      Rect: [72, 700, 92, 720],
      Subtype: "Text",
      Type: "Annot",
    }),
  );
  page1.node.set(PDFName.of("Annots"), context.obj([keptNote]));
  page1.node.set(
    PDFName.of("Contents"),
    stream("BT (KEEP-page-content) Tj ET"),
  );
  page1.node.set(
    PDFName.of("Resources"),
    context.obj({ Font: { F1: sharedFont }, XObject: { Fm1: sharedXObject } }),
  );

  // The structures a catalog-wide sweep would have to understand, each naming
  // something on the deleted page as well as something on the kept one.
  const outlineToDeleted = context.register(
    context.obj({
      Dest: [page0.ref, "Fit"],
      Title: PDFHexString.fromText("KEEP-outline-to-deleted-page"),
    }),
  );
  const outlineToKept = context.register(
    context.obj({
      Dest: [page1.ref, "Fit"],
      Title: PDFHexString.fromText("KEEP-outline-to-kept-page"),
    }),
  );
  doc.catalog.set(
    PDFName.of("Outlines"),
    context.register(
      context.obj({
        Count: 2,
        First: outlineToDeleted,
        Last: outlineToKept,
        Type: "Outlines",
      }),
    ),
  );
  doc.catalog.set(
    PDFName.of("Names"),
    context.obj({
      Dests: {
        Names: [
          PDFString.of("dest-on-deleted-page"),
          [page0.ref, "Fit"],
          PDFString.of("KEEP-dest-on-kept-page"),
          [page1.ref, "Fit"],
        ],
      },
    }),
  );
  const ocg = context.register(
    context.obj({
      Name: PDFHexString.fromText("KEEP-optional-content-group"),
      Type: "OCG",
    }),
  );
  context.lookup(pageXObject, PDFStream).dict.set(PDFName.of("OC"), ocg);
  doc.catalog.set(
    PDFName.of("OCProperties"),
    context.obj({ D: { ON: [ocg] }, OCGs: [ocg] }),
  );
  doc.catalog.set(
    PDFName.of("StructTreeRoot"),
    context.obj({
      K: [
        {
          // An /OBJR names the deleted page's annotation from outside it, and the
          // /Alt is a SECRET because it describes the page that leaves.
          Alt: PDFString.of("SECRET-struct-alt-on-deleted-page"),
          K: [{ Obj: note, Type: "OBJR" }],
          Pg: page0.ref,
          S: "P",
          Type: "StructElem",
        },
        {
          Alt: PDFString.of("KEEP-struct-alt-on-kept-page"),
          Pg: page1.ref,
          S: "P",
          Type: "StructElem",
        },
      ],
      Type: "StructTreeRoot",
    }),
  );
  doc.catalog.set(PDFName.of("AcroForm"), context.obj({ Fields: [widget] }));

  return doc.save({ updateFieldAppearances: false, useObjectStreams });
}
