# Test fixtures

Small PDFs committed so the test suite can exercise real-world file structure
rather than only synthetic documents built by pdf-lib. Everything here is
committed deliberately — `.gitignore` excludes `*.pdf` and re-admits only
`tests/fixtures/test-*.pdf`.

`tests/fixture-privacy.test.ts` fails the build if a fixture contains a local
user path, a private-key block, or an email address outside a reserved test
domain (it decodes long hex strings first, so an identity inside a certificate
can't hide from the scan).

Before adding or replacing a fixture:

- Scrub personal metadata (`/Author`, `/Creator`, XMP `dc:creator`) and any
  visible personal information.
- Open it in PDF Annotator, Chrome/Edge, Acrobat, and another independent
  reader where possible.
- Check unsupported annotations stay visible but read-only, and that editable
  ones save and reopen in at least one other reader.
- Check `Save`, `Save As`, `Download copy`, and hidden-annotation `Print`.

## What each file is for

| Fixture | Used by | Why a real file is needed |
| --- | --- | --- |
| `test-annotated.pdf` | most suites; base document for synthetic fixtures | A real word-processor export with existing annotations, so import/round-trip runs against real structure. Authored for this repo; identity fields scrubbed to "Test Fixture 1". |
| `test-pdfa.pdf` | `pdfa-conformance.test.ts` | Carries a genuine `GTS_PDFA1` output intent plus `pdfaid` XMP, which is what the PDF/A strip has to remove. Authored for this repo; scrubbed. |
| `test-password-12356.pdf` | `pdf-integrity.test.ts`, read-only policy | A genuinely encrypted document. The password is in the filename on purpose (`12356`) — it is a throwaway fixture, not a secret. |
| `test-signed.pdf` | `signature-strip.test.ts` (one test) | The one place a *real* signed document is needed: everything else builds synthetic signature structures. Generated — see below. |

## `test-signed.pdf` is generated, not sourced

Rebuild it with:

```bash
node scripts/generate-signed-fixture.mjs
```

It is a genuinely signed PDF: real `/ByteRange` offsets, a real detached
PKCS#7 blob in `/Contents` that verifies against those byte ranges, and a
signature dictionary left uncompressed in the file the way a real signer has
to leave it. That structural realism is the whole reason the fixture exists —
`signature-strip.test.ts` builds every *other* signature fixture at runtime
from `test-annotated.pdf`, and those can't exercise real offsets or a real
certificate.

The signing identity is deliberately synthetic and regenerated on every run:
a throwaway self-signed certificate under `CN=PDF Annotator Test Fixture`,
`O=PDF Annotator Test Fixtures`, `OU=Not A Real Signer`, `C=ZZ`, with an
address in the reserved `.invalid` TLD (RFC 2606). The private key lives in a
temporary directory for the lifetime of the script and is deleted when it
exits. Nothing here is meant to verify as trusted, and the signature is
expected to fail validation in any real reader — the app never verifies
signatures, it only detects and strips them.

Regenerating produces a byte-different file (new key, new timestamps in the
CMS blob). That's expected; the tests assert on structure, not on the exact
bytes.

It is built to satisfy a *strict* reader, not just a lenient one. Adobe Acrobat
lists it in the signature panel (as an untrusted signature, which is the point);
Chrome and pdf.js render the page. The difference matters when editing the
generator: pdf-lib's `context.obj('text')` produces a PDF **Name**, not a
**String**, and entries like a field's `/T` or a signature's `/M` are required
to be strings. Get that wrong and lenient viewers still render the file
perfectly while Acrobat silently drops the field from the panel — so check any
change in a strict reader, not only in a browser.

An earlier revision used a third-party sample signed PDF that carried an
unrelated real name and email address in its certificate chain. It was
replaced by this generator so the repository ships nothing it didn't create.
