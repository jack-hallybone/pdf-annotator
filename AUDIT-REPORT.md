# PDF Annotator audit report

Date: 3 August 2026 (supersedes the 30 July 2026 review)

## Outcome

The reviewed revision is suitable for continued client-side development and for
publication as a public, readable repository. Every issue found in this round
was fixed in this revision. Static checks are clean, all 150 unit/DOM tests
pass, a production build completes, and `npm audit` reports no known
vulnerabilities.

This round re-verified the previous review's conclusions independently rather
than taking them as given, and then went deeper on the two stated priorities:
**security** and **data integrity**. The first three findings below were missed
by the previous pass.

The one thing that still blocks a conventional open-source release is
deliberate: there is **no `LICENSE` file**, so no rights are granted to anyone
reading the repository. See "Publication readiness".

## Findings and resolutions

| Severity | Area | Finding | Resolution |
| --- | --- | --- | --- |
| Medium | Data integrity | Every save destroyed the document's catalog XMP metadata — `dc:title`, `dc:creator`, rights and dates — including for ordinary documents that never claimed PDF/A. `stripPdfAConformanceClaims` deleted the catalog's `/Metadata` unconditionally, and the existing tests only covered XMP attached to a *page*, so the loss was invisible. | The strip is now targeted at conformance claims wherever they hang, catalog included; unrelated XMP is preserved. The PDF/A invariant (`pdfLooksPdfA(ourOutput) === false`) is unchanged and still enforced. Regression test added: `catalog XMP without a PDF/A claim survives an edit`. |
| Medium | Data integrity | When an in-place save failed, the reason was swallowed by a bare `catch` and the user was shown a Save As dialog with no explanation. The messages lost this way are the ones that matter most — *"The PDF changed outside this window"*, *"Permission to save to the original file was not granted"*, and the post-write byte-verification failures. Cancelling the dialog then reported a plain *"Save cancelled"*, so a user could conclude nothing was wrong while another program held newer content. | The failure reason is surfaced before the Save As dialog opens. Outcome messages now state explicitly that the original file was left unchanged, including on the success path, so a successful Save As is never mistaken for a normal save. |
| Low | Security (defence in depth) | The external-link protocol allowlist was applied only in `pdfLinks.ts`, two modules upstream of the `window.open` that actually opens the URL. The guarantee that no `javascript:`/`data:`/`file:` URL from a PDF is ever opened rested entirely on that one caller staying correct. | The same allowlist is re-applied at the open point and at the trust-key gate, so a disallowed address cannot reach the confirmation dialog or the opener even if a future caller forgets. Four regression tests added, including credential stripping. |
| Low | Data integrity | `removePagesRange`, used by the undo/redo path, lacked the "a PDF must keep at least one page" floor that the forward `removePage` enforces. Reachable only through a malformed history entry, but a zero-page PDF is unopenable and therefore unrecoverable. | Added the same guard. Failing the operation is recoverable; writing out an empty document is not. |
| Low | Correctness | The print flow's intermediate "open the PDF in a new tab" fallback was unreachable: `window.open` returns `null` whenever `noopener` is set, so the ~40 lines behind it had never run and every failed frame-print already fell through to a download. | Removed the dead path and documented why a tab is *not* opened (it would require handing a window reference to a document built from untrusted PDF bytes). The fallback now also revokes the print blob URL immediately instead of holding the document's bytes until the 10-minute revoke timer. |
| Low | Performance | The PDF.js WASM warm-up set `crossOrigin="anonymous"` on `<link rel="preload" as="fetch">` for same-origin assets. That puts the preload in CORS mode while the actual `fetch` uses same-origin mode — different preload-cache keys, so the preload was never matched and roughly 435 KiB of WASM was downloaded twice on every cold load. | Dropped `crossOrigin` so the preload and the fetch agree. |
| Low | Accuracy | File-size limits were computed in binary units but labelled in decimal ones, so the 128 MiB PDF cap was reported to the user as "128.0 MB" and the image cap as "32 MB" — different numbers from the ones the README documents. | Labels are now `KiB`/`MiB`/`GiB`, matching both the arithmetic and the README. |
| Low | Robustness | With JavaScript disabled the app rendered a blank white page with no explanation. | Added a `<noscript>` fallback that explains the app is client-side by design and therefore cannot run without scripting. Styled with a `style` attribute because the production CSP permits inline styles but not inline scripts. |
| Low | Documentation | `CLAUDE.md` stated the Playwright smoke suite was "NOT wired into CI yet". The deploy workflow installs Chromium and runs `npm run test:e2e` before building, so a red smoke test already blocks a deploy. | Corrected. The PDF/A invariant note now also records that the strip is targeted rather than a blanket XMP delete, so the metadata-loss defect cannot be reintroduced as a "simplification". |
| Medium | Correctness / fidelity | No widget annotation was ever rendered. Form fields and the on-page stamp of a signature field were excluded from the appearance overlay *and* from the pdf.js layer, so a signed or form-bearing document displayed with content silently missing — different from Adobe, Chrome and every other viewer. Someone deciding whether to edit a signed document could not see the signature they were about to strip. | Widgets are now painted by the appearance overlay (pdf.js already rendered them; the app's pixel mask was discarding them). They remain strictly non-interactive: the HTML annotation layer still admits links only, with `renderForms: false` and `enableScripting: false`. The policy was extracted to `src/workspace/annotationDisplayPolicy.ts` and is covered by `tests/annotation-display-policy.test.ts`. |
| Low | Documentation | The README claimed unsupported annotation kinds are "rendered read-only", and CLAUDE.md's invariant 7 justified the signature strip on the grounds that the stamp displays in "a renderer that doesn't verify (this app included)". Neither was true while widgets were never drawn. | Both corrected, and the layer split is now invariant 9 so the security boundary between "painted" and "interactive" is explicit. |
| Low | Publication | No licence, and the signed test fixture was a third-party sample PDF carrying an unrelated real person's name and email address inside its certificate chain. Because that identity sits in the hex-encoded PKCS#7 blob, the existing fixture-privacy scan could not see it. | Licence status is now stated explicitly in the README (see below). The fixture is now generated by `scripts/generate-signed-fixture.mjs` under a throwaway synthetic identity, and `tests/fixture-privacy.test.ts` decodes long hex strings before scanning and fails on any email address outside a reserved test domain — verified against the old fixture, which it correctly rejects. |

## Security controls verified

Re-checked directly against the source in this round, not carried over:

- **No network path for user content.** A repository-wide sweep found no
  `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `localStorage`, `sessionStorage`,
  `indexedDB` or `document.cookie` anywhere in `src/`. The only `fetch` is the
  same-origin PDF.js WASM warm-up in `src/pdfRuntime.ts`. CSP `connect-src
  'self'` backs this up.
- **No dynamic code or HTML injection.** No `innerHTML`, `outerHTML`,
  `dangerouslySetInnerHTML`, `insertAdjacentHTML`, `eval`, `new Function`,
  `document.write`, `srcdoc`, `javascript:` or `data:text/html` in the source.
- **PDF.js hardening intact**: `isEvalSupported: false`, `enableXfa: false`,
  `isImageDecoderSupported: false`, and no `PDFScriptingManager`, so embedded
  PDF JavaScript never executes.
- **CSP** is `default-src 'self'` with `object-src 'none'`, `frame-ancestors
  'none'`, `form-action 'none'`, `base-uri 'self'`, and `wasm-unsafe-eval` as
  the only script relaxation. Production correctly drops `frame-ancestors` from
  the `<meta>` form (it is not expressible there) and relies on the runtime
  frame guard instead — the documented GitHub Pages limitation.
- **Save path** still re-checks readwrite permission, compares a full SHA-256
  fingerprint against the on-disk file, takes a cross-window lock, writes with
  an `exclusive` stream and re-reads every byte after close. A verification
  failure deliberately leaves the stored fingerprint stale, so the next save
  fails closed rather than silently overwriting.
- **Service-worker precache remains an allowlist** that refuses `.pdf`, `.map`,
  `.env` and fixture paths, and throws on any unexpected build output.
- **Filename handling** strips path separators, control characters and Windows
  reserved names, and truncates — no traversal through a download name.
- **Fixtures** carry no local user paths, private keys or real email addresses
  (enforced by `tests/fixture-privacy.test.ts`, which now decodes embedded hex
  blobs so an identity inside a certificate cannot hide from the scan), and no
  repository secrets were found.

## Data integrity verified

- Annotation round trips, rotation re-import, structural history and the
  PDF/A + signature strips are covered by fixture-backed tests; the PDF/A and
  signature invariants were re-confirmed against real signed and PDF/A files
  after the metadata change above.
- Confirmed by experiment that the app's own output cannot trip its own PDF/A
  detector through user-entered annotation text: pdf-lib packs strings into
  compressed object streams, so the raw-byte marker scan cannot see them.
- Tab de-duplication uses File System Access entry identity, not
  filename/size/mtime.

## Accepted trade-offs (reviewed, deliberately unchanged)

- `pdfLooksPdfA` scans for the bare string `PDF/A`, so an unrelated document
  that merely mentions it in uncompressed metadata can open read-only. This
  fails **closed**, the "edit a copy" path remains available, and tightening the
  heuristic would risk letting a genuine PDF/A claim survive a save — which is
  the invariant that actually matters.
- The deploy workflow pins GitHub Actions to mutable major tags (`@v6`, `@v5`)
  rather than commit SHAs. SHA pinning is the more hardened choice for a public
  repository; it was left alone here because the correct SHAs cannot be
  verified from this environment.
- The entry bundle is ~1.43 MB minified / ~482 kB gzipped because the editor and
  PDF libraries load together. A performance opportunity, not a defect.


## Open compatibility risk (not fixed — needs your decision)

`pdfjs-dist` 6.0.227 calls `Map.prototype.getOrInsertComputed` and
`Math.sumPrecise` during rendering. Both are very recent JavaScript builtins.
This environment's Chromium 141 lacks them, and the result is that **every page
fails to render** with only a generic "Could not display page 1." notice — no
indication that the browser is simply too old.

That means anyone on a browser older than roughly Chrome/Edge 142 gets a broken
app with a misleading error. Worth either raising the documented minimum browser
version, or detecting the missing builtins at startup and saying so plainly.
Not changed here because the right answer depends on which browsers you intend
to support.

## Publication readiness

- **Licence: none, by decision.** The repository grants no rights to use, copy,
  modify or redistribute. The README now says so plainly rather than leaving the
  question unanswered, which is the failure mode that actually misleads people.
  Adding a `LICENSE` file is the single step that changes this.
- Third-party licences are retained and referenced: Lucide (ISC) ships its
  licence file into the build, and PDF.js ships its own licences under
  `pdfjs/`.
- **The repository now ships no third-party content it did not create.**
  `tests/fixtures/test-signed.pdf` was previously a third-party sample signed
  PDF carrying an unrelated real name and email address in its certificate
  chain. It has been replaced by `scripts/generate-signed-fixture.mjs`, which
  builds a genuinely signed PDF — real `/ByteRange` offsets and a detached
  PKCS#7 blob that verifies against them — under a throwaway self-signed
  identity (`CN=PDF Annotator Test Fixture`, `C=ZZ`, `.invalid` address). The
  private key exists only for the lifetime of the script. Committing the
  generator rather than an opaque binary also makes the fixture auditable and
  rebuildable.
- No secrets, credentials, personal paths or internal hostnames are present.
  `.gitignore` excludes `*.pdf`, key material, `.env*` and `.npmrc`, re-admitting
  only the named test fixtures.
- The deploy workflow uses least privilege (`contents: read`) and
  `persist-credentials: false`.

## Verification record

- `npx tsc -b` — pass
- `npm run lint` — pass, 0 errors, 0 warnings
- `npm test` — pass, 119 unit + 31 DOM
- `npm run build` — pass
- `npm audit --audit-level=low` — pass, 0 vulnerabilities

Two checks could not run in this environment and should be run on a normal
network:

- `npm run test:e2e` — needs a Playwright Chromium download; the deploy
  workflow already performs this step.
- `npm audit signatures` — the registry signature endpoint is unreachable from
  here. The vulnerability audit itself completed with zero findings.

## Maintenance notes

- Keep `npm run security:audit` as a CI gate in an environment that can reach
  npm's signature endpoints.
- Consider pinning the deploy workflow's actions to commit SHAs.
- When touching `saveEditedPdf`, remember that the PDF/A strip is deliberately
  targeted: deleting XMP wholesale is the metadata-loss defect fixed in this
  round, not a simplification.
