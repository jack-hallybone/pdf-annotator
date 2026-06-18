export type AppTheme = Partial<{
  accent: string;
  canvas: string;
  danger: string;
  foreground: string;
  page: string;
  surface: string;
}>;

export function appThemeStyle(theme: AppTheme | null | undefined) {
  if (!theme) {
    return {};
  }

  const style: Record<string, string> = {};
  setThemeColor(style, 'canvas', theme.canvas);
  setThemeColor(style, 'surface', theme.surface);
  setThemeColor(style, 'page', theme.page);
  setThemeColor(style, 'foreground', theme.foreground);
  setThemeColor(style, 'accent', theme.accent);
  setThemeColor(style, 'danger', theme.danger);
  return style;
}

function setThemeColor(
  style: Record<string, string>,
  name: string,
  value: string | undefined
) {
  if (!value) {
    return;
  }

  style[`--app-${name}`] = value;
  const rgb = hexToRgbTriplet(value);
  if (rgb) {
    style[`--app-${name}-rgb`] = rgb;
  }
}

function hexToRgbTriplet(value: string) {
  const hex = value.trim();
  const shortMatch = /^#([\da-f])([\da-f])([\da-f])$/i.exec(hex);
  if (shortMatch) {
    return shortMatch
      .slice(1)
      .map((part) => parseInt(part + part, 16))
      .join(' ');
  }

  const longMatch = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!longMatch) {
    return null;
  }

  return longMatch
    .slice(1)
    .map((part) => parseInt(part, 16))
    .join(' ');
}
