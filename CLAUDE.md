# pdf-annotator

## Rules of engagement

This section defines the contract you must follow when you work on this project. Do not weaken, remove, reinterpret, or circumvent what is laid down here by changing it. If it seems wrong, raise the issue for discussion. Other than the rules of engagement section you can add and edit this file as required, for example to record hard-earned learnings, as long as you follow rule 8 when doing so.

### Guiding question

When working on this project, always ask:

> What is the simplest, smallest, clearest and most maintainable project that satisfies the stated intent, has no known security or data-integrity issues, and has sufficient evidence to establish that?

### Non-negotiable rules

1. A known security issue blocks release.

2. A known data-integrity issue blocks release.

3. Rules 1 and 2 may only be bypassed following explicit discussion and consent.

4. The project must solve only the intent stated in the README. This intent must not be edited without discussion and approval.

5. Features or scope that appear to extend that intent must be raised for discussion before implementation or removal.

6. When correctness, security, data integrity, or scope cannot be established with reasonable confidence, stop and raise the uncertainty for discussion rather than guessing.

7. Prefer the simplest solution that satisfies the requirement. Do not add abstraction, indirection, configuration, files, dependencies, or code unless they are necessary to satisfy a requirement or prevent a material problem.

8. Avoid verbosity everywhere. The burden of proof is on additions, not omissions. Keep code, comments and documentation concise. A comment must only record what the code cannot state, such as the origin of a magic number, and must be no more than one sentence. Record other information only when it prevents a known future mistake.

9. Tests should establish intended behaviour and guard against meaningful regressions. Do not test implementation details, coverage for its own sake, or policies instead of behaviour.

10. Testing should be proportional to risk. When creating or changing a test, deliberately break the behaviour it protects and verify that the test fails for the right reason.

11. Once the requirements are satisfied and sufficient evidence has been produced, stop. Do not refactor, generalise, optimise or add features without a reason.

12. Potential improvements are new work. Raise them for discussion rather than implementing them.

### Project requirements

1. The project may have public users; safety is paramount.

2. The README must clearly state that the project was written by AI.

3. Follow all dependency licence requirements exactly, including required third-party notices.

4. The project itself must remain unlicensed. Do not use dependencies whose licence would require this project, or derivative works of it, to be licensed or distributed under particular terms.

5. Maintain a simple Docker Compose entry point that builds and/or previews the project without a local toolchain.

#### Consistency with other projects

Where applicable:

6. Prefer appropriate open-source libraries over manually created artwork. Save generated assets rather than generation code when practical.

7. Prefer using `theme.css` over project-specific styles for the UI. Do not edit `theme.css` without discussion and approval.

8. Maintain a light and dark colour scheme and keep these in sync across the project where applicable. For example in meta tags, manifest files, favicons, and other icon files.

9. Use `stamp_version.mjs` to write the release version into the footer, falling back to the string `"preview"`. Do not edit `stamp_version.mjs` without discussion and approval.

10. The footer (or similar UI object) should contain `Made by Jack (and the machines)`, linking to the project's root GitHub Pages URL (https://jack-hallybone.github.io/).

### Definition of Done

Work is done when:

- [ ] All applicable rules and requirements are satisfied.

- [ ] `npm run verify` passes when any functional changes have been made.

- [ ] No secrets are present. No personal information is present except what is required in the footer, and third-party information in third-party files.

- [ ] No unresolved uncertainty could reasonably affect correctness, security, data integrity or scope.

When these conditions are met, stop. Further improvement is a new task.

## Learnings

Things that cost real work to find and that the code cannot state for itself.
Each one is a trap someone already fell into.

### Rendering

- PDF.js must be imported from `pdfjs-dist/legacy/…`, never the default build,
  which calls proposal-stage methods Chromium 141 does not have: every page
  threw before painting and the document came up blank. Covers the worker too.
- PDF.js composes its own asset URLs by appending filenames to a base, so those
  199 cmaps, fonts, ICC profiles and wasm blobs cannot carry a content hash.
  The identity is in the DIRECTORY name instead.
- `renderPriority` is a scheduling hint and must never be an effect dependency.
  It was, and crossing a page boundary while scrolling re-ran cleanups that
  blanked every visible canvas for two frames.
- pdf.js hands every caller of `getPage(n)` the SAME `PDFPageProxy`, so
  `cleanup()` blanks every view at once. A view's claim over a page is a RANGE,
  never an active page index.
- `visiblePageRangeRef` is the one measurement behind page residency, the lazy
  load band and the render ranking. Deriving any of them from
  `activePageIndex ± buffer` leaves visible pages blank when zoomed out.
- `getDocument({ data: bytes.slice() })` copies on purpose, so PDF.js cannot
  detach the caller's buffer. Keep the copy.

### React

- Never use React's `useEffectEvent` here; use `useEventCallback`. React 19.2
  applies the closure swap in a pass that switches on the fiber tag, and
  `ForwardRef` and `SimpleMemoComponent` fall through — so inside a `forwardRef`
  or `memo` component, or any hook called from one, the callback is frozen at
  its mount closure for ever, with no warning.
- `useLatestRef` writes in an effect; `useRenderLatestRef` writes during render.
  Substituting one for the other is a silent one-commit-stale bug.

### Colour

