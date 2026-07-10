import {
  ColorPalette,
  NumberSetting,
  SettingsPanelShell
} from '../SettingsPanel';
import type { Tool, ToolSettings } from '../types';

type ToolSettingsEditorProps = {
  settings: ToolSettings;
  tool: Tool;
  onChange: (update: Partial<ToolSettings>) => void;
  onColorCommit?: () => void;
};

type ColorKey =
  | 'highlightColor'
  | 'drawColor'
  | 'textColor'
  | 'noteColor';
type NumberKey =
  | 'highlightOpacity'
  | 'highlightWidth'
  | 'drawWidth'
  | 'drawOpacity'
  | 'textOpacity'
  | 'textFontSize'
  | 'eraserWidth';

export function ToolSettingsEditor({
  settings,
  tool,
  onChange,
  onColorCommit
}: ToolSettingsEditorProps) {
  const color = (key: ColorKey) => (
    <ColorPalette
      color={settings[key]}
      label={null}
      onChange={(value) => onChange({ [key]: value })}
      onCommit={onColorCommit}
    />
  );
  const number = (
    key: NumberKey,
    label: string,
    min: number,
    max: number,
    step: number
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
      {tool === 'highlight' ? (
        <>
          {color('highlightColor')}
          {number('highlightOpacity', 'Opacity', 0.1, 0.8, 0.05)}
          {number('highlightWidth', 'Stroke', 2, 28, 1)}
        </>
      ) : tool === 'draw' ? (
        <>
          {color('drawColor')}
          {number('drawWidth', 'Stroke', 0.5, 8, 0.1)}
          {number('drawOpacity', 'Opacity', 0.1, 1, 0.05)}
        </>
      ) : tool === 'freeText' ? (
        <>
          {color('textColor')}
          {number('textOpacity', 'Opacity', 0.1, 1, 0.05)}
          {number('textFontSize', 'Size', 8, 48, 1)}
        </>
      ) : tool === 'stickyNote' ? (
        color('noteColor')
      ) : tool === 'eraser' ? (
        number('eraserWidth', 'Size', 6, 48, 1)
      ) : null}
    </SettingsPanelShell>
  );
}
