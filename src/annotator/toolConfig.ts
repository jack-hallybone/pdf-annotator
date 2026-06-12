import type { ComponentType, SVGProps } from 'react';
import {
  Eraser,
  Highlighter,
  LassoSelect,
  MousePointer2,
  PenLine,
  StickyNote,
  TextCursor
} from 'lucide-react';
import { inkColors, rgbToHex } from './SettingsPanel';
import type { Tool, ToolPresetMap, ToolSettings } from './types';

type ToolIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }
>;

export type ToolDefinition = {
  key: string;
  tool: Tool;
  label: string;
  preset?: Partial<ToolSettings>;
  icon: ToolIcon;
};

export const tools: ToolDefinition[] = [
  { key: 'select', tool: 'select', label: 'Select', icon: MousePointer2 },
  {
    key: 'draw-blue',
    tool: 'draw',
    label: 'Blue ink',
    icon: PenLine,
    preset: { drawColor: inkColors.blue }
  },
  {
    key: 'draw-purple',
    tool: 'draw',
    label: 'Purple ink',
    icon: PenLine,
    preset: { drawColor: inkColors.purple }
  },
  { key: 'highlight', tool: 'highlight', label: 'Highlight', icon: Highlighter },
  { key: 'freeText', tool: 'freeText', label: 'Text', icon: TextCursor },
  { key: 'stickyNote', tool: 'stickyNote', label: 'Note', icon: StickyNote },
  { key: 'eraser', tool: 'eraser', label: 'Eraser', icon: Eraser },
  { key: 'lasso', tool: 'lasso', label: 'Lasso', icon: LassoSelect }
];

export const defaultToolSettings: ToolSettings = {
  highlightColor: inkColors.yellow,
  highlightOpacity: 0.5,
  highlightWidth: 8,
  drawColor: inkColors.blue,
  drawOpacity: 1,
  drawWidth: 1,
  eraserWidth: 10,
  textColor: inkColors.blue,
  textFontSize: 12,
  textOpacity: 1,
  noteColor: inkColors.yellow
};

export function createDefaultToolPresets(): ToolPresetMap {
  return tools.reduce<ToolPresetMap>((presets, item) => {
    if (item.tool === 'draw') {
      presets[item.key] = {
        drawColor: item.preset?.drawColor ?? defaultToolSettings.drawColor,
        drawOpacity: defaultToolSettings.drawOpacity,
        drawWidth: defaultToolSettings.drawWidth
      };
      return presets;
    }

    if (item.preset) {
      presets[item.key] = { ...item.preset };
    }

    return presets;
  }, {});
}

export function toolAccent(
  tool: Tool,
  settings: ToolSettings,
  preset?: Partial<ToolSettings>
) {
  switch (tool) {
    case 'highlight':
    case 'textHighlight':
    case 'freehandHighlight':
      return rgbToHex(settings.highlightColor);
    case 'draw':
      return rgbToHex(preset?.drawColor ?? settings.drawColor);
    case 'freeText':
      return rgbToHex(settings.textColor);
    case 'stickyNote':
      return rgbToHex(settings.noteColor);
    case 'eraser':
    case 'lasso':
      return '#111827';
    case 'select':
      return '#334155';
  }
}

export function defaultToolKeyForTool(tool: Tool) {
  return tools.find((item) => item.tool === tool)?.key ?? 'select';
}

export function toolHasSettings(tool: Tool) {
  return tool !== 'select' && tool !== 'lasso';
}

export function isDrawToolKey(toolKey: string) {
  return tools.some((item) => item.key === toolKey && item.tool === 'draw');
}

export function pickDrawSettings(update: Partial<ToolSettings>) {
  const drawUpdate: Partial<ToolSettings> = {};
  if (update.drawColor) {
    drawUpdate.drawColor = update.drawColor;
  }
  if (typeof update.drawOpacity === 'number') {
    drawUpdate.drawOpacity = update.drawOpacity;
  }
  if (typeof update.drawWidth === 'number') {
    drawUpdate.drawWidth = update.drawWidth;
  }
  return drawUpdate;
}
