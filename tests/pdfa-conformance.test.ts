import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import {
  detectReadOnlyReason,
  pdfLooksPdfA,
} from "../src/pdfdocumenteditor/pdfProtection";
import {
  addBlankPageAt,
  loadEditablePdf,
  mergePdfAfterPage,
  rotatePageClockwise,
} from "../src/pdfdocumenteditor/pdfPageOperations";
import { writePdfAnnotations } from "../src/pdfdocumenteditor/pdfWriter";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import { loadTestPdf, readFixture } from "./pdfTestUtils";

// This app never tries to preserve PDF/A conformance while editing, so anything
// it writes must stop claiming it - including the round trip that matters most
// in practice: reopening our own output must not flag it read-only.

const note: PdfAnnotation = {
  color: [1, 0.996, 0.306],
  id: "test-pdfa-note",
  kind: "stickyNote",
  pageIndex: 0,
  rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
  text: "note on a PDF/A document",
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

test("an annotated copy of a PDF/A document stops claiming PDF/A", async () => {
  const bytes = await readFixture("test-pdfa.pdf");
  assert.equal(await pdfLooksPdfA(bytes), true, "fixture should be PDF/A");

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0],
  });

  assert.equal(await pdfLooksPdfA(output), false);
});

test("structural edits of a PDF/A document stop claiming PDF/A", async () => {
  const bytes = await readFixture("test-pdfa.pdf");
  const plain = await readFixture("test-annotated.pdf");

  const outputs = [
    await rotatePageClockwise(bytes, 0),
    await addBlankPageAt(bytes, 1, 0),
    (await mergePdfAfterPage(bytes, plain, 0)).bytes,
  ];

  for (const output of outputs) {
    assert.equal(await pdfLooksPdfA(output), false);
  }
});

test("reopening a saved copy of a PDF/A document does not force read-only", async () => {
  const bytes = await readFixture("test-pdfa.pdf");
  assert.equal(
    await detectReadOnlyReason(bytes, null, false),
    "PDF/A compliant",
  );

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0],
  });

  assert.equal(await detectReadOnlyReason(output, null, false), null);
});

test("a PDF/A claim in XMP outside the catalog is stripped too", async () => {
  const bytes = await attachMetadataStream(
    await readFixture("test-pdfa.pdf"),
    pdfaXmpPacket,
    "page",
  );
  assert.equal(await pdfLooksPdfA(bytes), true);

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await pdfLooksPdfA(output), false);
});

test("a PDF/A claim in a compressed XMP packet is stripped", async () => {
  const bytes = await attachMetadataStream(
    await readFixture("test-pdfa.pdf"),
    pdfaXmpPacket,
    "page",
    { compress: true },
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await pdfLooksPdfA(output), false);
});

// An XMP packet that declares neither /Type /Metadata nor /Subtype /XML is still
// the document's metadata to anything following the catalog's /Metadata key, and
// compressing it hides the marker from the byte scan saveEditedPdf verifies its
// output with.
test("a PDF/A claim in an untyped compressed XMP packet is stripped", async () => {
  const bytes = await attachMetadataStream(
    await readFixture("test-annotated.pdf"),
    pdfaXmpPacket,
    "catalog",
    { compress: true, typed: false },
  );
  assert.equal(
    await pdfLooksPdfA(bytes),
    true,
    "the claim must be detected on input",
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await pdfLooksPdfA(output), false);
  assert.equal(
    inflatedStreamsInclude(output, "pdfaid:part"),
    false,
    "the compressed claim must not survive into the output",
  );
});

