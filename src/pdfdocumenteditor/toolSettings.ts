import { annotationColors } from "./annotationColors";
import type { ToolSettings } from "./types";

// The core owns these because they are annotation data; which buttons exist
// and which is selected belong to the host.
export const defaultToolSettings: ToolSettings = {
  highlightColor: annotationColors.yellow,
  highlightOpacity: 0.5,
  highlightWidth: 8,
  drawColor: annotationColors.blue,
  drawOpacity: 1,
  drawWidth: 1,
  eraserWidth: 10,
  textColor: annotationColors.blue,
  textFontSize: 12,
  textOpacity: 1,
  noteColor: annotationColors.yellow,
};
