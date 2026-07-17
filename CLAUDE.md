# CLAUDE.md — Agent guide for pdf-annotator

Guidance for an LLM maintaining this repo. Read this before editing. It encodes
the invariants that must never regress, where things live, and the traps that
are easy to fall into. `README.md` documents the components for *consumers*;
this file is for whoever *changes* them.

## What this is

A **fully client-side** PDF viewer + annotation editor (React 19, PDF.js,
pdf-lib). It opens local PDFs, edits interoperable annotations, mutates pages
(add/delete/rotate/merge), and saves back to disk. It ships as an installable
PWA on GitHub Pages. There is **no backend and no network I/O of user data** —
that is a feature, not an accident (see Invariants).

## Commands

```bash
npm ci                 # install (CI uses --ignore-scripts)
npm run dev            # vite dev server on 127.0.0.1:5173 (or: docker compose up)
npm test               # test:unit + test:dom
npm run test:unit      # pure-logic node --test over tests/*.test.ts (no DOM)
npm run test:dom       # component/hook tests over tests/*.dom.test.tsx (jsdom)
npm run lint           # eslint
npx tsc -b             # typecheck (also runs first in `npm run build`)
npm run build          # tsc -b && vite build && generate service worker
npm run security:audit # npm audit && npm audit signatures (CI gate)
```

Always run `npx tsc -b` and `npm test` before considering a change done. The
build is what CI deploys, and it typechecks the whole project.

## Architecture — three layers, capabilities flow upward

- **`src/workspace/`** — the reusable single-PDF component (`PdfWorkspace`).
  Owns PDF rendering, annotation editing, and all PDF mutation. This is the
  core; most logic lives here.
- **`src/tabbedapp/`** — `TabbedPdfShell`, a Chrome-style multi-tab wrapper
  around `PdfWorkspace`. Owns tab lifecycle and passes host capabilities down.
- **`src/browserapp/`** — the GitHub Pages / PWA host. Owns browser file access
  (File System Access API), the service worker, install prompt, frame guard.

A feature button appears only when the host supplies the matching capability
(`printTarget`, `pickImageFile`, `saveAsTarget`, …). Don't hard-wire host
behaviour into `PdfWorkspace`; thread it through props/`fileAdapter`.

## Invariants — DO NOT REGRESS

These are the reason the app is trustworthy. A change that weakens any of them
is wrong even if it "works".

### Data safety
1. **No network transmission of user content, ever.** No `fetch`/XHR/WebSocket/
   `sendBeacon` carrying PDF bytes, filenames, annotations, or passwords. The
   only allowed `fetch` is same-origin PDF.js WASM/asset warming
   (`src/pdfRuntime.ts`). CSP `connect-src 'self'` enforces this — keep it.
2. **No persistence of user content.** No `localStorage`/`sessionStorage`/
   `indexedDB`/cache of PDF bytes or annotations. File handles stay in memory
   for the session only.
3. **`SensitivePdfWorkspaceSession` must never be serialized.** It holds full
   bytes + history. It is tagged with a throwing `toJSON`
   (`markNonSerializable`, `src/workspace/sensitiveSession.ts`). Never log it,
   persist it, or send it. If you add a field that holds bytes, keep it inside
   this guarded object.
4. **The save path is safety-critical** (`src/browserapp/localFileAccess.ts`,
   `savePdfToLocalFile`): re-check readwrite permission → compare SHA-256
   fingerprint against the on-disk file to detect external edits → `exclusive`
   write → **byte-for-byte re-read verification** after close. Do not remove the
   fingerprint check or the post-write verification.
5. **Service worker precache is an allowlist**
   (`scripts/generate-service-worker.mjs`). It must keep refusing `.pdf`,
   `.env`, `.map`, and fixtures. If you add a build asset type, extend
   `isAllowedPrecacheFile` deliberately — never widen it to a catch-all.

### Security
6. **PDF.js stays hardened** (`src/workspace/pdfRender.ts`,
   `PDFJS_DOCUMENT_OPTIONS`): `isEvalSupported: false`, `enableXfa: false`,
   `isImageDecoderSupported: false`. Do **not** wire a `PDFScriptingManager` —
   that would let embedded PDF JavaScript run.
7. **External links go through sanitization** (`src/workspace/pdfLinks.ts`):
   protocol allowlist (`http`/`https`/`mailto`), strip credentials,
   `rel="noopener noreferrer nofollow"`, `referrerPolicy="no-referrer"`, and a
   user-confirmed open. Never let a raw PDF URL reach `window.open` directly.
8. **CSP is strict** (`vite.config.ts`): `default-src 'self'`, `object-src
   'none'`, no `unsafe-eval` for scripts (only `wasm-unsafe-eval`). Keep it that
   way. See the GitHub Pages caveat below.
9. **No `innerHTML`/`eval`/`new Function`/`document.write`.** The codebase has
   none; keep it that way. Build DOM with the framework or `createElement`.

## Comment style

