# Refactor plan — shrinking `PdfWorkspace.tsx`

## Progress

- **Done** — jsdom + Testing Library harness (`tests/*.dom.test.tsx`).
- **Done** — Playwright smoke net (`tests-e2e/*.spec.ts`, `npm run test:e2e`):
  load → render → download round trip.
- **Done** — `useWorkspaceNotices` (`useWorkspaceNotices.ts`).
- **Done** — `useWorkspaceZoom` (`useWorkspaceZoom.ts`) + shared `scrollGeometry.ts`.
- **Done** — `useExternalLinks` (`useExternalLinks.ts`).
- **Done** — `usePageCache` (`usePageCache.ts`): the loaded-page LRU + resource
  cleanup. NOTE this is only the *bookkeeping* half of the original
  "usePageLifecycle" idea — see reassessment.

`PdfWorkspace.tsx`: ~4,977 → ~4,640 lines. Each extracted hook has a
`*.dom.test.tsx`.

## Reassessment after reading the actual code (important)

The original slice list below was written from a structural sketch. Reading the
real code changed the verdict on the remaining slices: **only clean seams are
worth extracting; the rest relocate complexity or risk invariants.** Concretely:

- **Image handling — leave inline.** `addPreparedImageAnnotationFromData` is the
  shared "commit annotation + select it" flow (also used by text paste and
  clipboard), and image creation is woven into busy-ops, selection state and
  `commitAnnotations`. A hook would need ~10 threaded dependencies and would
  split `handleClipboardPaste`. Net negative.
- **Annotation history — leave inline.** `undoHistory`/`redoHistory` call
  `restoreDocumentHistory`, which reloads PDF bytes and thus pulls in the whole
  load pipeline (setPages, generations, page loading). Only the thin stack
  primitives (`updateUndoStack`/`updateRedoStack`/`trim`/pop) are clean, and
  extracting just those leaves the meaty part behind for little gain.
