import type { ReactNode } from 'react';
import {
  annotationColorSwatches,
  hexToRgb,
  rgbToHex,
  sameRgbColor
} from './annotationColors';
import type { RgbColor } from './annotationColors';
export type { RgbColor } from './annotationColors';

export function SettingsPanelShell({
  children
}: {
  children: ReactNode;
}) {
  return <section className="settings-panel">{children}</section>;
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
  const customColorSelected = !annotationColorSwatches.some((swatch) =>
    sameRgbColor(color, swatch)
  );

  return (
    <div className="settings-field">
      {label ? <span>{label}</span> : null}
      <div className="color-palette">
        {annotationColorSwatches.map((swatch) => {
          const selected = sameRgbColor(color, swatch);
          return (
            <button
              aria-label={`Set ${rgbToHex(swatch)}`}
              aria-pressed={selected}
              className={`color-swatch ui-button ${
                selected ? 'color-swatch-active' : ''
              }`}
              key={swatch.join('-')}
              onClick={() => {
                onChange(swatch);
                onCommit?.();
              }}
              style={{ background: rgbToHex(swatch) }}
              type="button"
            />
          );
        })}
        <label
          className={`color-picker-button ui-button ${
            customColorSelected ? 'color-swatch-active' : ''
          }`}
          title="Custom colour"
        >
          <span className="color-picker-dots" aria-hidden="true">
            <span className="color-picker-dot" />
            <span className="color-picker-dot" />
            <span className="color-picker-dot" />
          </span>
          <input
            className="color-picker-input"
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
    <label className="number-setting">
      <span>{label}</span>
      <input
        className="number-setting-input ui-input"
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

function formatValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
