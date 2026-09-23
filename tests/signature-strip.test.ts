import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from "pdf-lib";
import type { PDFDocument, PDFObject } from "pdf-lib";
import {
  detectReadOnlyReason,
  pdfLooksSignedOrCertified,
  pdfLooksStructurallySignedOrCertified,
} from "../src/pdfdocumenteditor/pdfProtection";
import {
  loadEditablePdf,
  removePage,
  rotatePageClockwise,
} from "../src/pdfdocumenteditor/pdfPageOperations";
import { loadTestPdf, readFixture } from "./pdfTestUtils";

// A resave always breaks a signature's crypto, but its appearance stream is
// ordinary page content to a renderer that does not verify signatures, and
// pdf-lib packs these dicts into compressed object streams, where leftovers are
// invisible to a byte scan while still rendering.

// The one test that runs against a genuinely signed document: real /ByteRange
// offsets, a real detached PKCS#7 blob in /Contents, and a signature dictionary
// sitting uncompressed the way a real signer has to leave it.
test("a real signed fixture stops being detected as signed after an edit", async () => {
  const bytes = await readFixture("test-signed.pdf");
  assert.equal(pdfLooksSignedOrCertified(bytes), true, "fixture precondition");
  assert.equal(await signatureFieldCount(bytes), 1, "fixture precondition");
  assert.equal(await signatureWidgetsOnPage(bytes), 1, "fixture precondition");
  assert.equal(
    await detectReadOnlyReason(bytes, null, false),
    "signed/certified",
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(pdfLooksSignedOrCertified(output), false);
  assert.equal(await detectReadOnlyReason(output, null, false), null);
  assert.equal(await signatureFieldCount(output), 0);
  assert.equal(await signatureWidgetsOnPage(output), 0);
  assert.equal(await acroFormPresent(output), false);
});

test("a top-level signature field and its widget are removed", async () => {
  const bytes = await buildSignedPdf({ nested: false });
  assert.equal(await signatureFieldCount(bytes), 1, "fixture precondition");
  assert.equal(await signatureWidgetsOnPage(bytes), 1, "fixture precondition");

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await signatureFieldCount(output), 0);
  assert.equal(await signatureWidgetsOnPage(output), 0);
});

test("a signature field nested under a parent field is removed", async () => {
  const bytes = await buildSignedPdf({ nested: true });
  assert.equal(await signatureFieldCount(bytes), 1, "fixture precondition");

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await signatureFieldCount(output), 0);
  assert.equal(await signatureWidgetsOnPage(output), 0);
  assert.equal(
    await acroFormPresent(output),
    false,
    "an AcroForm holding nothing but the pruned signature should go too",
  );
});

test("a certification signature in the catalog /Perms is removed", async () => {
  const bytes = await buildCertifiedPdf();
  assert.equal(await permsEntries(bytes), 1, "fixture precondition");

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await permsEntries(output), 0);
});

test("non-signature form fields survive an edit", async () => {
  const bytes = await buildTextFieldPdf();

  const output = await rotatePageClockwise(bytes, 0);
  const pdfDoc = await loadTestPdf(output);
  const fields = pdfDoc.catalog
    .lookupMaybe(PDFName.of("AcroForm"), PDFDict)
    ?.lookupMaybe(PDFName.of("Fields"), PDFArray);

  assert.equal(fields?.size(), 1);
  assert.equal(
    fields
      ?.lookupMaybe(0, PDFDict)
      ?.lookupMaybe(PDFName.of("FT"), PDFName)
      ?.asString(),
    "/Tx",
  );
});

test("a string-valued text field cannot prevent a later signature from being removed", async () => {
  const bytes = await buildSignedPdf({ nested: false, withTextField: true });

  const output = await rotatePageClockwise(bytes, 0);
  const pdfDoc = await loadTestPdf(output);
  const fields = pdfDoc.catalog
    .lookupMaybe(PDFName.of("AcroForm"), PDFDict)
    ?.lookupMaybe(PDFName.of("Fields"), PDFArray);

  assert.equal(await signatureFieldCount(output), 0);
  assert.equal(await signatureWidgetsOnPage(output), 0);
  assert.equal(fields?.size(), 1);
  assert.equal(
    fields
      ?.lookupMaybe(0, PDFDict)
      ?.lookupMaybe(PDFName.of("FT"), PDFName)
      ?.asString(),
    "/Tx",
  );
});

