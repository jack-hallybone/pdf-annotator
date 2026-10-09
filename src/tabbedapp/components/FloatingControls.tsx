import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  ArrowLeft,
  ClipboardPaste,
  Eye,
  EyeOff,
  Download,
  Minus,
  MoreVertical,
  MoveHorizontal,
  MoveVertical,
  Percent,
  Plus,
  Printer,
  Redo2,
  RotateCcw,
  Save,
  SavePlus,
  Search,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { rgbToHex } from "../../pdfdocumenteditor";
import { clamp, clampZoom, MAX_ZOOM, MIN_ZOOM } from "../../pdfdocumenteditor";
import {
  highlightIndicatorColor,
  toolAccent,
  toolFillColor,
  toolHasSettings,
  tools,
  type ToolDefinition,
} from "../toolConfig";
import type {
  Tool,
  ToolPresetMap,
  ToolSettings,
} from "../../pdfdocumenteditor";
import { ToolSettingsEditor } from "./ToolSettingsEditor";

const FLOATING_FRAME_CLASS = "floating-frame panel raised z-floating no-print";
const ICON_BUTTON_CLASS = "icon-button ghost icon-center";
const MENU_CLASS = "panel floating menu";

type FloatingToolDockProps = {
  activeTool: Tool;
  activeToolKey: string;
  disabled?: boolean;
  onChangeSettings: (update: Partial<ToolSettings>) => void;
  onCloseSettings: () => void;
  onPasteImageFile: () => void;
  onPickImageFile: () => void;
  onSelectTool: (toolKey: string) => void;
  onToggleSettings: (toolKey: string) => void;
  settings: ToolSettings;
  settingsToolKey: string | null;
  toolDefinitions?: ToolDefinition[];
  toolPresets: ToolPresetMap;
};