test("XMP without a PDF/A claim survives an edit", async () => {
  const bytes = await attachMetadataStream(
    await readFixture("test-annotated.pdf"),
    unrelatedXmpPacket,
    "page",
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.ok(
    Buffer.from(output)
      .toString("latin1")
      .includes("Example font licence text"),
    "unrelated XMP should be preserved",
  );
});

test("catalog XMP without a PDF/A claim survives an edit", async () => {
  const bytes = await attachMetadataStream(
    await readFixture("test-annotated.pdf"),
    unrelatedXmpPacket,
    "catalog",
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.ok(
    Buffer.from(output)
      .toString("latin1")
      .includes("Example font licence text"),
    "unrelated catalog XMP should be preserved",
  );
});

// Checked structurally rather than through pdfLooksPdfA: an output intent is a
// plain dict, which pdf-lib packs into a compressed object stream.
test("a GTS_PDFA output intent outside the catalog is stripped", async () => {
  const bytes = await attachPageOutputIntent(
    await readFixture("test-annotated.pdf"),
  );
  assert.equal(
    await pageOutputIntentSubtypes(bytes),
    1,
    "fixture precondition",
  );

  const output = await rotatePageClockwise(bytes, 0);

  assert.equal(await pageOutputIntentSubtypes(output), 0);
});

async function pageOutputIntentSubtypes(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  let count = 0;

  for (const page of pdfDoc.getPages()) {
    const intents = page.node.lookupMaybe(
      PDFName.of("OutputIntents"),
      PDFArray,
    );
    for (let index = 0; index < (intents?.size() ?? 0); index += 1) {
      const subtype = intents
        ?.lookupMaybe(index, PDFDict)
        ?.lookupMaybe(PDFName.of("S"), PDFName)
        ?.asString();
      if (subtype?.startsWith("/GTS_PDFA")) {
        count += 1;
      }
    }
  }

  return count;
}

function inflatedStreamsInclude(bytes: Uint8Array, marker: string) {
  const buffer = Buffer.from(bytes);
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x78) {
      continue;
    }
    try {
      if (inflateSync(buffer.subarray(index)).includes(marker)) {
        return true;
      }
    } catch {
      // Not the start of a deflate stream; keep scanning.
    }
  }
  return false;
}

async function attachMetadataStream(
  bytes: Uint8Array,
  packet: string,
  target: "page" | "catalog",
  {
    compress = false,
    typed = true,
  }: { compress?: boolean; typed?: boolean } = {},
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const { context } = pdfDoc;
  const packetBytes = new TextEncoder().encode(packet);
  const typeEntries = typed ? { Type: "Metadata", Subtype: "XML" } : {};
  const ref = compress
    ? context.register(context.flateStream(packetBytes, typeEntries))
    : context.register(
        PDFRawStream.of(
          context.obj({
            ...typeEntries,
            Length: packetBytes.length,
          }) as PDFDict,
          packetBytes,
        ),
      );

  const owner =
    target === "page" ? pdfDoc.getPage(0).node : (pdfDoc.catalog as PDFDict);
  owner.set(PDFName.of("Metadata"), ref);
  return savedBytes(pdfDoc);
}

async function attachPageOutputIntent(bytes: Uint8Array) {
  const pdfDoc = await loadEditablePdf(bytes);
  const { context } = pdfDoc;
  const intentRef = context.register(
    context.obj({
      Type: "OutputIntent",
      S: "GTS_PDFA1",
      OutputConditionIdentifier: "sRGB",
    }),
  );
  pdfDoc
    .getPage(0)
    .node.set(PDFName.of("OutputIntents"), context.obj([intentRef]));
  return savedBytes(pdfDoc);
}

function savedBytes(pdfDoc: Awaited<ReturnType<typeof loadEditablePdf>>) {
  // pdf-lib's own save, not saveEditedPdf: these fixtures are built to still carry
  // the claim the code under test is meant to remove.
  return pdfDoc.save({ objectsPerTick: 500, updateFieldAppearances: false });
}

test("the PDF/A fixture stays loadable after stripping", async () => {
  const bytes = await readFixture("test-pdfa.pdf");
  const before = await loadTestPdf(bytes);
  const output = await rotatePageClockwise(bytes, 0);
  const after = await loadTestPdf(output);

  assert.equal(after.getPageCount(), before.getPageCount());
  assert.ok(!(after.catalog.get(PDFName.of("Metadata")) instanceof PDFRef));
});
