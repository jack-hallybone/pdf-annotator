// Decompression bombs built in code and tiny on disk: a few kilobytes of deflate that inflate to hundreds of megabytes. The filler is streamed through deflate a chunk at a time, so building one never holds the inflated size in memory - only the code decoding it (the thing under test) is meant to feel the size.
import { createDeflate, deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, type PDFDict } from "pdf-lib";

const DEFLATE_CHUNK_BYTES = 8 * 1024 * 1024;
const enc = (text: string) => Buffer.from(text, "latin1");

// A PDF/A claim, so a decoded metadata bomb reads as a real conformance claim rather than noise.
const PDFA_MARKER = enc(
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">' +
    "<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>" +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
);

// deflate(prefix + `fillerBytes` spaces), streamed so this process never allocates the inflated size.
async function flateOfPadded(
  prefix: Buffer,
  fillerBytes: number,
): Promise<Uint8Array> {
  const deflate = createDeflate({ level: 6 });
  const parts: Buffer[] = [];
  deflate.on("data", (part) => parts.push(part));
  const finished = new Promise<void>((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });

  deflate.write(prefix);
  const filler = Buffer.alloc(DEFLATE_CHUNK_BYTES, 0x20);
  let remaining = fillerBytes;
  while (remaining > 0) {
    const size = Math.min(DEFLATE_CHUNK_BYTES, remaining);
    const chunk =
      size === DEFLATE_CHUNK_BYTES ? filler : filler.subarray(0, size);
    if (!deflate.write(chunk)) {
      await new Promise<void>((resolve) => deflate.once("drain", resolve));
    }
    remaining -= size;
  }
  deflate.end();
  await finished;
  return new Uint8Array(Buffer.concat(parts));
}

// The inner output is only kilobytes, so deflating it a second time needs no streaming.
async function bombContents(
  prefix: Buffer,
  inflatedBytes: number,
  nested: boolean,
) {
  const once = await flateOfPadded(
    prefix,
    Math.max(0, inflatedBytes - prefix.length),
  );
  return nested ? new Uint8Array(deflateSync(Buffer.from(once))) : once;
}

// A one-page PDF whose catalog /Metadata is a stream that inflates to `inflatedBytes`. With `claim`, a PDF/A marker sits at the front (a real claim buried in a bomb); without it the stream is pure filler, so only a reader that decodes the whole thing could conclude it holds no claim.
export async function catalogMetadataBombPdf(
  inflatedBytes: number,
  { nested = false, claim = true }: { nested?: boolean; claim?: boolean } = {},
): Promise<Uint8Array> {
  const prefix = claim ? PDFA_MARKER : Buffer.alloc(0);
  const contents = await bombContents(prefix, inflatedBytes, nested);
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const { context } = doc;
  const filter = nested
    ? context.obj([PDFName.of("FlateDecode"), PDFName.of("FlateDecode")])
    : PDFName.of("FlateDecode");
  const dict = context.obj({
    Type: "Metadata",
    Subtype: "XML",
    Filter: filter,
    Length: contents.length,
  }) as PDFDict;
  const ref = context.register(PDFRawStream.of(dict, contents));
  (doc.catalog as PDFDict).set(PDFName.of("Metadata"), ref);
  // useObjectStreams: false keeps the structure plain, so the bomb is the only stream that inflates.
  return doc.save({ useObjectStreams: false });
}

// A one-page PDF whose object stream inflates to `inflatedBytes` inside PDFDocument.load itself, before any project code can look at it. Built by hand: pdf-lib will not emit a bomb of its own.
export async function objectStreamBombPdf(
  inflatedBytes: number,
  { nested = false }: { nested?: boolean } = {},
): Promise<Uint8Array> {
  // Inflated ObjStm body: a one-entry "objnum offset" table, then object 4 at offset 0, then the filler that makes it huge.
  const table = "4 0\n";
  const objText = "<< /Producer (x) >>";
  const first = table.length;
  const contents = await bombContents(
    enc(table + objText),
    inflatedBytes,
    nested,
  );
  const filterDecl = nested ? "[/FlateDecode /FlateDecode]" : "/FlateDecode";

  const offsets: Record<number, number> = {};
  let out = enc("%PDF-1.7\n");
  const add = (num: number, body: Buffer) => {
    offsets[num] = out.length;
    out = Buffer.concat([out, enc(`${num} 0 obj\n`), body, enc("\nendobj\n")]);
  };
  add(1, enc("<< /Type /Catalog /Pages 2 0 R >>"));
  add(2, enc("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  add(3, enc("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"));
  add(
    6,
    Buffer.concat([
      enc(
        `<< /Type /ObjStm /N 1 /First ${first} /Filter ${filterDecl} /Length ${contents.length} >>\nstream\n`,
      ),
      Buffer.from(contents),
      enc("\nendstream"),
    ]),
  );
  const xrefAt = out.length;
  let xref = enc("xref\n0 7\n0000000000 65535 f \n");
  for (let num = 1; num <= 6; num += 1) {
    xref = Buffer.concat([
      xref,
      enc(
        num in offsets
          ? `${String(offsets[num]).padStart(10, "0")} 00000 n \n`
          : "0000000000 65535 f \n",
      ),
    ]);
  }
  out = Buffer.concat([
    out,
    xref,
    enc(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`),
  ]);
  return new Uint8Array(out);
}
