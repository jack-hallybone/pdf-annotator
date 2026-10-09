import {
  ColorPalette,
  NumberSetting,
  SettingsPanelShell,
} from "../../pdfdocumenteditor";
import type { Tool, ToolSettings } from "../../pdfdocumenteditor";

type ToolSettingsEditorProps = {
  settings: ToolSettings;
  tool: Tool;
  onChange: (update: Partial<ToolSettings>) => void;
  onColorCommit?: () => void;
};

type ColorKey = "highlightColor" | "drawColor" | "textColor" | "noteColor";
type NumberKey =
  | "highlightOpacity"
  | "highlightWidth"
  | "drawWidth"
  | "drawOpacity"
  | "textOpacity"
  | "textFontSize"
  | "eraserWidth";

export function ToolSettingsEditor({
  settings,
  tool,
  onChange,
  onColorCommit,
}: ToolSettingsEditorProps) {
  const color = (key: ColorKey) => (
    <ColorPalette
      color={settings[key]}
      onChange={(value) => onChange({ [key]: value })}
      onCommit={onColorCommit}
    />
  );
  // The swatches and the number rows are two groups, split the way a menu splits its own.
  const separator = <span className="menu-separator" role="separator" />;
  const number = (
    key: NumberKey,
    label: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <NumberSetting
      label={label}
      max={max}
      min={min}
      onChange={(value) => onChange({ [key]: value })}
      step={step}
      value={settings[key]}
    />
  );

  return (
    <SettingsPanelShell>
      {tool === "highlight" ? (
        <>
          {color("highlightColor")}
          {separator}
          {number("highlightOpacity", "Opacity", 0.1, 0.8, 0.05)}
          {number("highlightWidth", "Stroke", 2, 28, 1)}
        </>
      ) : tool === "draw" ? (
        <>
          {color("drawColor")}
          {separator}
          {number("drawWidth", "Stroke", 0.5, 8, 0.1)}
          {number("drawOpacity", "Opacity", 0.1, 1, 0.05)}
        </>
      ) : tool === "freeText" ? (
        <>
          {color("textColor")}
          {separator}
          {number("textOpacity", "Opacity", 0.1, 1, 0.05)}
          {number("textFontSize", "Size", 8, 48, 1)}
        </>
      ) : tool === "stickyNote" ? (
        color("noteColor")
      ) : tool === "eraser" ? (
        number("eraserWidth", "Size", 6, 48, 1)
      ) : null}
    </SettingsPanelShell>
  );
}
