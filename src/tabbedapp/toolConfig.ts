import type { ComponentType, SVGProps } from "react";
import {
  Eraser,
  Highlighter,
  Image,
  LassoSelect,
  MousePointer2,
  PenLine,
  StickyNote,
  TextCursor,
} from "lucide-react";
import {
  annotationColors,
  ensureContrastAgainst,
  flattenOver,
  rgbToHex,
  sameRgbColor,
} from "../pdfdocumenteditor/annotationColors";
import type { RgbColor } from "../pdfdocumenteditor/annotationColors";
import { defaultToolSettings } from "../pdfdocumenteditor/toolSettings";
import type {
  Tool,
  ToolPresetMap,
  ToolSettings,
} from "../pdfdocumenteditor/types";

export { defaultToolSettings };

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
  { key: "select", tool: "select", label: "Select", icon: MousePointer2 },
  // Labelled by position, not colour, and the position is a UI affordance only
  // that must not reach annotation data.
  {
    key: "pen-1",
    tool: "draw",
    label: "Pen 1",
    icon: PenLine,
    preset: { drawColor: annotationColors.blue },
  },
  {
    key: "pen-2",
    tool: "draw",
    label: "Pen 2",
    icon: PenLine,
    preset: { drawColor: annotationColors.red },
  },
  {
    key: "pen-3",
    tool: "draw",
    label: "Pen 3",
    icon: PenLine,
    preset: { drawColor: annotationColors.green },
  },
  {
    key: "highlight",
    tool: "highlight",
    label: "Highlight",
    icon: Highlighter,
  },
  { key: "freeText", tool: "freeText", label: "Text", icon: TextCursor },
  { key: "stickyNote", tool: "stickyNote", label: "Note", icon: StickyNote },
  { key: "imageStamp", tool: "imageStamp", label: "Image", icon: Image },
  { key: "eraser", tool: "eraser", label: "Eraser", icon: Eraser },
  { key: "lasso", tool: "lasso", label: "Lasso", icon: LassoSelect },
];

export function createDefaultToolPresets(): ToolPresetMap {
  return tools.reduce<ToolPresetMap>((presets, item) => {
    if (item.tool === "draw") {
      presets[item.key] = {
        drawColor: item.preset?.drawColor ?? defaultToolSettings.drawColor,
        drawOpacity: defaultToolSettings.drawOpacity,
        drawWidth: defaultToolSettings.drawWidth,
      };
      return presets;
    }

    if (item.preset) {
      presets[item.key] = { ...item.preset };
    }

    return presets;
  }, {});
}

// A tool's icon is a thin stroke on --theme-surface, not a wash over paper -
// a pale reader-chosen colour can fail contrast here even though the same
// colour reads fine painted translucent on a page. Only the icon is
// darkened; the colour a reader picks is never touched. Highlight and
// stickyNote sidestep this instead (see toolFillColor): their icons carry
// the true colour as a small fill, not as the whole icon's stroke.
const ICON_CONTRAST_FLOOR = 3;
const WHITE_SURFACE: RgbColor = [1, 1, 1];

function iconAccent(color: RgbColor) {
  const safe = ensureContrastAgainst(color, WHITE_SURFACE, ICON_CONTRAST_FLOOR);
  return sameRgbColor(safe, color)
    ? rgbToHex(color)
    : `light-dark(${rgbToHex(safe)}, ${rgbToHex(color)})`;
}

// Highlight/stickyNote go the other way: their stroke stays plain ink, like
// every other tool, so it's the fill (the one colour a reader chooses) that
// bends for contrast - against --theme-ink's own two values, since that's
// what it now has to sit next to. Ink is dark in light mode (already
// plenty of contrast against any fill) and light in dark mode, where the
// default yellow fill measures only ~1.15:1 against it.
const THEME_INK_LIGHT: RgbColor = [0x23 / 255, 0x1d / 255, 0x22 / 255];
const THEME_INK_DARK: RgbColor = [0xed / 255, 0xe5 / 255, 0xeb / 255];

function fillAccent(color: RgbColor) {
  const safeForLight = ensureContrastAgainst(
    color,
    THEME_INK_LIGHT,
    ICON_CONTRAST_FLOOR,
  );
  const safeForDark = ensureContrastAgainst(
    color,
    THEME_INK_DARK,
    ICON_CONTRAST_FLOOR,
  );
  return sameRgbColor(safeForLight, color) && sameRgbColor(safeForDark, color)
    ? rgbToHex(color)
    : `light-dark(${rgbToHex(safeForLight)}, ${rgbToHex(safeForDark)})`;
}

export function toolAccent(
  tool: Tool,
  settings: ToolSettings,
  preset?: Partial<ToolSettings>,
) {
  switch (tool) {
    case "draw":
      return iconAccent(preset?.drawColor ?? settings.drawColor);
    case "freeText":
      return iconAccent(settings.textColor);
    case "highlight":
    case "textHighlight":
    case "freehandHighlight":
    case "stickyNote":
    case "eraser":
    case "lasso":
    case "imageStamp":
    case "select":
      return "var(--theme-ink)";
  }
}

// The colour for the one fillable region of an icon that has one (the
// highlighter's mark, the note's body) - undefined for every other tool,
// which has no such region and stays plain ink. Bent for contrast against
// the icon's own ink stroke (see fillAccent) rather than left as the true
// reader-chosen colour: unlike a mark painted on a page, there's no page
// colour here to look wrong against, and the icon has to stay legible.
export function toolFillColor(tool: Tool, settings: ToolSettings) {
  switch (tool) {
    case "highlight":
    case "textHighlight":
    case "freehandHighlight":
      return fillAccent(settings.highlightColor);
    case "stickyNote":
      return fillAccent(settings.noteColor);
    default:
      return undefined;
  }
}

const PAPER_WHITE: RgbColor = [1, 1, 1];

// A highlight always lands on a white page, so its toolbar preview is
// flattened against paper rather than CSS opacity over the button's own
// (theme-dependent) background - otherwise the same colour and opacity
// read as a different shade in dark mode than the highlight it previews.
export function highlightIndicatorColor(settings: ToolSettings) {
  return rgbToHex(
    flattenOver(
      settings.highlightColor,
      PAPER_WHITE,
      settings.highlightOpacity,
    ),
  );
}

export function defaultToolKeyForTool(tool: Tool) {
  return tools.find((item) => item.tool === tool)?.key ?? "select";
}

export function toolHasSettings(tool: Tool) {
  return tool !== "select" && tool !== "lasso" && tool !== "imageStamp";
}

export function isDrawToolKey(toolKey: string) {
  return tools.some((item) => item.key === toolKey && item.tool === "draw");
}

export function pickDrawSettings(update: Partial<ToolSettings>) {
  const drawUpdate: Partial<ToolSettings> = {};
  if (update.drawColor) {
    drawUpdate.drawColor = update.drawColor;
  }
  if (typeof update.drawOpacity === "number") {
    drawUpdate.drawOpacity = update.drawOpacity;
  }
  if (typeof update.drawWidth === "number") {
    drawUpdate.drawWidth = update.drawWidth;
  }
  return drawUpdate;
}