export function FloatingToolDock({
  activeTool,
  activeToolKey,
  disabled = false,
  onChangeSettings,
  onCloseSettings,
  onPasteImageFile,
  onPickImageFile,
  onSelectTool,
  onToggleSettings,
  settings,
  settingsToolKey,
  toolDefinitions = tools,
  toolPresets,
}: FloatingToolDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsidePointer(dockRef, Boolean(settingsToolKey), onCloseSettings);

  return (
    <div
      aria-label="Annotation tools"
      className={`${FLOATING_FRAME_CLASS} tool-dock stack xs`}
      ref={dockRef}
      role="toolbar"
    >
      {toolDefinitions.map(({ icon: Icon, key, label, preset, tool }) => {
        const buttonPreset = toolPresets[key] ?? preset;
        const accent = toolAccent(tool, settings, buttonPreset);
        const fill = toolFillColor(tool, settings);
        const active = activeTool === tool && activeToolKey === key;
        const hasSettings = toolHasSettings(tool);
        const opensMenu = tool === "imageStamp";

        return (
          <div className="tool-dock-row row nowrap xs" key={key}>
            <button
              aria-expanded={opensMenu ? settingsToolKey === key : undefined}
              aria-haspopup={opensMenu ? "menu" : undefined}
              aria-label={label}
              aria-pressed={opensMenu ? undefined : active}
              className={`tool-button ghost icon-center ${
                active ? "selected" : ""
              }`}
              disabled={disabled}
              onClick={() => {
                // A second press closes the menu, which ends the image tool like any other way of closing it.
                if (opensMenu && settingsToolKey === key) {
                  onCloseSettings();
                  return;
                }

                onSelectTool(key);
                if (opensMenu) {
                  onToggleSettings(key);
                }
              }}
              title={label}
              type="button"
            >
              {fill ? (
                tool === "stickyNote" ? (
                  <StickyNoteFillIcon fill={fill} size={19} stroke={accent} />
                ) : (
                  <HighlighterFillIcon fill={fill} size={19} stroke={accent} />
                )
              ) : (
                <Icon color={accent} size={19} strokeWidth={2} />
              )}
              <ToolIndicator
                preset={buttonPreset}
                settings={settings}
                tool={tool}
              />
            </button>
            {hasSettings ? (
              <button
                aria-label={`${label} settings`}
                className="tool-settings-button ghost icon-center"
                disabled={disabled}
                onClick={() => {
                  if (!active) {
                    onSelectTool(key);
                  }
                  onToggleSettings(key);
                }}
                title={`${label} settings`}
                type="button"
              >
                <MoreVertical size={14} />
              </button>
            ) : null}
            {!disabled && hasSettings && settingsToolKey === key ? (
              <div className={`${MENU_CLASS} tool-settings-popover`}>
                <ToolSettingsEditor
                  settings={settings}
                  tool={tool}
                  onChange={onChangeSettings}
                  onColorCommit={onCloseSettings}
                />
              </div>
            ) : null}
            {!disabled && opensMenu && settingsToolKey === key ? (
              <div className={`${MENU_CLASS} image-tool-menu`} role="menu">
                <button onClick={onPickImageFile} role="menuitem" type="button">
                  <Upload size={15} />
                  <span>From file...</span>
                </button>
                <button
                  onClick={onPasteImageFile}
                  role="menuitem"
                  type="button"
                >
                  <ClipboardPaste size={15} />
                  <span>Paste from clipboard</span>
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ToolIndicator({
  preset,
  settings,
  tool,
}: {
  preset?: Partial<ToolSettings>;
  settings: ToolSettings;
  tool: Tool;
}) {
  if (tool === "draw") {
    const color = preset?.drawColor ?? settings.drawColor;
    const width = preset?.drawWidth ?? settings.drawWidth;
    return (
      <span
        className="tool-indicator"
        style={{
          backgroundColor: rgbToHex(color),
          height: Math.max(2, Math.min(6, width)),
          opacity: preset?.drawOpacity ?? settings.drawOpacity,
        }}
      />
    );
  }

  if (tool === "highlight") {
    const width = Math.max(2, Math.min(6, settings.highlightWidth / 2));
    return (
      <span
        className="tool-indicator"
        style={{
          backgroundColor: highlightIndicatorColor(settings),
          height: width,
        }}
      />
    );
  }

  return null;
}

// Lucide's Highlighter/StickyNote redrawn with one path split out from the rest: the mark left by the highlighter, and the note's own body, are each a closed shape a reader's colour can fill - the icon otherwise stays a plain ink outline, like every other tool. SVG fill treats an open path as implicitly closed, so the highlighter's mark needs no explicit "Z".
function HighlighterFillIcon({
  fill,
  size,
  stroke,
}: {
  fill: string;
  size: number;
  stroke: string;
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="m9 11-6 6v3h9l3-3" fill={fill} />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  );
}

function StickyNoteFillIcon({
  fill,
  size,
  stroke,
}: {
  fill: string;
  size: number;
  stroke: string;
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
    >
      <path
        d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"
        fill={fill}
      />
      <path d="M15 3v5a1 1 0 0 0 1 1h5" />
    </svg>
  );
}

type FloatingZoomControlsProps = {
  activePageIndex: number;
  disabled?: boolean;
  onDefaultZoom: () => void;
  onFitHeight: () => void;
  onFitWidth: () => void;
  onJumpToPage: (pageNumber: number) => void;
  onSetZoom: (scale: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  pageCount: number;
  scale: number;
};

export function FloatingZoomControls({
  activePageIndex,
  disabled = false,
  onDefaultZoom,
  onFitHeight,
  onFitWidth,
  onJumpToPage,
  onSetZoom,
  onZoomIn,
  onZoomOut,
  pageCount,
  scale,
}: FloatingZoomControlsProps) {
  const zoomPanelRef = useRef<HTMLDivElement>(null);
  const [zoomPanelOpen, setZoomPanelOpen] = useState(false);
  const [pageText, setPageText] = useState(String(activePageIndex + 1));
  const [zoomText, setZoomText] = useState(formatZoom(scale));
  useCloseOnOutsidePointer(zoomPanelRef, zoomPanelOpen, () =>
    setZoomPanelOpen(false),
  );

  useEffect(() => {
    setPageText(String(activePageIndex + 1));
  }, [activePageIndex]);

  useEffect(() => {
    setZoomText(formatZoom(scale));
  }, [scale]);

  function commitPage() {
    const rawPage = Number(pageText);
    if (!Number.isFinite(rawPage)) {
      setPageText(String(activePageIndex + 1));
      return;
    }

    const pageNumber = clamp(Math.trunc(rawPage), 1, Math.max(1, pageCount));
    setPageText(String(pageNumber));
    onJumpToPage(pageNumber);
  }

  function commitZoom() {
    const percent = Number.parseFloat(zoomText.replace("%", ""));
    if (!Number.isFinite(percent)) {
      setZoomText(formatZoom(scale));
      return;
    }

    const nextScale = clampZoom(percent / 100);
    setZoomText(formatZoom(nextScale));
    onSetZoom(nextScale);
  }

  function applyZoomPreset(action: () => void) {
    action();
    setZoomPanelOpen(false);
  }

  return (
    <div
      aria-label="Zoom"
      className={`${FLOATING_FRAME_CLASS} zoom-controls row nowrap xs`}
      ref={zoomPanelRef}
      role="toolbar"
    >
      <button
        aria-label="Zoom out"
        className={ICON_BUTTON_CLASS}
        disabled={disabled || scale <= MIN_ZOOM}
        onClick={onZoomOut}
        title="Zoom out"
        type="button"
      >
        <Minus size={16} />
      </button>
      <button
        aria-expanded={zoomPanelOpen}
        aria-label="Zoom settings"
        className="zoom-button ghost"
        disabled={disabled}
        onClick={() => setZoomPanelOpen((open) => !open)}
        title="Zoom settings"
        type="button"
      >
        {formatZoom(scale)}
      </button>
      <button
        aria-label="Zoom in"
        className={ICON_BUTTON_CLASS}
        disabled={disabled || scale >= MAX_ZOOM}
        onClick={onZoomIn}
        title="Zoom in"
        type="button"
      >
        <Plus size={16} />
      </button>
      <div className="page-jump-control row nowrap xs">
        <span>Page</span>
        <input
          aria-label="Page number"
          className="page-number-input"
          disabled={disabled}
          inputMode="numeric"
          max={pageCount}
          min={1}
          onBlur={commitPage}
          onChange={(event) => setPageText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          value={pageText}
        />
        <span>of {pageCount}</span>
      </div>
      {!disabled && zoomPanelOpen ? (
        <div className={`${MENU_CLASS} zoom-popover`}>
          <label className="menu-item number-setting">
            <span>Zoom</span>
            <input
              aria-label="Zoom percent"
              className="number-setting-input"
              inputMode="decimal"
              onBlur={commitZoom}
              onChange={(event) => setZoomText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitZoom();
                  setZoomPanelOpen(false);
                }
              }}
              value={zoomText}
            />
          </label>
          <span className="menu-separator" role="separator" />
          <button onClick={() => applyZoomPreset(onFitWidth)} type="button">
            <MoveHorizontal size={15} />
            <span>Fit width</span>
          </button>
          <button onClick={() => applyZoomPreset(onFitHeight)} type="button">
            <MoveVertical size={15} />
            <span>Fit height</span>
          </button>
          <button
            onClick={() => applyZoomPreset(() => onSetZoom(1))}
            type="button"
          >
            <Percent size={15} />
            <span>100%</span>
          </button>
          <button onClick={() => applyZoomPreset(onDefaultZoom)} type="button">
            <RotateCcw size={15} />
            <span>Default</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

// The zoom box carries its unit in its text, as the zoom button does; commitZoom strips it before parsing.
function formatZoom(scale: number) {
  return `${Math.round(scale * 100)}%`;
}

type FloatingDocumentControlsProps = {
  busy: boolean;
  onClosePdf: () => void;
  onDownload?: () => void;
  // Ctrl+F's find bar, for a reader with a pen or a finger and no keyboard.
  onFind?: () => void;
  onPrint?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  saveLabel: string;
  showCloseButton?: boolean;
  onToggleAnnotations: () => void;
  showAnnotations: boolean;
};

export function FloatingDocumentControls({
  busy,
  onClosePdf,
  onDownload,
  onFind,
  onPrint,
  onSave,
  onSaveAs,
  saveLabel,
  showCloseButton = true,
  onToggleAnnotations,
  showAnnotations,
}: FloatingDocumentControlsProps) {
  return (
    <div
      aria-label="Document actions"
      className={`${FLOATING_FRAME_CLASS} document-controls row nowrap xs`}
      role="toolbar"
    >
      {onFind ? (
        <IconButton label="Find in document" onClick={onFind}>
          <Search size={16} />
        </IconButton>
      ) : null}
      <IconButton
        disabled={busy}
        label={
          showAnnotations
            ? "Hide annotations on screen and when printing"
            : "Show annotations on screen and when printing"
        }
        onClick={onToggleAnnotations}
      >
        {showAnnotations ? <EyeOff size={16} /> : <Eye size={16} />}
      </IconButton>
      {onSave ? (
        <IconButton disabled={busy} label={saveLabel} onClick={onSave}>
          <Save size={16} />
        </IconButton>
      ) : null}
      {onSaveAs ? (
        <IconButton disabled={busy} label="Save As..." onClick={onSaveAs}>
          <SavePlus size={16} />
        </IconButton>
      ) : null}
      {onDownload ? (
        <IconButton
          disabled={busy}
          label="Download a copy"
          onClick={onDownload}
        >
          <Download size={16} />
        </IconButton>
      ) : null}
      {onPrint ? (
        <IconButton disabled={busy} label="Print" onClick={onPrint}>
          <Printer size={16} />
        </IconButton>
      ) : null}
      {showCloseButton ? (
        <IconButton disabled={busy} label="Close" onClick={onClosePdf}>
          <X size={16} />
        </IconButton>
      ) : null}
    </div>
  );
}

type FloatingBackControlProps = {
  disabled?: boolean;
  onBack: () => void;
  pageIndex: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  // Undo and redo hold this corner whenever the document can be edited, so this sits above them.
  stacked: boolean;
};

// Mounted only while there is somewhere to go back to, so it can say where.
export function FloatingBackControl({
  disabled = false,
  onBack,
  pageIndex,
  sidebarOpen,
  sidebarWidth,
  stacked,
}: FloatingBackControlProps) {
  return (
    <div
      className={`${FLOATING_FRAME_CLASS} back-control${stacked ? " stacked" : ""}`}
      style={{ left: sidebarOpen ? sidebarWidth + 24 : 12 }}
    >
      <button
        className="back-button ghost"
        disabled={disabled}
        onClick={onBack}
        type="button"
      >
        <ArrowLeft size={16} />
        Back to page {pageIndex + 1}
      </button>
    </div>
  );
}

type FloatingHistoryControlsProps = {
  canRedo: boolean;
  canUndo: boolean;
  disabled?: boolean;
  onRedo: () => void;
  onUndo: () => void;
  sidebarOpen: boolean;
  sidebarWidth: number;
};

export function FloatingHistoryControls({
  canRedo,
  canUndo,
  disabled = false,
  onRedo,
  onUndo,
  sidebarOpen,
  sidebarWidth,
}: FloatingHistoryControlsProps) {
  return (
    <div
      aria-label="Undo and redo"
      className={`${FLOATING_FRAME_CLASS} history-controls row nowrap xs`}
      role="toolbar"
      style={{ left: sidebarOpen ? sidebarWidth + 24 : 12 }}
    >
      <button
        aria-label="Undo"
        className={ICON_BUTTON_CLASS}
        disabled={disabled || !canUndo}
        onClick={onUndo}
        title="Undo"
        type="button"
      >
        <Undo2 size={16} />
      </button>
      <button
        aria-label="Redo"
        className={ICON_BUTTON_CLASS}
        disabled={disabled || !canRedo}
        onClick={onRedo}
        title="Redo"
        type="button"
      >
        <Redo2 size={16} />
      </button>
    </div>
  );
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={ICON_BUTTON_CLASS}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function useCloseOnOutsidePointer(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target || !ref.current?.contains(target)) {
        onClose();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [enabled, onClose, ref]);
}