test("structural detection finds a signature dictionary hidden in an object stream", async () => {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  pdfDoc.context.register(pdfDoc.context.obj({ Type: "Sig" }));
  const bytes = await rawSave(pdfDoc);

  assert.equal(
    pdfLooksSignedOrCertified(bytes),
    false,
    "fixture must keep the signature marker out of raw bytes",
  );
  assert.equal(await pdfLooksStructurallySignedOrCertified(bytes), true);
});

test("an unreasonably large field tree is treated as protected without an unbounded walk", async () => {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  pdfDoc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(
      context.obj({
        Fields: context.obj(
          Array.from({ length: 10_001 }, (_, index) => index),
        ),
      }),
    ),
  );
  const bytes = await rawSave(pdfDoc);

  assert.equal(pdfLooksSignedOrCertified(bytes), false);
  assert.equal(await pdfLooksStructurallySignedOrCertified(bytes), true);
});

// The operation measured here is rotate, whose page mapping is `keep`, so nothing
// about the page order can be blamed for the shift.
test("stripping a signature widget shifts every /Annots entry behind it", async () => {
  const bytes = await buildSignedPdfWithNotesBehindTheWidget();
  assert.deepEqual(await pageZeroAnnots(bytes), [
    "Widget",
    "Text:NOTE-A",
    "Text:NOTE-B",
  ]);

  const output = await rotatePageClockwise(bytes, 0);

  assert.deepEqual(await pageZeroAnnots(output), [
    "Text:NOTE-A",
    "Text:NOTE-B",
  ]);
});

async function pageZeroAnnots(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const annots = pdfDoc.getPage(0).node.Annots();
  const entries: string[] = [];
  for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
    const dict = annots?.lookupMaybe(index, PDFDict);
    const subtype =
      dict?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ?? "?";
    const contents = dict
      ?.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)
      ?.decodeText();
    entries.push(contents ? `${subtype}:${contents}` : subtype);
  }
  return entries;
}

async function buildSignedPdfWithNotesBehindTheWidget() {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  const page = pdfDoc.getPage(0);
  const signature = context.register(
    context.obj({
      Type: "Sig",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, 100, 200, 300],
    }),
  );
  const signatureField = context.register(
    context.obj({
      FT: "Sig",
      T: "Signature1",
      V: signature,
      Type: "Annot",
      Subtype: "Widget",
      Rect: [50, 50, 150, 100],
    }),
  );
  const notes = ["NOTE-A", "NOTE-B"].map((text, index) =>
    context.obj({
      Contents: PDFHexString.fromText(text),
      P: page.ref,
      Rect: [72, 700 - index * 40, 92, 720 - index * 40],
      Subtype: "Text",
      Type: "Annot",
    }),
  );
  pdfDoc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(
      context.obj({ Fields: context.obj([signatureField]), SigFlags: 3 }),
    ),
  );
  page.node.set(PDFName.of("Annots"), context.obj([signatureField, ...notes]));
  return rawSave(pdfDoc);
}

