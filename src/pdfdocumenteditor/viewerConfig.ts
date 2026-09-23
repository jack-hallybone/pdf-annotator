/*
 * Not decoration: PdfPageView finds this element again with `closest()` to hang
 * a colour probe on, and the probe must sit inside the editor's subtree to
 * inherit the right `color-scheme`.
 */
export const DOCUMENT_EDITOR_ROOT_CLASS = "pdfdocumenteditor";

/** The row two viewports over one document sit in; styled in styles.css. */
export const SPLIT_VIEW_CLASS = "pdfdocumenteditor-split";

export const EAGER_PAGE_LIMIT = 25;
export const LAZY_PAGE_BUFFER = 2;
export const MAX_LOADED_MAIN_PAGES = 100;

/*
 * 32 is a third of MAX_LOADED_MAIN_PAGES at ~2.4 MB of pdf.js page state each,
 * well above any ordinary viewport but bounding an otherwise unbounded band.
 */
export const MAX_BAND_LOAD_PAGES = 32;

export const ACTUAL_SIZE_ZOOM = 1.75;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 6;
export const ZOOM_STEP = 0.15;

// Here rather than in CSS because the clamp runs before the button exists and
// cannot measure it. Still clears WCAG 2.5.8's 24px floor.
export const SELECTION_BUTTON_SIZE = 28;
export const SELECTION_BUTTON_PAGE_PADDING = 4;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampZoom(value: number) {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}
