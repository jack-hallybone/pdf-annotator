import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  annotationColorSwatches,
  hexToRgb,
  rgbToHex,
  sameRgbColor,
} from "./annotationColors";
import type { RgbColor } from "./annotationColors";
import { clamp } from "./viewerConfig";
export type { RgbColor } from "./annotationColors";

export function SettingsPanelShell({ children }: { children: ReactNode }) {
  return <section className="settings-panel">{children}</section>;
}

export function ColorPalette({
  color,
  label = "Colour",
  onChange,
  onCommit,
}: {
  color: RgbColor;
  label?: string | null;
  onChange: (color: RgbColor) => void;
  onCommit?: () => void;
}) {
  const customColorSelected = !annotationColorSwatches.some((swatch) =>
    sameRgbColor(color, swatch),
  );

  return (
    <div className="field settings-field">
      {label ? <span className="field-label">{label}</span> : null}
      <div className="color-palette">
        {annotationColorSwatches.map((swatch) => {
          const selected = sameRgbColor(color, swatch);
          return (
            <button
              aria-label={`Set ${rgbToHex(swatch)}`}
              aria-pressed={selected}
              className={`color-swatch ${selected ? "color-swatch-active" : ""}`}
              key={swatch.join("-")}
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
          className={`color-picker-button ${
            customColorSelected ? "color-swatch-active" : ""
          }`}
          title="Custom colour"
        >
          <MoreHorizontal
            aria-hidden="true"
            className="color-picker-icon"
            size={14}
          />
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
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  return (
    <label className="field number-setting row nowrap">
      <span className="field-label">{label}</span>
      <input
        className="number-setting-input"
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