async function buildSignedPdf({
  nested,
  withTextField = false,
}: {
  nested: boolean;
  withTextField?: boolean;
}) {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  const signature = context.register(
    context.obj({
      Type: "Sig",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, 100, 200, 300],
    }),
  );
  const appearance = context.register(
    context.flateStream("q Q", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 100, 50],
    }),
  );
  const signatureField = context.register(
    context.obj({
      FT: "Sig",
      T: "Signature1",
      V: signature,
      Type: "Annot",
      Subtype: "Widget",
      Rect: [50, 50, 150, 100],
      AP: context.obj({ N: appearance }),
    }),
  );
  const topLevel = nested
    ? context.register(
        context.obj({ T: "group", Kids: context.obj([signatureField]) }),
      )
    : signatureField;
  const textField = withTextField
    ? context.register(
        context.obj({ FT: "Tx", T: "name", V: context.obj("typed") }),
      )
    : null;

  pdfDoc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(
      context.obj({
        // Put the ordinary field last: the sanitizer walks backwards, and a typed lookup
        // of its legal string /V used to throw before reaching the signature.
        Fields: context.obj(textField ? [topLevel, textField] : [topLevel]),
        SigFlags: 3,
      }),
    ),
  );
  pdfDoc
    .getPage(0)
    .node.lookupMaybe(PDFName.of("Annots"), PDFArray)
    ?.push(signatureField);

  return rawSave(pdfDoc);
}

async function buildCertifiedPdf() {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  const signature = context.register(
    context.obj({
      Type: "Sig",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, 100, 200, 300],
    }),
  );
  pdfDoc.catalog.set(
    PDFName.of("Perms"),
    context.register(context.obj({ DocMDP: signature })),
  );
  return rawSave(pdfDoc);
}

async function buildTextFieldPdf() {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  const field = context.register(
    context.obj({ FT: "Tx", T: "name", V: context.obj("typed") }),
  );
  pdfDoc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(context.obj({ Fields: context.obj([field]) })),
  );
  return rawSave(pdfDoc);
}

// pdf-lib's own save, not saveEditedPdf: these fixtures must still carry what
// the code under test is meant to remove.
function rawSave(pdfDoc: PDFDocument) {
  return pdfDoc.save({ objectsPerTick: 500, updateFieldAppearances: false });
}

async function signatureFieldCount(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const fields = pdfDoc.catalog
    .lookupMaybe(PDFName.of("AcroForm"), PDFDict)
    ?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  return countSignatureFields(fields);
}

function countSignatureFields(fields: PDFArray | undefined, depth = 0): number {
  let count = 0;
  for (let index = 0; index < (fields?.size() ?? 0); index += 1) {
    const field = fields?.lookupMaybe(index, PDFDict);
    if (!field || depth > 16) {
      continue;
    }
    if (field.lookupMaybe(PDFName.of("FT"), PDFName)?.asString() === "/Sig") {
      count += 1;
      continue;
    }
    count += countSignatureFields(
      field.lookupMaybe(PDFName.of("Kids"), PDFArray),
      depth + 1,
    );
  }
  return count;
}

async function signatureWidgetsOnPage(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  let count = 0;

  for (const page of pdfDoc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const annot = annots?.lookupMaybe(index, PDFDict);
      if (
        annot?.lookupMaybe(PDFName.of("FT"), PDFName)?.asString() === "/Sig"
      ) {
        count += 1;
      }
    }
  }

  return count;
}

async function acroFormPresent(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  return Boolean(pdfDoc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict));
}

async function permsEntries(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const perms = pdfDoc.catalog.lookupMaybe(PDFName.of("Perms"), PDFDict);
  return perms?.keys().length ?? 0;
}

test("a stripped signature leaves no pointer behind in a list of fields", async () => {
  const bytes = await buildSignedPdfWithFieldLists();
  assert.deepEqual(await fieldListEntries(bytes), {
    calculationOrder: ["signature", "text"],
    resetAction: ["signature", "text"],
  });

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await signatureFieldCount(output), 0);
  assert.deepEqual(await fieldListEntries(output), {
    calculationOrder: ["text"],
    resetAction: ["text"],
  });
});

