// Legibility maths for a colour the reader chose at runtime: `--theme-ink`
// follows the colour scheme, and a reader-chosen fill does not.

export type RgbColor = [number, number, number];

// Must be kept in step with --app-ink-on-light and --app-ink-on-dark in
// src/pdfdocumenteditor/styles.css.
const INK_ON_LIGHT: RgbColor = [0x1c / 255, 0x19 / 255, 0x17 / 255];
const INK_ON_DARK: RgbColor = [1, 1, 1];

/** Channels are 0..1 here, so no /255 normalisation. */
export function relativeLuminance([r, g, b]: RgbColor) {
  const linear = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Both colours must be opaque; flatten a translucent fill first. */
export function contrastRatio(left: RgbColor, right: RgbColor) {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function prefersDarkForegroundOn(color: RgbColor) {
  return (
    contrastRatio(color, INK_ON_LIGHT) >= contrastRatio(color, INK_ON_DARK)
  );
}

/**
 * Anything painted on a fill the theme does not control comes through here,
 * never `--theme-ink`.
 */
export function foregroundOn(color: RgbColor) {
  return prefersDarkForegroundOn(color)
    ? "var(--app-ink-on-light)"
    : "var(--app-ink-on-dark)";
}

/**
 * Flatten a translucent fill against an opaque backdrop: the raw colour
 * inverts `foregroundOn`'s answer at low alpha.
 */
export function flattenOver(
  color: RgbColor,
  backdrop: RgbColor,
  alpha: number,
): RgbColor {
  return [0, 1, 2].map(
    (channel) => color[channel] * alpha + backdrop[channel] * (1 - alpha),
  ) as RgbColor;
}

/** Pushed only as far as `minRatio` needs, so it stays recognisably itself. */
export function ensureContrastAgainst(
  color: RgbColor,
  backdrop: RgbColor,
  minRatio: number,
): RgbColor {
  if (contrastRatio(color, backdrop) >= minRatio) {
    return color;
  }

  const target: RgbColor = prefersDarkForegroundOn(backdrop)
    ? [0, 0, 0]
    : [1, 1, 1];
  const steps = 20;
  for (let step = 1; step < steps; step += 1) {
    const mixed = flattenOver(target, color, step / steps);
    if (contrastRatio(mixed, backdrop) >= minRatio) {
      return mixed;
    }
  }

  return target;
}

export const FOREGROUND_INKS = { light: INK_ON_LIGHT, dark: INK_ON_DARK };
