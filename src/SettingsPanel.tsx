import type { ReactNode } from 'react';

export type RgbColor = [number, number, number];

export const inkColors = {
  black: [0.09, 0.11, 0.11],
  blue: [0.26, 0.58, 0.83],
  green: [0.36, 0.7, 0.22],
  red: [0.9, 0.18, 0.16],
  purple: [0.8, 0.25, 0.75],
  yellow: [1, 254 / 255, 78 / 255]
} satisfies Record<string, RgbColor>;

export const annotationColorSwatches: RgbColor[] = [
  inkColors.black,
  inkColors.blue,
  inkColors.green,
  inkColors.red,
  inkColors.purple,
  inkColors.yellow
];

export function SettingsPanelShell({
  children
}: {
  children: ReactNode;
}) {
  return <section className="grid gap-2 text-sm">{children}</section>;
}

export function ColorPalette({
  color,
  label = 'Colour',
  onChange,
  onCommit
}: {
  color: RgbColor;
  label?: string | null;
  onChange: (color: RgbColor) => void;
  onCommit?: () => void;
}) {
  return (
    <div className="grid gap-1 text-xs font-medium text-app-ink">
      {label ? <span>{label}</span> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {annotationColorSwatches.map((swatch) => (
          <button
            aria-label={`Set ${rgbToHex(swatch)}`}
            className="ui-button h-5 w-5 rounded-full border-app-ink/20"
            key={swatch.join('-')}
            onClick={() => {
              onChange(swatch);
              onCommit?.();
            }}
            style={{ background: rgbToHex(swatch) }}
            type="button"
          />
        ))}
        <label
          className="ui-button relative grid h-5 w-5 place-items-center overflow-hidden rounded-full border-app-ink/20 bg-app-ui text-app-ink"
          title="Custom colour"
        >
          <span className="pointer-events-none flex gap-0.5" aria-hidden="true">
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
          </span>
          <input
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Custom colour"
            onChange={(event) => {
              onChange(hexToRgb(event.target.value));
            }}
            type="color"
            value={rgbToHex(color)}
          />
        </label>
      </div>
    </div>
  );
}

export function NumberSetting({
  label,
  max,
  min,
  onChange,
  step,
  value
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs font-medium text-app-ink">
      <span>{label}</span>
      <input
        className="ui-input h-7 w-16 px-2 text-right text-xs font-medium"
        max={max}
        min={min}
        onChange={(event) => {
          const nextValue = Number(event.target.value);
          if (Number.isFinite(nextValue)) {
            onChange(clamp(nextValue, min, max));
          }
        }}
        step={step}
        type="number"
        value={formatValue(value)}
      />
    </label>
  );
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

function formatValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
