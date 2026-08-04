import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import {
  detectReadOnlyReason,
  pdfLooksPdfA
} from '../src/workspace/pdfProtection';
import {
  addBlankPageAt,
  loadEditablePdf,
  mergePdfAfterPage,
  rotatePageClockwise
} from '../src/workspace/pdfPageOperations';
import { writePdfAnnotations } from '../src/workspace/pdfWriter';
import type { PdfAnnotation } from '../src/workspace/types';
import { loadTestPdf, readFixture } from './pdfTestUtils';

// This app never tries to preserve PDF/A conformance while editing (it
// doesn't validate embedded fonts, colour spaces or transparency), so
// anything it writes must stop claiming it. These guard the whole class of
// "the saved copy still says PDF/A", including the round trip that matters
// most in practice: reopening our own output must not flag it read-only.

const note: PdfAnnotation = {
  color: [1, 0.996, 0.306],
  id: 'test-pdfa-note',
  kind: 'stickyNote',
  pageIndex: 0,
  rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
  text: 'note on a PDF/A document'
};

const pdfaXmpPacket = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const unrelatedXmpPacket = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:rights>Example font licence text</dc:rights>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

test('an annotated copy of a PDF/A document stops claiming PDF/A', async () => {
  const bytes = await readFixture('test-pdfa.pdf');
  assert.equal(await pdfLooksPdfA(bytes), true, 'fixture should be PDF/A');

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0]
  });

  assert.equal(await pdfLooksPdfA(output), false);
});

test('structural edits of a PDF/A document stop claiming PDF/A', async () => {
  const bytes = await readFixture('test-pdfa.pdf');
  const plain = await readFixture('test-annotated.pdf');

  const outputs = [
    await rotatePageClockwise(bytes, 0),
    await addBlankPageAt(bytes, 1, 0),
    (await mergePdfAfterPage(bytes, plain, 0)).bytes
  ];

  for (const output of outputs) {
    assert.equal(await pdfLooksPdfA(output), false);
  }
});

test('reopening a saved copy of a PDF/A document does not force read-only', async () => {
  const bytes = await readFixture('test-pdfa.pdf');
  assert.equal(await detectReadOnlyReason(bytes, null, false), 'PDF/A compliant');

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0]
  });

  assert.equal(await detectReadOnlyReason(output, null, false), null);
});

// The regression this file was added for: stripping only the catalog's
// /Metadata left a PDF/A identification behind on any other object that
// carries XMP, so the saved copy still advertised conformance.
test('a PDF/A claim in XMP outside the catalog is stripped too', async () => {
  const bytes = await attachMetadataStream(
    await readFixture('test-pdfa.pdf'),
    pdfaXmpPacket,
    'page'
  );
  assert.equal(await pdfLooksPdfA(bytes), true);

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await pdfLooksPdfA(output), false);
});

test('a PDF/A claim in a compressed XMP packet is stripped', async () => {
  const bytes = await attachMetadataStream(
    await readFixture('test-pdfa.pdf'),
    pdfaXmpPacket,
    'page',
    { compress: true }
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await pdfLooksPdfA(output), false);
});

// The strip is targeted, not a blanket "delete all XMP": re-serialising a
// document doesn't invalidate metadata that isn't a conformance claim.
test('XMP without a PDF/A claim survives an edit', async () => {
  const bytes = await attachMetadataStream(
    await readFixture('test-annotated.pdf'),
    unrelatedXmpPacket,
    'page'
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.ok(
    Buffer.from(output).toString('latin1').includes('Example font licence text'),
    'unrelated XMP should be preserved'
  );
});

// The catalog's own XMP used to be deleted unconditionally, which quietly
// destroyed dc:title/dc:creator/rights on every save of an ordinary document
// that never claimed PDF/A in the first place. Only the conformance claim is
// invalidated by re-serialising, so only that is stripped.
test('catalog XMP without a PDF/A claim survives an edit', async () => {
  const bytes = await attachMetadataStream(
    await readFixture('test-annotated.pdf'),
    unrelatedXmpPacket,
    'catalog'
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.ok(
    Buffer.from(output).toString('latin1').includes('Example font licence text'),
    'unrelated catalog XMP should be preserved'
  );
});

// Checked structurally rather than through pdfLooksPdfA: an output intent is
// a plain dict, which pdf-lib packs into a compressed object stream, so a raw
// byte scan can't see the marker either before or after.
test('a GTS_PDFA output intent outside the catalog is stripped', async () => {
  const bytes = await attachPageOutputIntent(
    await readFixture('test-annotated.pdf')
  );
  assert.equal(await pageOutputIntentSubtypes(bytes), 1, 'fixture precondition');

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await pageOutputIntentSubtypes(output), 0);
});

async function pageOutputIntentSubtypes(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  let count = 0;

  for (const page of pdfDoc.getPages()) {
    const intents = page.node.lookupMaybe(
      PDFName.of('OutputIntents'),
      PDFArray
    );
    for (let index = 0; index < (intents?.size() ?? 0); index += 1) {
      const subtype = intents
        ?.lookupMaybe(index, PDFDict)
        ?.lookupMaybe(PDFName.of('S'), PDFName)
        ?.asString();
      if (subtype?.startsWith('/GTS_PDFA')) {
        count += 1;
      }
    }
  }

  return count;
}

async function attachMetadataStream(
  bytes: Uint8Array,
  packet: string,
  target: 'page' | 'catalog',
  { compress = false }: { compress?: boolean } = {}
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const { context } = pdfDoc;
  const packetBytes = new TextEncoder().encode(packet);
  const ref = compress
    ? context.register(
        context.flateStream(packetBytes, {
          Type: 'Metadata',
          Subtype: 'XML'
        })
      )
    : context.register(
        PDFRawStream.of(
          context.obj({
            Type: 'Metadata',
            Subtype: 'XML',
            Length: packetBytes.length
          }) as PDFDict,
          packetBytes
        )
      );

  const owner =
    target === 'page' ? pdfDoc.getPage(0).node : (pdfDoc.catalog as PDFDict);
  owner.set(PDFName.of('Metadata'), ref);
  return savedBytes(pdfDoc);
}

async function attachPageOutputIntent(bytes: Uint8Array) {
  const pdfDoc = await loadEditablePdf(bytes);
  const { context } = pdfDoc;
  const intentRef = context.register(
    context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB'
    })
  );
  pdfDoc
    .getPage(0)
    .node.set(PDFName.of('OutputIntents'), context.obj([intentRef]));
  return savedBytes(pdfDoc);
}

function savedBytes(pdfDoc: Awaited<ReturnType<typeof loadEditablePdf>>) {
  // Deliberately pdf-lib's own save, not saveEditedPdf - these fixtures are
  // built to still carry the claim the code under test is meant to remove.
  return pdfDoc.save({ objectsPerTick: 500, updateFieldAppearances: false });
}

test('the PDF/A fixture stays loadable after stripping', async () => {
  const bytes = await readFixture('test-pdfa.pdf');
  const before = await loadTestPdf(bytes);
  const output = await rotatePageClockwise(bytes, 0);
  const after = await loadTestPdf(output);

  assert.equal(after.getPageCount(), before.getPageCount());
  assert.ok(!(after.catalog.get(PDFName.of('Metadata')) instanceof PDFRef));
});
