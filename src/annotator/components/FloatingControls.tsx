import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import {
  Eye,
  EyeOff,
  Download,
  Minus,
  MoreVertical,
  Plus,
  Printer,
  Redo2,
  Save,
  SaveAll,
  Undo2,
  X
} from 'lucide-react';
import { rgbToHex } from '../SettingsPanel';
import {
  clamp,
  MAX_ZOOM,
  MIN_ZOOM
} from '../viewerConfig';
import {
  toolAccent,
  toolHasSettings,
  tools
} from '../toolConfig';
import type { Tool, ToolPresetMap, ToolSettings } from '../types';
import { ToolSettingsEditor } from './ToolSettingsEditor';

const FLOATING_FRAME_CLASS = 'floating-frame ui-frame screen-only';
const ICON_BUTTON_CLASS = 'icon-button ui-button';
const MENU_BUTTON_CLASS = 'menu-button ui-button';
const POPOVER_CLASS = 'floating-popover ui-panel';

type FloatingToolDockProps = {
  activeTool: Tool;
  activeToolKey: string;
  disabled?: boolean;
  onChangeSettings: (update: Partial<ToolSettings>) => void;
  onCloseSettings: () => void;
  onSelectTool: (toolKey: string) => void;
  onToggleSettings: (toolKey: string) => void;
  settings: ToolSettings;
  settingsToolKey: string | null;
  toolPresets: ToolPresetMap;
};

