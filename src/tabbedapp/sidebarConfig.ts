// Host chrome, so host constants: nothing under src/pdfdocumenteditor reads any of
// these.

export const SIDEBAR_DEFAULT_WIDTH = 208;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

// Extra thumbnail rows rendered above/below the visible scroll range.
export const SIDEBAR_ROW_BUFFER = 4;
// Non-preview chrome height per thumbnail row: an estimate, not a measurement
// - SIDEBAR_ROW_BUFFER is what absorbs the error.
export const SIDEBAR_ROW_CHROME_HEIGHT = 42;
export const SIDEBAR_MIN_ROW_HEIGHT = 80;