- Never take a canvas colour from a custom property. Canvas takes CSS colour
  strings and silently ignores what it cannot parse, so a `light-dark()` literal
  read off a token paints black. Read a resolved colour off a probe element.
- Never paint `--theme-ink` onto an annotation colour — it shipped as a 1.0:1
  glyph on a black note. Route every mark on a reader-chosen colour through
  `foregroundOn()`, and `flattenOver()` first if the fill is translucent.

### Layout

- A flex item's own padding sets a floor under `flex-basis: 0`, even with
  `min-width: 0`: two children with unequal padding split unevenly by tens of
  pixels despite equal `flex-grow`. Give the ratio to an unpadded wrapper and
  let the padded content fill it at 100%.

### Input

- A drag data store answers only while the drop event is being dispatched. One
  `await` later, `dataTransfer.items` and `.files` are both empty — a drop of
  three PDFs opened the first and silently lost the rest. Read the lot
  synchronously before anything awaits.
- A PWA file launch arrives in two shapes: one launch carrying N files, or, on
  Windows, N launches of one file each. Both must work. A launch arriving before
  the shell mounts its handler is parked and flushed later — a cold start is
  exactly when it arrives.

### PDF correctness

- Annotation identity: an indirect ref including its generation is
  authoritative; a direct dictionary uses its position, confirmed against the
  file; anything ambiguous aborts the save rather than writing to a guess.
  pdf.js's display array is not `/Annots` — it drops what it cannot display and
  moves widgets and popups to the end.
- A page edit moves the page half of an identity AND the index half; taking a
  signature widget out shifts every entry behind it.
- A copy renames, a relink does not. Undoing a page deletion re-creates that
  page's annotation objects under new numbers, and object numbers are RECYCLED,
  so a stale identity can silently resolve to a different annotation.
- A removal the file does not answer to must STOP the save. A key matching two
  annotations was refused while one matching none fell straight through, and a
  deletion was silently left in a document the reader then handed on.
- Every output must stop claiming PDF/A and stop looking signed. A resave breaks
  the crypto while the appearance stream still renders as a signed stamp backed
  by nothing, and it carries the signer's name and scanned signature with it.
  `/SigFlags` is cleared from any AcroForm the strip touches, whatever it found.
- `/Contents` is the reader's own comment, never the page's text. The text a
  highlight covers is derived and never written.
- Deleting a page: pdf-lib's `removePage` leaves everything behind. Placement of
  a structure element is `/StructParents` → `/ParentTree` → `/MCID`, not `/Pg`,
  which is optional. Reaching an object is not owning it — treating it as
  ownership destroyed author-written text on pages the reader KEPT.

### Bounds

- The history stacks are the one place deleted data is kept, so they are bounded
  in BYTES as well as in versions — a count of versions cannot see what a
  version weighs, and thirty pasted images deleted together are one entry.
  Eviction must actually free, and nothing is ever persisted.
- The per-document annotation text bound is checked DURING the page walk and
  stops the moment it is passed. A check afterwards only describes memory
  already spent, and file size is no guide: 6,000,000 characters of notes is a
  23 KiB file, because that text is in a compressed object stream.

### Untrusted text

- A document's own name is untrusted. A file called `report<RLO>fdp.exe<ALM>.pdf`
  painted as `reportexe.pdf` in the tab strip while naming an executable. The
  name enters the model in one place so every surface downstream is covered.
- Annotation text takes the character rules but NOT a length bound: that text is
  the annotation, and cutting it at a number silently deletes a reader's writing.
  Bound it only where a bound costs pixels.

### Build and host

- `.npmrc`'s `ignore-scripts=true` also stops npm running THIS repository's own
  `pre`/`post` scripts, so the build, dev and preview chains are spelled out
  with `&&`. Never add a `prebuild`; it will be skipped in silence.
- GitHub Pages selects a file by path and IGNORES the query, so a cache key
  carrying a build stamp is answered with whatever that path currently holds.
  Identity has to be in the filename, or in a directory name.
- The service worker does not `skipWaiting` or `clientsClaim`: a new build
  installs and waits, so a running page keeps the asset set it booted with.
- Docker runs as root, which is acceptable only because no host path is
  writable: the checkout is mounted read-only and everything else is a named
  volume. A writable bind mount makes root in the container root on the disk.
- Pages cannot set headers, so COOP, CORP, `X-Frame-Options` and the header CSP
  are dev and preview only; production's `<meta>` CSP cannot express
  `frame-ancestors`, and the cover there is the JS frame guard.

### Design system

- Snap to the nearest existing `theme.css` token instead of defining a similar
  one-off value, accepting the small visual change that follows, unless doing
  so would break the visual intent — then raise it rather than inventing a
  local value.

### Layering

The intent does not require it, but the work is large enough to be split into
three reusable layers, each usable without the ones above it: `src/pdfdocumenteditor`
renders one document, `src/tabbedapp` holds several in tabs and panels, and
`src/browserapp` supplies file access and the home screen. Each of the first
two declares its own host contract, named for what it needs rather than for
whichever layer happens to fulfil it: `PdfDocumentEditorHostCapabilities` for
one document, extended by `TabbedAppHostAdapter` for the tabbed shell around
several. A document's own write targets travel on its source, because they
belong to the file.
