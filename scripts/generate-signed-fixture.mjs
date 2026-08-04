// Builds tests/fixtures/test-signed.pdf - a genuinely signed PDF, so
// tests/signature-strip.test.ts can prove detection and stripping work
// against a real signature and not only synthetic dicts. Committed, so this
// rarely needs running; it exists so the binary is reproducible and auditable
// rather than an opaque blob of unknown provenance.
//
//   node scripts/generate-signed-fixture.mjs
//
// The signer is a throwaway self-signed certificate minted per run, under a
// name that can't be mistaken for a real one and an address in the reserved
// .invalid TLD (RFC 2606). The key never leaves a temp dir. Nothing here is
// meant to verify as trusted - the point is structural realism.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts
} from 'pdf-lib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, 'tests', 'fixtures', 'test-signed.pdf');

// Real signature dictionaries reserve a fixed-size /Contents placeholder,
// compute /ByteRange around it, then splice the DER in without changing any
// offset. Same approach here.
const SIGNATURE_PLACEHOLDER_BYTES = 4096;
const SIGNER_NAME = 'PDF Annotator Test Fixture';
const SIGNER_SUBJECT =
  '/C=ZZ/O=PDF Annotator Test Fixtures/OU=Not A Real Signer/CN=PDF Annotator Test Fixture/emailAddress=fixture@example.invalid';

const workDir = mkdtempSync(join(tmpdir(), 'pdf-annotator-fixture-'));

try {
  writeFileSync(outputPath, await buildSignedPdf());
  console.log(`Wrote ${outputPath}`);
} finally {
  // The private key only ever lives in this temp directory, for the lifetime
  // of this process.
  rmSync(workDir, { force: true, recursive: true });
}

async function buildSignedPdf() {
  const { certPath, keyPath } = generateSelfSignedCertificate();
  // One timestamp for the certificate's validity window, the document dates
  // and /M, so nothing in the file contradicts anything else.
  const signedAt = new Date();
  const unsigned = await buildUnsignedPdf(signedAt);

  const { byteRange, contentsStart, prepared } = prepareByteRange(unsigned);
  const signedData = Buffer.concat([
    prepared.subarray(byteRange[0], byteRange[0] + byteRange[1]),
    prepared.subarray(byteRange[2], byteRange[2] + byteRange[3])
  ]);

  const der = signDetachedPkcs7(signedData, certPath, keyPath);
  if (der.length > SIGNATURE_PLACEHOLDER_BYTES) {
    throw new Error(
      `Signature is ${der.length} bytes but the placeholder reserves ${SIGNATURE_PLACEHOLDER_BYTES}.`
    );
  }

  // Overwrite the zero-filled placeholder in place. Padding the DER out to the
  // full reserved length is what keeps every byte offset - and therefore the
  // /ByteRange just written - correct.
  const hex = Buffer.alloc(SIGNATURE_PLACEHOLDER_BYTES).fill(0);
  der.copy(hex, 0);
  prepared.write(hex.toString('hex'), contentsStart, 'latin1');
  return prepared;
}

function generateSelfSignedCertificate() {
  const keyPath = join(workDir, 'fixture-key.pem');
  const certPath = join(workDir, 'fixture-cert.pem');

  // Extensions matter even for a throwaway signer. Without them OpenSSL's
  // -x509 mints a CA:TRUE certificate with no keyUsage, i.e. a certificate
  // authority being used to sign a document - which a strict validator
  // (Adobe) rejects on top of the untrusted-root complaint that is expected
  // here. These make it a well-formed end-entity document-signing
  // certificate, so the only remaining objection is the unavoidable one:
  // nothing chains it to a trusted root.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256',
    '-days', '7300',
    '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-subj', SIGNER_SUBJECT,
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,nonRepudiation',
    '-addext', 'extendedKeyUsage=emailProtection'
  ], { stdio: 'pipe' });

  return { certPath, keyPath };
}

function signDetachedPkcs7(data, certPath, keyPath) {
  const dataPath = join(workDir, 'signed-ranges.bin');
  writeFileSync(dataPath, data);

  // Detached (the PDF's byte ranges are the content, not carried inside the
  // blob) and binary, which is what /SubFilter /adbe.pkcs7.detached means.
  return execFileSync('openssl', [
    'cms', '-sign', '-binary', '-md', 'sha256',
    '-in', dataPath,
    '-signer', certPath,
    '-inkey', keyPath,
    '-outform', 'DER'
  ], { maxBuffer: 1024 * 1024 });
}

// PDF date syntax: D:YYYYMMDDHHmmSSOHH'mm'. Always emitted in UTC here.
function pdfDateString(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `+00'00'`
  );
}

