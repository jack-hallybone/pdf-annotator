// Re-exported so annotation code has one colour import rather than two.
export type { RgbColor } from "../contrast";
export {
  contrastRatio,
  ensureContrastAgainst,
  flattenOver,
  foregroundOn,
  prefersDarkForegroundOn,
  relativeLuminance,
} from "../contrast";

import type { RgbColor } from "../contrast";

export const annotationColors = {
  black: [0.09, 0.11, 0.11],
  blue: [0.26, 0.58, 0.83],
  green: [0.36, 0.7, 0.22],
  orange: [0.94, 0.51, 0.17],
  purple: [0.8, 0.25, 0.75],
  red: [0.9, 0.18, 0.16],
  yellow: [1, 254 / 255, 78 / 255],
} satisfies Record<string, RgbColor>;

export const annotationColorSwatches: RgbColor[] = [
  annotationColors.black,
  annotationColors.blue,
  annotationColors.purple,
  annotationColors.yellow,
  annotationColors.green,
  annotationColors.orange,
  annotationColors.red,
];

/*
 * 0.8 is the lowest step at which a note's outline and glyph clear WCAG's 3:1
 * floor over its own fill for all seven colours; 0.75 leaves purple short.
 */
export const NOTE_MARK_OPACITY = 0.8;

/* A selected note's outline is heavier, and clears the same floor. */
export const NOTE_MARK_OPACITY_SELECTED = 0.95;

export function rgbToCss([r, g, b]: [number, number, number]) {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

export function rgbToCssWithAlpha(
  [r, g, b]: [number, number, number],
  alpha: number,
) {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${alpha})`;
}

export function rgbToHex([r, g, b]: RgbColor) {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function hexToRgb(hex: string): RgbColor {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  ];
}

export function sameRgbColor(left: RgbColor, right: RgbColor) {
  return left.every(
    (channel, index) => Math.abs(channel - right[index]) < 0.001,
  );
}
