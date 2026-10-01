import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { PDFContext, PDFName, PDFRawStream, type PDFDict } from "pdf-lib";
import { detectReadOnlyReason } from "../src/pdfdocumenteditor/pdfProtection";
import { decodedWithinBudget } from "../src/pdfdocumenteditor/boundedStreamDecode";
import { catalogMetadataBombPdf, objectStreamBombPdf } from "./pdfBombs";

// PDFA-2: pdf-lib inflates a stream to whatever it decodes to, with no cap, on the calling thread. These build streams that inflate to hundreds of megabytes from a few kilobytes on disk and check that the protection scan reads them within a budget instead of to the end. The catalog-/Metadata and nested-filter cases are bounded in-process here; the object-stream case, which pdf-lib inflates inside PDFDocument.load before any project code runs, is covered off the main thread by the parse gate and its e2e (tests-e2e/decompression-bomb.spec.ts).

// A metadata stream too large to decode within the budget cannot be read to the end to look for the claim, so it is treated as a possible claim rather than passed as clean - the same fail-closed choice the signature checks make. On the unbounded original this stream is decoded in full, found to hold no marker, and the file opens editable; the bound is what turns "read it all to be sure" into "too big to be sure, so assume it claims."
const FEW_HUNDRED_MB = 300 * 1024 * 1024;

test("a catalog /Metadata stream that inflates past the budget is treated as a claim, not read to the end", async () => {
  const bytes = await catalogMetadataBombPdf(FEW_HUNDRED_MB, { claim: false });
  assert.equal(
    await detectReadOnlyReason(bytes, null, false),
    "PDF/A compliant",
  );
});

test("a nested [/FlateDecode /FlateDecode] metadata bomb is bounded the same way", async () => {
  const bytes = await catalogMetadataBombPdf(FEW_HUNDRED_MB, {
    claim: false,
    nested: true,
  });
  assert.equal(
    await detectReadOnlyReason(bytes, null, false),
    "PDF/A compliant",
  );
});

// A real, small PDF/A claim must still be detected and still open read-only, so the bound has not broken ordinary PDF/A handling.
test("an ordinary small PDF/A claim is still detected", async () => {
  const doc = await (await import("pdf-lib")).PDFDocument.create();
  doc.addPage([200, 200]);
  const { context } = doc;
  const packet = new TextEncoder().encode(
    '<?xpacket?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part></rdf:Description>' +
      "</rdf:RDF></x:xmpmeta>",
  );
  const dict = context.obj({
    Type: "Metadata",
    Subtype: "XML",
    Length: packet.length,
  }) as PDFDict;
  const ref = context.register(PDFRawStream.of(dict, packet));
  (doc.catalog as PDFDict).set(PDFName.of("Metadata"), ref);
  const bytes = await doc.save({ useObjectStreams: false });
  assert.equal(
    await detectReadOnlyReason(bytes, null, false),
    "PDF/A compliant",
  );
});

// The primitive the bound is built on: a stream is read only as far as the budget, and a stream that overruns is reported as such rather than returned whole.
test("decodedWithinBudget stops a bomb at the budget and reports the overrun", () => {
  const context = PDFContext.create();
  const contents = new Uint8Array(
    deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20)),
  );
  const dict = context.obj({
    Filter: PDFName.of("FlateDecode"),
    Length: contents.length,
  }) as PDFDict;
  const bomb = PDFRawStream.of(dict, contents);

  const capped = decodedWithinBudget(bomb, 1024 * 1024);
  assert.equal(capped.ok, false);
  assert.equal(capped.ok === false && capped.overBudget, true);
});

test("decodedWithinBudget returns the whole of a stream that fits", () => {
  const context = PDFContext.create();
  const payload = Buffer.from("a metadata packet that is well within budget");
  const contents = new Uint8Array(deflateSync(payload));
  const dict = context.obj({
    Filter: PDFName.of("FlateDecode"),
    Length: contents.length,
  }) as PDFDict;
  const stream = PDFRawStream.of(dict, contents);

  const decoded = decodedWithinBudget(stream, 32 * 1024 * 1024);
  assert.equal(decoded.ok, true);
  assert.equal(
    decoded.ok && Buffer.from(decoded.bytes).toString(),
    payload.toString(),
  );
});

// The object-stream bomb is small on disk and inflates inside PDFDocument.load itself. It is proven refused off the main thread in the e2e; here we only assert it is genuinely tiny on disk, so the e2e fixture cannot quietly become large.
test("the object-stream bomb fixture is tiny on disk next to what it inflates to", async () => {
  const bytes = await objectStreamBombPdf(FEW_HUNDRED_MB);
  // ~300 KB of deflate for ~300 MB inflated, a ratio in line with the audit's own probe (254 KiB -> 256 MiB); the guard is only that it cannot quietly balloon.
  assert.ok(
    bytes.length < 1024 * 1024,
    `expected a small bomb, got ${bytes.length} bytes`,
  );
});
