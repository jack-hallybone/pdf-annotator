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
