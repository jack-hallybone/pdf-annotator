import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDict, PDFName } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import {
  detectReadOnlyReason,
  pdfLooksSignedOrCertified
} from '../src/workspace/pdfProtection';
import {
  loadEditablePdf,
  rotatePageClockwise
} from '../src/workspace/pdfPageOperations';
import { loadTestPdf, readFixture } from './pdfTestUtils';

// A pdf-lib resave always breaks a signature's crypto validity, but the
// signature's *appearance stream* is ordinary page content to any renderer
// that doesn't verify signatures (this app included). So an edited copy must
// not keep the field, its widget, or the catalog-level certification entry -
// otherwise it still displays a "signed" stamp backed by nothing.
//
// Asserted structurally rather than through pdfLooksSignedOrCertified: that
// scans raw bytes, and pdf-lib packs these dicts into compressed object
// streams on output, so leftovers are invisible to a byte scan even while
// they still render.

test('a real signed fixture stops being detected as signed after an edit', async () => {
  const bytes = await readFixture('test-signed.pdf');
  assert.equal(pdfLooksSignedOrCertified(bytes), true, 'fixture precondition');
  assert.equal(
    await detectReadOnlyReason(bytes, null, false),
    'signed/certified'
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(pdfLooksSignedOrCertified(output), false);
  assert.equal(await detectReadOnlyReason(output, null, false), null);
});

test('a top-level signature field and its widget are removed', async () => {
  const bytes = await buildSignedPdf({ nested: false });
  assert.equal(await signatureFieldCount(bytes), 1, 'fixture precondition');
  assert.equal(await signatureWidgetsOnPage(bytes), 1, 'fixture precondition');

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await signatureFieldCount(output), 0);
  assert.equal(await signatureWidgetsOnPage(output), 0);
});

// The regression: /Fields is a tree, and only its top level was walked.
test('a signature field nested under a parent field is removed', async () => {
  const bytes = await buildSignedPdf({ nested: true });
  assert.equal(await signatureFieldCount(bytes), 1, 'fixture precondition');

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await signatureFieldCount(output), 0);
  assert.equal(await signatureWidgetsOnPage(output), 0);
  assert.equal(
    await acroFormPresent(output),
    false,
    'an AcroForm holding nothing but the pruned signature should go too'
  );
});

test('a certification signature in the catalog /Perms is removed', async () => {
  const bytes = await buildCertifiedPdf();
  assert.equal(await permsEntries(bytes), 1, 'fixture precondition');

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await permsEntries(output), 0);
});

// The strip is targeted: an ordinary form is not a signature and editing a
// document shouldn't silently discard its fields.
test('non-signature form fields survive an edit', async () => {
  const bytes = await buildTextFieldPdf();

  const output = await rotatePageClockwise(bytes, 0);
  const pdfDoc = await loadTestPdf(output);
  const fields = pdfDoc.catalog
    .lookupMaybe(PDFName.of('AcroForm'), PDFDict)
    ?.lookupMaybe(PDFName.of('Fields'), PDFArray);

  assert.equal(fields?.size(), 1);
  assert.equal(
    fields?.lookupMaybe(0, PDFDict)?.lookupMaybe(PDFName.of('FT'), PDFName)
      ?.asString(),
    '/Tx'
  );
});

async function buildSignedPdf({ nested }: { nested: boolean }) {
  const pdfDoc = await loadEditablePdf(await readFixture('test-annotated.pdf'));
  const { context } = pdfDoc;
  const signature = context.register(
    context.obj({
      Type: 'Sig',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 100, 200, 300]
    })
  );
  const appearance = context.register(
    context.flateStream('q Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 50]
    })
  );
  const signatureField = context.register(
    context.obj({
      FT: 'Sig',
      T: 'Signature1',
      V: signature,
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [50, 50, 150, 100],
      AP: context.obj({ N: appearance })
    })
  );
  const topLevel = nested
    ? context.register(
        context.obj({ T: 'group', Kids: context.obj([signatureField]) })
      )
    : signatureField;

  pdfDoc.catalog.set(
    PDFName.of('AcroForm'),
    context.register(
      context.obj({ Fields: context.obj([topLevel]), SigFlags: 3 })
    )
  );
  pdfDoc
    .getPage(0)
    .node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    ?.push(signatureField);

  return rawSave(pdfDoc);
}

async function buildCertifiedPdf() {
  const pdfDoc = await loadEditablePdf(await readFixture('test-annotated.pdf'));
  const { context } = pdfDoc;
  const signature = context.register(
    context.obj({
      Type: 'Sig',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 100, 200, 300]
    })
  );
  pdfDoc.catalog.set(
    PDFName.of('Perms'),
    context.register(context.obj({ DocMDP: signature }))
  );
  return rawSave(pdfDoc);
}

async function buildTextFieldPdf() {
  const pdfDoc = await loadEditablePdf(await readFixture('test-annotated.pdf'));
  const { context } = pdfDoc;
  const field = context.register(
    context.obj({ FT: 'Tx', T: 'name', V: context.obj('typed') })
  );
  pdfDoc.catalog.set(
    PDFName.of('AcroForm'),
    context.register(context.obj({ Fields: context.obj([field]) }))
  );
  return rawSave(pdfDoc);
}

// pdf-lib's own save, not saveEditedPdf - these fixtures must still carry
// what the code under test is meant to remove.
function rawSave(pdfDoc: PDFDocument) {
  return pdfDoc.save({ objectsPerTick: 500, updateFieldAppearances: false });
}

async function signatureFieldCount(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const fields = pdfDoc.catalog
    .lookupMaybe(PDFName.of('AcroForm'), PDFDict)
    ?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  return countSignatureFields(fields);
}

function countSignatureFields(fields: PDFArray | undefined, depth = 0): number {
  let count = 0;
  for (let index = 0; index < (fields?.size() ?? 0); index += 1) {
    const field = fields?.lookupMaybe(index, PDFDict);
    if (!field || depth > 16) {
      continue;
    }
    if (field.lookupMaybe(PDFName.of('FT'), PDFName)?.asString() === '/Sig') {
      count += 1;
      continue;
    }
    count += countSignatureFields(
      field.lookupMaybe(PDFName.of('Kids'), PDFArray),
      depth + 1
    );
  }
  return count;
}

async function signatureWidgetsOnPage(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  let count = 0;

  for (const page of pdfDoc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const annot = annots?.lookupMaybe(index, PDFDict);
      if (annot?.lookupMaybe(PDFName.of('FT'), PDFName)?.asString() === '/Sig') {
        count += 1;
      }
    }
  }

  return count;
}

async function acroFormPresent(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  return Boolean(pdfDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict));
}

async function permsEntries(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const perms = pdfDoc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  return perms?.keys().length ?? 0;
}
