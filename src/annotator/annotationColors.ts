export type RgbColor = [number, number, number];

export const annotationColors = {
  black: [0.09, 0.11, 0.11],
  blue: [0.26, 0.58, 0.83],
  green: [0.36, 0.7, 0.22],
  orange: [0.94, 0.51, 0.17],
  purple: [0.8, 0.25, 0.75],
  red: [0.9, 0.18, 0.16],
  yellow: [1, 254 / 255, 78 / 255]
} satisfies Record<string, RgbColor>;

export const annotationColorSwatches: RgbColor[] = [
  annotationColors.black,
  annotationColors.blue,
  annotationColors.purple,
  annotationColors.yellow,
  annotationColors.green,
  annotationColors.orange,
  annotationColors.red
];

export function rgbToCss([r, g, b]: [number, number, number]) {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(
    b * 255
  )})`;
}

export function rgbToCssWithAlpha(
  [r, g, b]: [number, number, number],
  alpha: number
) {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(
    b * 255
  )} / ${alpha})`;
}

export function rgbToHex([r, g, b]: RgbColor) {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

export function hexToRgb(hex: string): RgbColor {
  const normalized = hex.replace('#', '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255
  ];
}

export function sameRgbColor(left: RgbColor, right: RgbColor) {
  return left.every(
    (channel, index) => Math.abs(channel - right[index]) < 0.001
  );
}
