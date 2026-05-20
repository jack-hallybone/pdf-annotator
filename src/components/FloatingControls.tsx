import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import {
  Eye,
  EyeOff,
  Minus,
  MoreVertical,
  Plus,
  Printer,
  Redo2,
  Save,
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
  toolButtonActive,
  toolHasSettings,
  tools
} from '../toolConfig';
import type { Tool, ToolPresetMap, ToolSettings } from '../types';
import { ToolSettingsEditor } from './ToolSettingsEditor';

const FLOATING_FRAME_CLASS =
  'ui-frame screen-only absolute z-40 p-1 text-app-ink';
const ICON_BUTTON_CLASS =
  'ui-button grid h-8 w-8 place-items-center disabled:cursor-not-allowed disabled:opacity-40';
const MENU_BUTTON_CLASS =
  'ui-button h-8 rounded px-2 text-left font-medium';
const POPOVER_CLASS =
  'ui-panel absolute p-2 text-xs font-medium text-app-ink';

type FloatingToolDockProps = {
  activeTool: Tool;
  activeToolKey: string;
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
      className={`${FLOATING_FRAME_CLASS} right-2 top-1/2 flex -translate-y-1/2 flex-col gap-1 sm:right-8`}
      ref={dockRef}
    >
      {tools.map(({ icon: Icon, key, label, preset, tool }) => {
        const buttonPreset = toolPresets[key] ?? preset;
        const accent = toolAccent(tool, settings, buttonPreset);
        const active = toolButtonActive(activeTool, activeToolKey, tool, key);
        const hasSettings = toolHasSettings(tool);

        return (
          <div className="relative flex items-center gap-1" key={key}>
            <button
              aria-label={label}
              aria-pressed={active}
              className={`ui-button relative grid h-10 w-10 place-items-center ${
                active ? 'ui-button-active' : ''
              }`}
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
                className="ui-button grid h-7 w-5 place-items-center"
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
            {hasSettings && settingsToolKey === key ? (
              <div className={`${POPOVER_CLASS} right-full top-0 mr-2 w-max min-w-44 max-w-[calc(100vw-5rem)]`}>
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
        className="absolute bottom-1 left-2 right-2 rounded-full"
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
        className="absolute bottom-1 left-2 right-2 rounded-full"
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
      className={`${FLOATING_FRAME_CLASS} bottom-3 right-2 flex items-center gap-1 text-xs font-medium sm:right-8`}
      ref={zoomPanelRef}
    >
      <button
        className={ICON_BUTTON_CLASS}
        disabled={scale <= MIN_ZOOM}
        onClick={onZoomOut}
        title="Zoom out"
        type="button"
      >
        <Minus size={16} />
      </button>
      <button
        className="ui-button h-8 min-w-14 px-2 font-medium"
        onClick={() => setZoomPanelOpen((open) => !open)}
        title="Zoom settings"
        type="button"
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        className={ICON_BUTTON_CLASS}
        disabled={scale >= MAX_ZOOM}
        onClick={onZoomIn}
        title="Zoom in"
        type="button"
      >
        <Plus size={16} />
      </button>
      <div className="ml-1 flex h-8 items-center gap-1 border-l border-app-ink/12 pl-2 pr-2">
        <span>Page</span>
        <input
          aria-label="Page number"
          className="ui-input h-6 w-9 px-1 text-center font-medium"
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
      {zoomPanelOpen ? (
        <div className={`${POPOVER_CLASS} bottom-full right-0 mb-2 w-40`}>
          <label className="ui-input mb-2 flex h-8 items-center px-2">
            <input
              aria-label="Zoom percent"
              className="min-w-0 flex-1 bg-transparent text-right font-medium outline-none"
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
            <span className="pl-1 text-app-ink/70">%</span>
          </label>
          <div className="grid grid-cols-2 gap-1">
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
  onPrint: () => void;
  onSave: () => void;
  onToggleAnnotations: () => void;
  showAnnotations: boolean;
};

export function FloatingDocumentControls({
  busy,
  onClosePdf,
  onPrint,
  onSave,
  onToggleAnnotations,
  showAnnotations
}: FloatingDocumentControlsProps) {
  return (
    <div className={`${FLOATING_FRAME_CLASS} right-2 top-3 flex items-center gap-1 sm:right-8`}>
      <IconButton
        label={showAnnotations ? 'Hide annotations' : 'Show annotations'}
        onClick={onToggleAnnotations}
      >
        {showAnnotations ? <EyeOff size={16} /> : <Eye size={16} />}
      </IconButton>
      <IconButton disabled={busy} label="Save PDF" onClick={onSave}>
        <Save size={16} />
      </IconButton>
      <IconButton disabled={busy} label="Print PDF" onClick={onPrint}>
        <Printer size={16} />
      </IconButton>
      <IconButton disabled={busy} label="Close PDF" onClick={onClosePdf}>
        <X size={16} />
      </IconButton>
    </div>
  );
}

type FloatingHistoryControlsProps = {
  canRedo: boolean;
  canUndo: boolean;
  onRedo: () => void;
  onUndo: () => void;
  sidebarOpen: boolean;
  sidebarWidth: number;
};

export function FloatingHistoryControls({
  canRedo,
  canUndo,
  onRedo,
  onUndo,
  sidebarOpen,
  sidebarWidth
}: FloatingHistoryControlsProps) {
  return (
    <div
      className={`${FLOATING_FRAME_CLASS} bottom-3 flex items-center gap-1`}
      style={{ left: sidebarOpen ? sidebarWidth + 24 : 12 }}
    >
      <button
        className={ICON_BUTTON_CLASS}
        disabled={!canUndo}
        onClick={onUndo}
        title="Undo"
        type="button"
      >
        <Undo2 size={16} />
      </button>
      <button
        className={ICON_BUTTON_CLASS}
        disabled={!canRedo}
        onClick={onRedo}
        title="Redo"
        type="button"
      >
        <Redo2 size={16} />
      </button>
    </div>
  );
}

type PageLoadNoticeProps = {
  loadedPageCount: number;
  pageCount: number;
};

export function PageLoadNotice({
  loadedPageCount,
  pageCount
}: PageLoadNoticeProps) {
  return (
    <div className="screen-only absolute left-14 right-14 top-2 z-40 flex items-center justify-center sm:left-1/2 sm:right-auto sm:top-3 sm:-translate-x-1/2">
      <div
        className="ui-frame max-w-full px-3 py-2 text-xs font-medium text-app-ink"
        title="Pages are loading."
      >
        {loadedPageCount} of {pageCount} pages loaded
      </div>
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