async function buildUnsignedPdf(signedAt) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle('PDF Annotator signed test fixture');
  pdfDoc.setAuthor(SIGNER_NAME);
  pdfDoc.setProducer('scripts/generate-signed-fixture.mjs');
  pdfDoc.setCreationDate(signedAt);
  pdfDoc.setModificationDate(signedAt);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([595, 842]);
  page.drawText('Signed test fixture', { font, size: 24, x: 60, y: 760 });
  page.drawText(
    'This document carries a real, self-signed PDF signature.',
    { font, size: 11, x: 60, y: 730 }
  );
  page.drawText(
    'It exists so the signature strip can be tested against a real one.',
    { font, size: 11, x: 60, y: 712 }
  );

  const { context } = pdfDoc;

  // The visible "signed by" stamp. This is the part that matters for the
  // invariant under test: it is ordinary page content to a renderer that does
  // not verify signatures, so an edited copy that kept it would still display
  // a signature backed by nothing.
  const appearanceRef = context.register(
    context.flateStream(signatureAppearanceOperators(SIGNER_NAME, signedAt), {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: context.obj([0, 0, 240, 60]),
      Resources: context.obj({ Font: context.obj({ Helv: font.ref }) })
    })
  );

  // PDFString.of, not a bare JS string: pdf-lib's context.obj() turns a
  // string into a PDF *Name* (/Like#20This), and these entries are required
  // to be text strings. Getting that wrong is not cosmetic - a field whose
  // /T is a Name is malformed, and Adobe drops the whole field rather than
  // listing it in the signature panel. Lenient viewers (Chrome, pdf.js) still
  // draw the page, so the file looks fine right up until it matters.
  // /Filter and /SubFilter below genuinely are Names, and stay bare.
  const signature = context.register(
    context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      Name: PDFString.of(SIGNER_NAME),
      Reason: PDFString.of('Test fixture for signature stripping'),
      Location: PDFString.of('Test suite'),
      // The signing time has to be *now*, not a fixed date: the certificate
      // is minted fresh on every run, so a hard-coded /M in the past claims
      // the document was signed before its own signer existed, and a strict
      // validator reads that as a broken signature rather than a stale
      // fixture. This also keeps /M consistent with the signingTime
      // attribute OpenSSL puts inside the CMS blob.
      // Full PDF date syntax, per the spec's D:YYYYMMDDHHmmSSOHH'mm'.
      M: PDFString.of(pdfDateString(signedAt)),
      // Both are rewritten after serialisation, once the real offsets and the
      // real signature are known. The placeholder numbers are deliberately
      // wide: the rewrite pads with spaces to the same length, so it can only
      // ever shrink the digits, never push the file's bytes around and
      // invalidate the offsets it just computed.
      ByteRange: context.obj([0, 9999999999, 9999999999, 9999999999]),
      Contents: PDFHexString.of('0'.repeat(SIGNATURE_PLACEHOLDER_BYTES * 2))
    })
  );

  const signatureField = context.register(
    context.obj({
      FT: 'Sig',
      T: PDFString.of('Signature1'),
      V: signature,
      F: 4,
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: context.obj([60, 600, 300, 660]),
      AP: context.obj({ N: appearanceRef }),
      P: page.ref
    })
  );

  page.node.set(PDFName.of('Annots'), context.obj([signatureField]));
  pdfDoc.catalog.set(
    PDFName.of('AcroForm'),
    context.register(
      context.obj({
        Fields: context.obj([signatureField]),
        SigFlags: 3,
        DA: PDFString.of('/Helv 0 Tf 0 g'),
        DR: context.obj({ Font: context.obj({ Helv: font.ref }) })
      })
    )
  );

  // A signed document is expected to carry a file /ID, and pdf-lib does not
  // write one by default. Fixed rather than random so re-running the
  // generator changes as little as possible. Both halves are identical
  // because this file has no incremental-update history.
  const fileId = PDFHexString.of('504446416E6E6F7461746F7254657374536967');
  context.trailerInfo.ID = context.obj([fileId, fileId]);

  // useObjectStreams: false because a signature dictionary has to be directly
  // addressable in the file - /ByteRange is computed over raw offsets, so no
  // real signer ever packs one into a compressed object stream. It is also
  // what makes the markers visible to pdfProtection's raw-byte scan, exactly
  // as they are in a genuinely signed document.
  const bytes = await pdfDoc.save({
    objectsPerTick: 500,
    updateFieldAppearances: false,
    useObjectStreams: false
  });
  return Buffer.from(bytes);
}

// The date drawn here is the same instant as /M and the CMS signingTime -
// a stamp that visibly disagrees with the signature it represents is exactly
// the sort of thing this fixture exists to catch elsewhere.
function signatureAppearanceOperators(name, signedAt) {
  const line = (text, size, x, y) =>
    `BT /Helv ${size} Tf ${x} ${y} Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;

  return [
    'q',
    '0.85 0.89 0.95 rg 0 0 240 60 re f',
    '0.20 0.30 0.55 RG 1 w 0.5 0.5 239 59 re S',
    '0 0 0 rg',
    line('Digitally signed by', 8, 8, 44),
    line(name, 10, 8, 30),
    line(
      `Date: ${signedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
      7,
      8,
      14
    ),
    'Q'
  ].join('\n');
}

// Computes the /ByteRange covering everything except the /Contents hex string
// (the angle brackets stay outside the signed ranges, per the PDF spec), then
// rewrites the placeholder array in place at a fixed width.
function prepareByteRange(pdfBytes) {
  const buffer = Buffer.from(pdfBytes);
  const latin1 = buffer.toString('latin1');

  const contentsMatch = /\/Contents\s*<0+>/.exec(latin1);
  if (!contentsMatch) {
    throw new Error('Could not find the /Contents placeholder.');
  }

  const openAngle = latin1.indexOf('<', contentsMatch.index);
  const closeAngle = latin1.indexOf('>', openAngle);
  const contentsStart = openAngle + 1;

  const byteRange = [
    0,
    openAngle,
    closeAngle + 1,
    buffer.length - (closeAngle + 1)
  ];

  const byteRangeMatch = /\/ByteRange\s*\[[^\]]*\]/.exec(latin1);
  if (!byteRangeMatch) {
    throw new Error('Could not find the /ByteRange placeholder.');
  }

  const replacement = `/ByteRange [${byteRange.join(' ')}]`;
  if (replacement.length > byteRangeMatch[0].length) {
    throw new Error(
      'The real /ByteRange is longer than its placeholder; widen the placeholder.'
    );
  }

  // Pad with spaces so the rewrite is length-neutral and every offset above
  // stays valid.
  buffer.write(
    replacement.padEnd(byteRangeMatch[0].length, ' '),
    byteRangeMatch.index,
    'latin1'
  );

  return { byteRange, contentsStart, prepared: buffer };
}