async function buildSignedPdfWithFieldLists() {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  const page = pdfDoc.getPage(0);
  const signatureField = context.register(
    context.obj({
      FT: "Sig",
      Rect: [50, 50, 150, 100],
      Subtype: "Widget",
      T: PDFString.of("signature"),
      Type: "Annot",
      V: context.register(
        context.obj({
          ByteRange: [0, 100, 200, 300],
          SubFilter: "adbe.pkcs7.detached",
          Type: "Sig",
        }),
      ),
    }),
  );
  const textField = context.register(
    context.obj({
      FT: "Tx",
      Rect: [50, 150, 150, 200],
      Subtype: "Widget",
      T: PDFString.of("text"),
      Type: "Annot",
      V: PDFString.of("kept"),
    }),
  );
  const resetButton = context.register(
    context.obj({
      A: { Fields: [signatureField, textField], S: "ResetForm" },
      FT: "Btn",
      Rect: [50, 250, 150, 300],
      Subtype: "Widget",
      T: PDFString.of("reset"),
      Type: "Annot",
    }),
  );
  pdfDoc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(
      context.obj({
        CO: [signatureField, textField],
        Fields: [signatureField, textField, resetButton],
        SigFlags: 3,
      }),
    ),
  );
  page.node.set(
    PDFName.of("Annots"),
    context.obj([signatureField, textField, resetButton]),
  );
  return rawSave(pdfDoc);
}

async function fieldListEntries(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const acroForm = pdfDoc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  const names = (list: PDFArray | undefined) => {
    const found: string[] = [];
    for (let index = 0; index < (list?.size() ?? 0); index += 1) {
      const field = list?.lookupMaybe(index, PDFDict);
      found.push(
        field?.lookupMaybe(PDFName.of("T"), PDFString)?.decodeText() ?? "?",
      );
    }
    return found;
  };

  const fields = acroForm.lookup(PDFName.of("Fields"), PDFArray);
  let resetAction: string[] = [];
  for (let index = 0; index < fields.size(); index += 1) {
    const action = fields
      .lookupMaybe(index, PDFDict)
      ?.lookupMaybe(PDFName.of("A"), PDFDict);
    if (action) {
      resetAction = names(action.lookupMaybe(PDFName.of("Fields"), PDFArray));
    }
  }
  return {
    calculationOrder: names(acroForm.lookupMaybe(PDFName.of("CO"), PDFArray)),
    resetAction,
  };
}

// Deleting the widget and its `/AP` entry leaves the appearance stream in the
// context, and pdf-lib writes every indirect object it knows about. A sweep of
// the file, not of the structure: the defect is bytes nothing points at.
const SIGNATURE_MARKER = /(?:SECRET|KEEP)-[A-Za-z0-9-]+/g;

async function buildSignedPdfWithAppearance({
  spelling,
  sharedWithSurvivor,
}: {
  spelling: "single-stream" | "state-dictionary";
  sharedWithSurvivor: boolean;
}) {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  const image = context.register(
    context.flateStream("SECRET-signature-image-bytes", {
      BitsPerComponent: 8,
      ColorSpace: "DeviceGray",
      Height: 1,
      Subtype: "Image",
      Type: "XObject",
      Width: 1,
    }),
  );
  const normal = context.register(
    context.flateStream(
      "BT (SECRET-signer-name-in-the-appearance) Tj ET /Im0 Do",
      {
        BBox: [0, 0, 100, 50],
        Resources: context.obj({ XObject: context.obj({ Im0: image }) }),
        Subtype: "Form",
        Type: "XObject",
      },
    ),
  );
  const appearance = () =>
    spelling === "state-dictionary"
      ? context.obj({ N: context.obj({ On: normal }) })
      : context.obj({ N: normal });
  const signature = context.register(
    context.obj({
      ByteRange: [0, 100, 200, 300],
      Contents: PDFHexString.of("00"),
      Location: PDFString.of("SECRET-signing-location"),
      Name: PDFString.of("SECRET-signer-name-in-the-value"),
      Reason: PDFString.of("SECRET-signing-reason"),
      Reference: [
        context.register(
          context.obj({
            TransformMethod: "DocMDP",
            TransformParams: context.register(
              context.obj({
                Note: PDFString.of("SECRET-transform-note"),
                Type: "TransformParams",
                V: "1.2",
              }),
            ),
            Type: "SigRef",
          }),
        ),
      ],
      SubFilter: "adbe.pkcs7.detached",
      Type: "Sig",
    }),
  );
  const signatureField = context.register(
    context.obj({
      AP: appearance(),
      FT: "Sig",
      Rect: [50, 50, 150, 100],
      Subtype: "Widget",
      T: PDFString.of("SECRET-signature-field-name"),
      Type: "Annot",
      V: signature,
    }),
  );
  const survivor = context.register(
    context.obj({
      AP: sharedWithSurvivor
        ? appearance()
        : context.obj({
            N: context.register(
              context.flateStream("BT (KEEP-text-appearance) Tj ET", {
                BBox: [0, 0, 100, 50],
                Subtype: "Form",
                Type: "XObject",
              }),
            ),
          }),
      FT: "Tx",
      Rect: [50, 200, 150, 250],
      Subtype: "Widget",
      T: PDFString.of("KEEP-text-field-name"),
      Type: "Annot",
      V: PDFString.of("KEEP-typed-value"),
    }),
  );
  pdfDoc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(
      context.obj({
        Fields: context.obj([signatureField, survivor]),
        SigFlags: 3,
      }),
    ),
  );
  const annots = pdfDoc
    .getPage(0)
    .node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  annots?.push(signatureField);
  annots?.push(survivor);
  return rawSave(pdfDoc);
}