export function FloatingToolDock({
  activeTool,
  activeToolKey,
  disabled = false,
  onChangeSettings,
  onCloseSettings,
  onSelectTool,
  onToggleSettings,
  settings,
  settingsToolKey,
  toolPresets
}: FloatingToolDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsidePointer(dockRef, Boolean(settingsToolKey), onCloseSettings);

  return (
    <div
      className={`${FLOATING_FRAME_CLASS} tool-dock`}
      ref={dockRef}
    >
      {tools.map(({ icon: Icon, key, label, preset, tool }) => {
        const buttonPreset = toolPresets[key] ?? preset;
        const accent = toolAccent(tool, settings, buttonPreset);
        const active = activeTool === tool && activeToolKey === key;
        const hasSettings = toolHasSettings(tool);

        return (
          <div className="tool-dock-row" key={key}>
            <button
              aria-label={label}
              aria-pressed={active}
              className={`tool-button ui-button ${
                active ? 'ui-button-active' : ''
              }`}
              disabled={disabled}
              onClick={() => onSelectTool(key)}
              title={label}
              type="button"
            >
              <Icon color={accent} size={19} strokeWidth={2} />
              <ToolIndicator
                preset={buttonPreset}
                settings={settings}
                tool={tool}
              />
            </button>
            {hasSettings ? (
              <button
                aria-label={`${label} settings`}
                className="tool-settings-button ui-button"
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
                <MoreVertical size={15} />
              </button>
            ) : null}
            {!disabled && hasSettings && settingsToolKey === key ? (
              <div className={`${POPOVER_CLASS} tool-settings-popover`}>
                <ToolSettingsEditor
                  settings={settings}
                  tool={tool}
                  onChange={onChangeSettings}
                  onColorCommit={onCloseSettings}
                />
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
  tool
}: {
  preset?: Partial<ToolSettings>;
  settings: ToolSettings;
  tool: Tool;
}) {
  if (tool === 'draw') {
    const color = preset?.drawColor ?? settings.drawColor;
    const width = preset?.drawWidth ?? settings.drawWidth;
    return (
      <span
        className="tool-indicator"
        style={{
          backgroundColor: rgbToHex(color),
          height: Math.max(2, Math.min(6, width)),
          opacity: preset?.drawOpacity ?? settings.drawOpacity
        }}
      />
    );
  }

  if (tool === 'highlight') {
    const width = Math.max(2, Math.min(6, settings.highlightWidth / 2));
    return (
      <span
        className="tool-indicator"
        style={{
          backgroundColor: rgbToHex(settings.highlightColor),
          height: width,
          opacity: settings.highlightOpacity
        }}
      />
    );
  }

  return null;
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
  scale
}: FloatingZoomControlsProps) {
  const zoomPanelRef = useRef<HTMLDivElement>(null);
  const [zoomPanelOpen, setZoomPanelOpen] = useState(false);
  const [pageText, setPageText] = useState(String(activePageIndex + 1));
  const [zoomText, setZoomText] = useState(String(Math.round(scale * 100)));
  useCloseOnOutsidePointer(zoomPanelRef, zoomPanelOpen, () =>
    setZoomPanelOpen(false)
  );

  useEffect(() => {
    setPageText(String(activePageIndex + 1));
  }, [activePageIndex]);

  useEffect(() => {
    setZoomText(String(Math.round(scale * 100)));
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
    const percent = Number.parseFloat(zoomText.replace('%', ''));
    if (!Number.isFinite(percent)) {
      setZoomText(String(Math.round(scale * 100)));
      return;
    }

    const nextScale = clampZoom(percent / 100);
    setZoomText(String(Math.round(nextScale * 100)));
    onSetZoom(nextScale);
  }

  function applyZoomPreset(action: () => void) {
    action();
    setZoomPanelOpen(false);
  }

  return (
    <div
      className={`${FLOATING_FRAME_CLASS} zoom-controls`}
      ref={zoomPanelRef}
    >
      <button
        className={ICON_BUTTON_CLASS}
        disabled={disabled || scale <= MIN_ZOOM}
        onClick={onZoomOut}
        title="Zoom out"
        type="button"
      >
        <Minus size={16} />
      </button>
      <button
        className="zoom-button ui-button"
        disabled={disabled}
        onClick={() => setZoomPanelOpen((open) => !open)}
        title="Zoom settings"
        type="button"
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        className={ICON_BUTTON_CLASS}
        disabled={disabled || scale >= MAX_ZOOM}
        onClick={onZoomIn}
        title="Zoom in"
        type="button"
      >
        <Plus size={16} />
      </button>
      <div className="page-jump-control">
        <span>Page</span>
        <input
          aria-label="Page number"
          className="page-number-input ui-input"
          disabled={disabled}
          inputMode="numeric"
          max={pageCount}
          min={1}
          onBlur={commitPage}
          onChange={(event) => setPageText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          value={pageText}
        />
        <span>of {pageCount}</span>
      </div>
      {!disabled && zoomPanelOpen ? (
        <div className={`${POPOVER_CLASS} zoom-popover`}>
          <label className="zoom-percent-field ui-input">
            <input
              aria-label="Zoom percent"
              className="zoom-percent-input"
              inputMode="decimal"
              onBlur={commitZoom}
              onChange={(event) => setZoomText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitZoom();
                  setZoomPanelOpen(false);
                }
              }}
              value={zoomText}
            />
            <span className="zoom-percent-unit">%</span>
          </label>
          <div className="zoom-preset-grid">
            <button
              className={MENU_BUTTON_CLASS}
              onClick={() => applyZoomPreset(onFitWidth)}
              type="button"
            >
              Width
            </button>
            <button
              className={MENU_BUTTON_CLASS}
              onClick={() => applyZoomPreset(onFitHeight)}
              type="button"
            >
              Height
            </button>
            <button
              className={MENU_BUTTON_CLASS}
              onClick={() => applyZoomPreset(() => onSetZoom(1))}
              type="button"
            >
              100%
            </button>
            <button
              className={MENU_BUTTON_CLASS}
              onClick={() => applyZoomPreset(onDefaultZoom)}
              type="button"
            >
              Default
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type FloatingDocumentControlsProps = {
  busy: boolean;
  onClosePdf: () => void;
  onDownload: () => void;
  onPrint: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  saveLabel: string;
  showCloseButton?: boolean;
  onToggleAnnotations: () => void;
  showAnnotations: boolean;
};

export function FloatingDocumentControls({
  busy,
  onClosePdf,
  onDownload,
  onPrint,
  onSave,
  onSaveAs,
  saveLabel,
  showCloseButton = true,
  onToggleAnnotations,
  showAnnotations
}: FloatingDocumentControlsProps) {
  return (
    <div className={`${FLOATING_FRAME_CLASS} document-controls`}>
      <IconButton
        disabled={busy}
        label={showAnnotations ? 'Hide annotations' : 'Show annotations'}
        onClick={onToggleAnnotations}
      >
        {showAnnotations ? <EyeOff size={16} /> : <Eye size={16} />}
      </IconButton>
      <IconButton disabled={busy} label={saveLabel} onClick={onSave}>
        <Save size={16} />
      </IconButton>
      <IconButton disabled={busy} label="Save As..." onClick={onSaveAs}>
        <SaveAll size={16} />
      </IconButton>
      <IconButton disabled={busy} label="Download a copy" onClick={onDownload}>
        <Download size={16} />
      </IconButton>
      <IconButton disabled={busy} label="Print" onClick={onPrint}>
        <Printer size={16} />
      </IconButton>
      {showCloseButton ? (
        <IconButton disabled={busy} label="Close" onClick={onClosePdf}>
          <X size={16} />
        </IconButton>
      ) : null}
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
  sidebarWidth
}: FloatingHistoryControlsProps) {
  return (
    <div
      className={`${FLOATING_FRAME_CLASS} history-controls`}
      style={{ left: sidebarOpen ? sidebarWidth + 24 : 12 }}
    >
      <button
        className={ICON_BUTTON_CLASS}
        disabled={disabled || !canUndo}
        onClick={onUndo}
        title="Undo"
        type="button"
      >
        <Undo2 size={16} />
      </button>
      <button
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


function clampZoom(value: number) {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}

function IconButton({
  children,
  disabled,
  label,
  onClick
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
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
  onClose: () => void
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

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () =>
      window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [enabled, onClose, ref]);
}
