export const EAGER_PAGE_LIMIT = 25;
export const LAZY_PAGE_BUFFER = 2;
export const MAX_LOADED_MAIN_PAGES = 100;

export const ACTUAL_SIZE_ZOOM = 1.75;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 6;
export const ZOOM_STEP = 0.15;

export const SIDEBAR_DEFAULT_WIDTH = 208;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

// Extra thumbnail rows rendered above/below the visible scroll range.
export const SIDEBAR_ROW_BUFFER = 4;
// Estimated non-preview chrome height per thumbnail row (button/preview
// padding, margin, page-number label) - approximate, not measured, since
// virtualization only needs a reasonable estimate plus SIDEBAR_ROW_BUFFER
// to tolerate the error, not pixel-perfect row heights.
export const SIDEBAR_ROW_CHROME_HEIGHT = 42;
export const SIDEBAR_MIN_ROW_HEIGHT = 80;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