Comment the **why**, not the **what**. Keep comments that encode rationale,
invariants, or a non-obvious constraint — why PDF scripting is off, why
`bytes.slice()` copies, why refs are read instead of listed as deps, why
`preventDefault` runs before a bail. These stop a future editor (you) from
"simplifying" the code back into a bug. Delete comments that merely restate
what the line does. Prefer one dense sentence over a paragraph. When a change
looks redundant or wrong without explanation, that's exactly when a short
"why" comment earns its place. Don't strip the existing rationale comments
wholesale — much of the security/data-safety intent lives in them.

## Gotchas / traps

- **GitHub Pages can't set HTTP headers.** `vite.config.ts` sets COOP, CORP,
  `X-Frame-Options`, `Permissions-Policy`, and the header-form CSP — but only on
  the dev/preview servers. Production gets only the **`<meta>` CSP**, which
  cannot express `frame-ancestors`/`X-Frame-Options`. Clickjacking protection in
  prod therefore rests on the JS check in `src/browserapp/frameGuard.ts`. If you
  touch framing/isolation, remember prod ≠ dev here.
- **`useLatestRef` / refs-over-deps is intentional.** Many effects read
  `somethingRef.current` instead of listing deps, to avoid re-subscribing. This
  is why `npm run lint` reports ~30 `react-hooks/exhaustive-deps` warnings (0
  errors). Before "fixing" one, confirm the ref pattern wasn't deliberate — a
  naive dep-array change can cause re-subscribe loops or stale closures.
- **`PdfWorkspace.tsx` (~4.6k lines) and `PdfPageView.tsx` (~4.8k lines) are
  huge.** State is shared across many closures via refs. A small edit can have a
  wide blast radius. Read the whole neighbourhood before changing shared state,
  and prefer adding to the existing helper for a concern over inlining. The
  self-contained concerns have already been extracted into tested hooks:
  `useWorkspaceNotices`, `useWorkspaceZoom` (+ `scrollGeometry`),
  `useExternalLinks`, `usePageCache`. The remaining bulk (load orchestration,
  annotation-commit core, undo/redo history, save) is **intentionally left
  inline** - it's irreducibly coupled, and splitting it relocates complexity or
  risks invariants (see `docs/REFACTOR-PLAN.md`). Only extract a concern if it
  has a genuinely narrow seam; add a `useXxx()` hook + `*.dom.test.tsx` when you
  do. The goal is small blast radius, not small files.
- **Service worker navigation is network-first *with a timeout*.** The SW source
  lives in `scripts/serviceWorkerSource.mjs` (pure, unit-tested via
  `tests/service-worker-source.test.ts`); the generator writes it to
  `out/renderer/sw.js` at build time. Navigations race the network against
  `NAVIGATION_NETWORK_TIMEOUT_MS` and fall back to the cached shell — a plain
  `fetch().catch()` is NOT enough, because a weak connection *stalls* rather
  than rejecting, hanging the installed PWA's launch. Keep the timeout. Precached
  (hashed) assets stay cache-first.
- **Load generations.** Async PDF loads guard against races with
  `loadGenerationRef` / `mountedRef`. When adding async work in the load path,
  check the generation is still current before committing state.
- **`getDocument({ data: bytes.slice() })`** copies input bytes on purpose so
  PDF.js can't detach the caller's buffer. Keep the copy.

## Tests

Two suites, run in separate processes so they don't share globals:

- **`tests/*.test.ts`** — pure-logic Node tests (geometry, annotation
  round-trips, history, fingerprint/privacy). Fast, no DOM. Some set up their
  own lightweight DOM fakes; that's why jsdom must NOT be loaded into this
  process.
- **`tests/*.dom.test.tsx`** — component/hook tests that render React into
  jsdom via `@testing-library/react`. Bootstrapped by `tests/dom-setup.ts`
  (loaded with `--import`, so jsdom globals exist before React DOM loads) and
  transpiled with the tests-local `tests/tsconfig.json` (automatic JSX runtime,
  pointed at via `TSX_TSCONFIG_PATH`). Use `renderHook` for extracted hooks.

`tests/fixture-privacy.test.ts` guards that fixtures don't leak — keep it green.
When you extract a hook/component, add a matching `*.dom.test.tsx`.

A third, separate suite is the **Playwright smoke net** (`tests-e2e/*.spec.ts`,
`npm run test:e2e`). It boots the real browser app against a dev server and
covers the coarse load → render → serialize round trip (open a PDF, render it,
download a copy, reparse/reopen it). It is deliberately general — not a
per-bug regression net — and is the safety net that makes the invariant-heavy
`PdfWorkspace` extractions (history, save) safe to attempt. It is NOT part of
`npm test` (needs a browser) and NOT wired into CI yet (CI would need a
`playwright install` step). It uses the environment's pre-installed Chromium
via `executablePath`; override with `PLAYWRIGHT_CHROMIUM_PATH` elsewhere.

## When adding a feature button

1. Add the capability to the host (`fileAdapter` / `PdfWorkspace` prop).
2. Render the control only when the capability is present.
3. If it touches bytes, route through the existing save/verify or
   sensitive-session paths — don't open a new I/O path.