for (const spelling of ["single-stream", "state-dictionary"] as const) {
  test(`a stripped signature's appearance leaves no bytes behind (/AP as a ${spelling})`, async () => {
    const bytes = await buildSignedPdfWithAppearance({
      sharedWithSurvivor: false,
      spelling,
    });
    assert.deepEqual(
      [...(await signatureMarkers(bytes))]
        .filter((marker) => marker.startsWith("SECRET-"))
        .sort(),
      [
        "SECRET-signature-field-name",
        "SECRET-signature-image-bytes",
        "SECRET-signer-name-in-the-appearance",
        "SECRET-signer-name-in-the-value",
        "SECRET-signing-location",
        "SECRET-signing-reason",
        "SECRET-transform-note",
      ],
      "fixture precondition",
    );

    const output = await rotatePageClockwise(bytes, 0);
    assert.deepEqual(
      [...(await signatureMarkers(output))]
        .filter((marker) => marker.startsWith("SECRET-"))
        .sort(),
      [],
    );
    const kept = [...(await signatureMarkers(output))].sort();
    assert.deepEqual(kept, [
      "KEEP-text-appearance",
      "KEEP-text-field-name",
      "KEEP-typed-value",
    ]);
  });

  test(`an appearance stream a surviving widget shares is not taken (/AP as a ${spelling})`, async () => {
    const output = await rotatePageClockwise(
      await buildSignedPdfWithAppearance({
        sharedWithSurvivor: true,
        spelling,
      }),
      0,
    );
    const markers = await signatureMarkers(output);
    assert.ok(
      markers.has("SECRET-signer-name-in-the-appearance"),
      "the shared appearance stream was taken from the widget that stays",
    );
    assert.equal(await signatureFieldCount(output), 0);
    const pdfDoc = await loadTestPdf(output);
    const annots = pdfDoc
      .getPage(0)
      .node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const shared: string[] = [];
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const widget = annots?.lookupMaybe(index, PDFDict);
      const name = widget
        ?.lookupMaybe(PDFName.of("T"), PDFString)
        ?.decodeText();
      if (
        name?.startsWith("KEEP-") &&
        widget?.lookupMaybe(PDFName.of("AP"), PDFDict)
      ) {
        shared.push(name);
      }
    }
    assert.deepEqual(shared, ["KEEP-text-field-name"]);
  });
}

