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

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