- **Document save — leave inline (and it's invariant-critical).** The save
  path depends on ~15 things: save/saveAs/download targets, the clean-signature
  refs, `currentPdfOutputBytes` (annotation serialization), `pdfBytesRef`, busy
  ops, notices. Extracting it means a wide, leaky interface *and* puts the
  data-safety-critical write path at risk for little maintainability upside.

Guiding rule going forward: the goal is small **blast radius**, not small files.
The load orchestration, imperative handle, annotation-commit core, history and
save are irreducibly coupled — they belong together. The `CLAUDE.md` invariants
+ the unit/DOM/e2e nets do more for safe maintenance than splitting these would.
The slice catalogue below is kept for reference, but treat "leave inline" above
as the current recommendation.


`src/workspace/PdfWorkspace.tsx` is ~5,000 lines: ~34 state/ref hooks, 17
effects, ~180 nested functions, all sharing closure state. `PdfPageView.tsx` is
~4,800 lines. This is the main maintainability debt. The goal is not "smaller
for its own sake" — it's to **shrink the blast radius of a typical edit** so an
LLM (or human) can change one concern without reading and risking all of them.

## Guiding constraints

- **Behaviour-preserving.** Each step is a pure move + wire-up, verified by
  `npx tsc -b` and `npm test` staying green. No logic changes mixed in.
- **Custom hooks, not prop-drilling.** `PdfWorkspace` stays the single
  component that composes hooks; extracted concerns become `useXxx()` hooks in
  `src/workspace/` returning `{ state, handlers }`. This keeps the shared-ref
  pattern intact instead of fighting it.
- **One concern per PR.** Land and verify each slice independently. Order below
  is chosen so earlier extractions have the fewest inbound dependencies.
- **Don't touch the invariants** (see `CLAUDE.md`) — especially the save/verify
  and sensitive-session paths — except to move them verbatim.

## Already-good precedent

Pure logic is *already* well modularized: `annotationState.ts`,
`annotationGeometry.ts`, `historyStack.ts`, `pdfWriter.ts`, `eraserGeometry.ts`,
`inkCapture.ts`, etc. The problem is specifically the **stateful orchestration**
concentrated in the two big components. The plan below follows the existing
"pure module + thin stateful wrapper" grain.

## Proposed slices (in order)

### 1. `useWorkspaceNotices` — lowest risk, do first
Move `workspaceNotices` state, `noticeIdRef`, `noticeTimersRef`,
`showWorkspaceNotice`, `dismissWorkspaceNotice`, `reportMalformedAnnotations`.
Self-contained (timers + a list). ~80 lines out. Good warm-up to establish the
hook pattern and prove the tsc/test loop.

### 2. `useWorkspaceZoom`
Move `scale`, `pendingZoomAnchorRef`, `updateZoom`, `resetZoom`, `setZoom`,
`captureZoomAnchor`, `fitZoomToPageWidth/Height`, `activePageBaseSize`,
`resetZoom`. Inputs: active page size + scroll container ref. Pure-ish, few
external readers. ~120 lines.

### 3. `useExternalLinks`
Move `trustedExternalLinkKeys`, `externalLinkOpenButtonRef`,
`handleExternalLinkRequest`, `confirm/cancelExternalLinkRequest`,
`openExternalLink`. Depends only on the `onOpenExternalLink` prop and
`pdfLinks.ts`. Security-adjacent — move verbatim, keep the confirm gate. ~90
lines.

### 4. `usePageLifecycle` (loaded-page cache + eviction)
Move `pagesRef`, `loadingPagesRef`, `pageAccessClockRef`, `pageAccessOrderRef`,
`markPageAccess`, `evictOldLoadedPages`, `schedulePageCleanup`,
`scheduleLoadedPagesCleanup`, `schedulePdfPageCleanup`, `ensurePageLoaded`,
`loadPagesEagerly`. This is a cohesive LRU-ish page manager. Bigger (~300
lines) but has a clear seam: it consumes `pdfDoc` + viewer config and exposes
"ensure page N is loaded / evict".

### 5. `useAnnotationHistory`
Move `undoStack`/`redoStack` state + refs, `commitAnnotations`,
`beginAnnotationEdit`, `finishAnnotationEdit`, `undoHistory`, `redoHistory`,
`updateUndoStack`, `updateRedoStack`, `pop*Entry`, `pushDocumentUndoEntry`,
`applyAnnotationHistory`, `createDocumentHistorySnapshot`. Builds on the
existing `historyStack.ts`/`annotationState.ts`. This is the densest slice —
schedule it after the pattern is proven on 1–3. ~350 lines.

### 6. `useImageAnnotations`
Move `handlePickImageFile`, `handleAddImageFromFile`, `addPreparedImage*`,
`imageStampAnnotationForActivePage`, clipboard-paste image path. Depends on the
`pickImageFile` capability + `imageImport.ts`. (Note: the recent image-tool
deactivation fix lives here — keep `setActiveToolKey('select')` up front.)
~200 lines.

### 7. `useDocumentSave` (highest care — invariant-critical)
Move `handleSave`/`handleSaveAs`/`saveAs*`/`handleDownload`/
`currentPdfOutputBytes`/`markCurrentWorkClean`/clean-signature refs. This is the
data-safety core; extract **last**, move verbatim, and lean on the existing
`fixture-privacy` + round-trip tests plus a manual save/verify smoke test.
~250 lines.

### Leftover in `PdfWorkspace.tsx`
After 1–7, the component should be mostly: load orchestration
(`loadWorkspaceSource`/`loadPdfBytes`/generation guards),
structure edits (page add/delete/rotate/merge — could be an 8th slice
`usePageStructureEdits`), the imperative-handle wiring, and JSX. Target: bring
the file under ~1,500 lines.

## `PdfPageView.tsx`

Tackle after `PdfWorkspace` — it's the rendering surface and higher risk.
Likely seams: base-layer canvas rendering, text layer, the annotation
interaction/hit-testing layer, and ink capture. Extract the annotation
interaction layer first since it's the most self-contained.

## Verification per step

1. `npx tsc -b` clean.
2. `npm test` — all green (currently 84 tests).
3. `npm run lint` — no *new* errors; exhaustive-deps warning count shouldn't
   balloon (extracting into a hook often *reduces* it).
4. Manual smoke for slices 4–7: open a multi-page PDF, annotate, undo/redo,
   save, reopen, verify. There's no DOM test harness (see `CLAUDE.md`), so these
   slices need a human/agent smoke pass, not just unit tests.

## Optional enabler

Consider adding a minimal jsdom + Testing Library setup **before** slice 5–7 so
the history/save extractions get a regression net. This is the same gap that let
the two recent UI bugs ship without a failing test.