test("a certification signature's own subtree leaves no bytes behind", async () => {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  pdfDoc.catalog.set(
    PDFName.of("Perms"),
    context.register(
      context.obj({
        DocMDP: context.register(
          context.obj({
            ByteRange: [0, 100, 200, 300],
            Name: PDFString.of("SECRET-certifier-name"),
            Reference: [
              context.register(
                context.obj({
                  TransformParams: context.register(
                    context.obj({
                      Note: PDFString.of("SECRET-certification-note"),
                      Type: "TransformParams",
                    }),
                  ),
                  Type: "SigRef",
                }),
              ),
            ],
            SubFilter: "adbe.pkcs7.detached",
            Type: "Sig",
          }),
        ),
      }),
    ),
  );
  const bytes = await rawSave(pdfDoc);
  assert.ok((await signatureMarkers(bytes)).has("SECRET-certification-note"));

  const output = await rotatePageClockwise(bytes, 0);
  assert.deepEqual(
    [...(await signatureMarkers(output))]
      .filter((marker) => marker.startsWith("SECRET-"))
      .sort(),
    [],
  );
});

test("deleting the page a signature's only widget sits on still saves", async () => {
  const pdfDoc = await loadEditablePdf(await readFixture("test-annotated.pdf"));
  const { context } = pdfDoc;
  const signedPage = pdfDoc.insertPage(0, [612, 792]);
  const signatureField = context.register(
    context.obj({
      AP: context.obj({
        N: context.register(
          context.flateStream("BT (SECRET-appearance) Tj ET", {
            BBox: [0, 0, 100, 50],
            Subtype: "Form",
            Type: "XObject",
          }),
        ),
      }),
      FT: "Sig",
      Rect: [50, 50, 150, 100],
      Subtype: "Widget",
      T: PDFString.of("SECRET-signature-field-name"),
      Type: "Annot",
      V: context.register(
        context.obj({
          ByteRange: [0, 100, 200, 300],
          SubFilter: "adbe.pkcs7.detached",
          Type: "Sig",
        }),
      ),
    }),
  );
  pdfDoc.catalog.set(
    PDFName.of("AcroForm"),
    context.register(
      context.obj({ Fields: context.obj([signatureField]), SigFlags: 3 }),
    ),
  );
  signedPage.node.set(PDFName.of("Annots"), context.obj([signatureField]));
  const bytes = await rawSave(pdfDoc);
  const pageCount = (await loadTestPdf(bytes)).getPageCount();

  const output = (await removePage(bytes, 0)).bytes;

  assert.equal((await loadTestPdf(output)).getPageCount(), pageCount - 1);
  assert.equal(pdfLooksSignedOrCertified(output), false);
  assert.equal(await acroFormPresent(output), true);
  assert.equal(await signatureFieldCount(output), 0);
  assert.deepEqual(
    [...(await signatureMarkers(output))]
      .filter((marker) => marker.startsWith("SECRET-"))
      .sort(),
    [],
  );
});

async function signatureMarkers(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const found = new Set<string>();
  const add = (text: string) => {
    for (const marker of text.match(SIGNATURE_MARKER) ?? []) {
      found.add(marker);
    }
  };
  const walk = (object: PDFObject | undefined, depth = 0) => {
    if (object === undefined || depth > 32 || object instanceof PDFRef) {
      return;
    }
    if (object instanceof PDFString || object instanceof PDFHexString) {
      add(object.decodeText());
      return;
    }
    if (object instanceof PDFName || object instanceof PDFNumber) {
      add(object.toString());
      return;
    }
    if (object instanceof PDFArray) {
      for (const entry of object.asArray()) {
        walk(entry, depth + 1);
      }
      return;
    }
    if (object instanceof PDFStream) {
      walk(object.dict, depth + 1);
      if (object instanceof PDFRawStream) {
        const raw = Buffer.from(object.contents);
        const filter = object.dict.get(PDFName.of("Filter"));
        const flate = PDFName.of("FlateDecode");
        const deflated =
          filter === flate ||
          (filter instanceof PDFArray && filter.asArray().includes(flate));
        try {
          add((deflated ? inflateSync(raw) : raw).toString("latin1"));
        } catch {
          add(raw.toString("latin1"));
        }
      }
      return;
    }
    if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        add(key.toString());
        walk(value, depth + 1);
      }
    }
  };
  for (const [, object] of pdfDoc.context.enumerateIndirectObjects()) {
    walk(object);
  }
  return found;
}
