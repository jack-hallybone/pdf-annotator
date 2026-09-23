// PdfPageView owns the page-level pointer state; these overlays reach it only
// through props.
import { AlignLeft, Copy, RotateCw, Trash2 } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  NOTE_MARK_OPACITY,
  NOTE_MARK_OPACITY_SELECTED,
  foregroundOn,
  rgbToCss,
} from "../annotationColors";
import {
  annotationBounds,
  boundsForRects,
  resizeImageStampToHeight,
  resizeImageStampToWidth,
} from "../annotationGeometry";
import { FREE_TEXT_LINE_HEIGHT } from "../freeTextLayout";
import { useVisiblePageBounds } from "../pagePointerGeometry";
import {
  annotationContentTransform,
  pdfRectToViewportRect,
} from "../pdfGeometry";
import { millimetresToPdfUnits, pdfUnitsToMillimetres } from "../pdfUnits";
import {
  ColorPalette,
  NumberSetting,
  SettingsPanelShell,
} from "../SettingsPanel";
import type { PageViewport, PdfAnnotation, Tool } from "../types";
import { clamp } from "../viewerConfig";
import {
  AutoFocusTextarea,
  FilledPathShape,
  NotePopover,
  PathShape,
  SELECTION_ACCENT,
  TEXT_HIGHLIGHT_STYLE,
} from "./AnnotationPrimitives";

export type ImageStampResizeHandle = {
  annotationId: string;
  handle: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  pointerId: number;
};

export const AnnotationShape = memo(function AnnotationShape({
  annotation,
  focused,
  onBeginEdit,
  onBeginFreeTextResizeHandleDrag,
  onBeginHighlightHandleDrag,
  onBeginMoveDrag,
  onFocusEnd,
  onHoverChange,
  onSelect,
  onUpdate,
  partOfSelection,
  readOnly,
  scale,
  selected,
  showPopover,
  tool,
  viewport,
}: {
  annotation: PdfAnnotation;
  focused: boolean;
  onBeginEdit: () => void;
  onBeginFreeTextResizeHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: "left" | "right",
    annotationId: string,
  ) => void;
  onBeginHighlightHandleDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: "start" | "end",
    annotationId: string,
  ) => void;
  onBeginMoveDrag: (
    event: React.PointerEvent<SVGGElement>,
    annotationId: string,
  ) => void;
  onFocusEnd: (annotationId: string) => void;
  onHoverChange: (hovered: boolean, annotationId: string) => void;
  onSelect: (annotationId: string) => void;
  onUpdate: (
    annotationId: string,
    updater: (annotation: PdfAnnotation) => PdfAnnotation,
  ) => void;
  // Independent of `selected` below: image stamps always pass
  // `selected={false}` so ImageStampSelectionOverlay can own their outline, but
  // a drag-start still needs true membership, or clicking one image in a
  // multi-selection collapses it to that image.
  partOfSelection: boolean;
  readOnly: boolean;
  scale: number;
  selected: boolean;
  showPopover: boolean;
  tool: Tool;
  viewport: PageViewport;
}) {
  const commonProps = {
    onPointerDown: (event: React.PointerEvent<SVGGElement>) => {
      if (readOnly) {
        return;
      }

      if (tool === "eraser") {
        return;
      }

      const isRightButton = event.button === 2 || (event.buttons & 2) === 2;
      if (isRightButton) {
        return;
      }

      if (tool === "draw") {
        return;
      }

      event.stopPropagation();

      if (tool === "highlight") {
        if (
          annotation.kind === "textHighlight" ||
          annotation.kind === "freehandHighlight" ||
          annotation.kind === "draw"
        ) {
          event.preventDefault();
          if (!selected) {
            onSelect(annotation.id);
          }
          onBeginMoveDrag(event, annotation.id);
        }
        return;
      }

      if (tool !== "select") {
        return;
      }

      event.preventDefault();
      if (!partOfSelection) {
        onSelect(annotation.id);
      }
      onBeginMoveDrag(event, annotation.id);
    },
    onPointerUp: (event: React.PointerEvent<SVGGElement>) => {
      if (readOnly) {
        return;
      }

      if (tool === "freeText" || tool === "stickyNote") {
        event.stopPropagation();
      }
    },
    onPointerEnter: () => onHoverChange(true, annotation.id),
    onPointerLeave: () => onHoverChange(false, annotation.id),
    style: { cursor: "pointer", pointerEvents: "auto" as const },
  };

  switch (annotation.kind) {
    case "textHighlight":
      return (
        <g {...commonProps}>
          {annotation.rects.map((rect, index) => {
            const bounds = pdfRectToViewportRect(rect, viewport);
            return (
              <g key={`${annotation.id}-${index}`}>
                {/* The visible fill is painted on the highlight canvas layer
                    (see renderTextHighlightCanvas) so its multiply blend can
                    reach the real page content - an outermost <svg> always
                    isolates blend modes, so this rect only exists as an
                    invisible hit target for selecting/dragging. */}
                <rect
                  fill={rgbToCss(annotation.color)}
                  height={bounds.height}
                  style={{ opacity: 0, pointerEvents: "all" }}
                  width={bounds.width}
                  x={bounds.x}
                  y={bounds.y}
                />
                {selected ? (
                  <rect
                    fill="none"
                    height={bounds.height}
                    stroke={SELECTION_ACCENT}
                    strokeDasharray="4 3"
                    strokeWidth="1.5"
                    width={bounds.width}
                    x={bounds.x}
                    y={bounds.y}
                  />
                ) : null}
              </g>
            );
          })}
          {selected ? (
            <TextHighlightHandles
              annotation={annotation}
              onBeginDrag={(event, handle) =>
                onBeginHighlightHandleDrag(event, handle, annotation.id)
              }
              viewport={viewport}
            />
          ) : null}
        </g>
      );

    case "draw":
    case "freehandHighlight":
      return (
        <g {...commonProps}>
          {annotation.paths.map((path, index) => {
            const filledHighlight =
              annotation.kind === "freehandHighlight" &&
              annotation.filled === true;
            return (
              <g key={`${annotation.id}-${index}`}>
                {selected ? (
                  <PathShape
                    color={SELECTION_ACCENT}
                    opacity={0.28}
                    points={path}
                    viewport={viewport}
                    width={annotation.width * scale + 8}
                  />
                ) : null}
                {filledHighlight ? (
                  <FilledPathShape
                    color={rgbToCss(annotation.color)}
                    opacity={annotation.opacity}
                    points={path}
                    viewport={viewport}
                  />
                ) : (
                  <PathShape
                    color={rgbToCss(annotation.color)}
                    opacity={annotation.opacity}
                    points={path}
                    style={
                      annotation.kind === "freehandHighlight"
                        ? TEXT_HIGHLIGHT_STYLE
                        : undefined
                    }
                    viewport={viewport}
                    width={annotation.width * scale}
                  />
                )}
              </g>
            );
          })}
        </g>
      );

    case "freeText": {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      const { localWidth, localHeight, transform } = annotationContentTransform(
        rect,
        viewport,
        annotation.rotation ?? 0,
      );
      const editable = selected || focused;
      return (
        <g {...commonProps}>
          <foreignObject
            height={localHeight}
            transform={transform}
            width={localWidth}
          >
            {editable ? (
              <AutoFocusTextarea
                autoFocus={focused}
                className="free-text-editor"
                ignoreInitialBlurMs={
                  focused && annotation.text.trim().length === 0 ? 750 : 0
                }
                onChange={(event) =>
                  onUpdate(annotation.id, (current) =>
                    current.kind === "freeText"
                      ? { ...current, text: event.target.value }
                      : current,
                  )
                }
                onBlur={editable ? () => onFocusEnd(annotation.id) : undefined}
                onFocus={
                  focused && annotation.text.trim().length === 0
                    ? undefined
                    : onBeginEdit
                }
                placeholder="Text..."
                style={{
                  color: rgbToCss(annotation.color),
                  fontSize: annotation.fontSize * scale,
                  lineHeight: FREE_TEXT_LINE_HEIGHT,
                  opacity: annotation.opacity,
                }}
                value={annotation.text}
              />
            ) : (
              <div
                className="free-text-view"
                style={{
                  color: rgbToCss(annotation.color),
                  fontSize: annotation.fontSize * scale,
                  lineHeight: FREE_TEXT_LINE_HEIGHT,
                  opacity: annotation.opacity,
                }}
              >
                {annotation.text}
              </div>
            )}
          </foreignObject>
          {editable ? (
            <FreeTextWidthHandles
              annotation={annotation}
              onBeginDrag={(event, handle) =>
                onBeginFreeTextResizeHandleDrag(event, handle, annotation.id)
              }
              viewport={viewport}
            />
          ) : null}
        </g>
      );
    }

    case "imageStamp": {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      const { localWidth, localHeight, transform } = annotationContentTransform(
        rect,
        viewport,
        annotation.rotation ?? 0,
      );
      return (
        <g {...commonProps}>
          <image
            height={localHeight}
            href={`data:${annotation.mimeType};base64,${annotation.imageData}`}
            preserveAspectRatio="xMidYMid meet"
            transform={transform}
            width={localWidth}
          />
        </g>
      );
    }

    case "stickyNote": {
      const rect = pdfRectToViewportRect(annotation.rect, viewport);
      // The border and glyph sit on the note's own colour, so they cannot use
      // the theme ink: it goes invisible at both ends of the palette.
      const detailColor = foregroundOn(annotation.color);
      return (
        <g {...commonProps} transform={`translate(${rect.x} ${rect.y})`}>
          <rect
            fill={rgbToCss(annotation.color)}
            height={Math.max(rect.height, 22)}
            rx="3"
            stroke={detailColor}
            strokeOpacity={
              selected ? NOTE_MARK_OPACITY_SELECTED : NOTE_MARK_OPACITY
            }
            strokeWidth={selected ? 2 : 1}
            width={Math.max(rect.width, 22)}
          />
          {/*
            Lucide's lines-of-text glyph, placed rather than scaled: `size` and
            `x`/`y` put its 24-unit drawing over 6..18 x 7..17 of the note, and
            `strokeWidth` 2.25 at that size paints 1.5.
          */}
          <AlignLeft
            color={detailColor}
            size={16}
            strokeOpacity={NOTE_MARK_OPACITY}
            strokeWidth={2.25}
            x={4}
            y={4}
          />
          {showPopover ? (
            <NotePopover
              autoFocus={focused}
              color={annotation.color}
              editable={selected || focused}
              ignoreInitialBlurMs={
                focused && annotation.text.trim().length === 0 ? 750 : 0
              }
              onBlur={
                selected || focused
                  ? () => onFocusEnd(annotation.id)
                  : undefined
              }
              onFocus={
                focused && annotation.text.trim().length === 0
                  ? undefined
                  : onBeginEdit
              }
              onTextChange={(text) =>
                onUpdate(annotation.id, (current) =>
                  current.kind === "stickyNote"
                    ? { ...current, text }
                    : current,
                )
              }
              text={annotation.text}
              anchorRect={rect}
              viewport={viewport}
            />
          ) : null}
        </g>
      );
    }
  }
});

function TextHighlightHandles({
  annotation,
  onBeginDrag,
  viewport,
}: {
  annotation: Extract<PdfAnnotation, { kind: "textHighlight" }>;
  onBeginDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: "start" | "end",
  ) => void;
  viewport: PageViewport;
}) {
  const first = annotation.rects[0];
  const last = annotation.rects.at(-1);

  if (!first || !last) {
    return null;
  }

  const start = viewport.convertToViewportPoint(
    first.x1,
    (first.y1 + first.y2) / 2,
  );
  const end = viewport.convertToViewportPoint(last.x2, (last.y1 + last.y2) / 2);

  return (
    <g style={{ pointerEvents: "auto" }}>
      <circle
        className="highlight-handle"
        cx={start[0]}
        cy={start[1]}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, "start")}
        r="6"
        stroke="white"
        strokeWidth="2"
      />
      <circle
        className="highlight-handle"
        cx={end[0]}
        cy={end[1]}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, "end")}
        r="6"
        stroke="white"
        strokeWidth="2"
      />
    </g>
  );
}

function FreeTextWidthHandles({
  annotation,
  onBeginDrag,
  viewport,
}: {
  annotation: Extract<PdfAnnotation, { kind: "freeText" }>;
  onBeginDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: "left" | "right",
  ) => void;
  viewport: PageViewport;
}) {
  const bounds = pdfRectToViewportRect(annotation.rect, viewport);
  const { localWidth, localHeight, transform } = annotationContentTransform(
    bounds,
    viewport,
    annotation.rotation ?? 0,
  );
  const centerY = localHeight / 2;

  return (
    <g style={{ pointerEvents: "auto" }} transform={transform}>
      <circle
        className="free-text-width-handle"
        cx={0}
        cy={centerY}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, "left")}
        r="5"
        stroke="white"
        strokeWidth="2"
      />
      <circle
        className="free-text-width-handle"
        cx={localWidth}
        cy={centerY}
        fill={SELECTION_ACCENT}
        onPointerDown={(event) => onBeginDrag(event, "right")}
        r="5"
        stroke="white"
        strokeWidth="2"
      />
    </g>
  );
}

export function ImageStampSelectionOverlay({
  annotation,
  onBeginDrag,
  viewport,
}: {
  annotation: Extract<PdfAnnotation, { kind: "imageStamp" }>;
  onBeginDrag: (
    event: React.PointerEvent<SVGCircleElement>,
    handle: ImageStampResizeHandle["handle"],
  ) => void;
  viewport: PageViewport;
}) {
  const rect = pdfRectToViewportRect(annotation.rect, viewport);
  const { localWidth, localHeight, transform } = annotationContentTransform(
    rect,
    viewport,
    annotation.rotation ?? 0,
  );
  const handles: Array<{
    handle: ImageStampResizeHandle["handle"];
    point: [number, number];
  }> = [
    { handle: "top-left", point: [0, 0] },
    { handle: "top-right", point: [localWidth, 0] },
    { handle: "bottom-left", point: [0, localHeight] },
    { handle: "bottom-right", point: [localWidth, localHeight] },
  ];

  return (
    <g style={{ pointerEvents: "auto" }}>
      <rect
        fill="none"
        height={localHeight}
        stroke={SELECTION_ACCENT}
        strokeDasharray="4 3"
        strokeWidth="1.5"
        transform={transform}
        width={localWidth}
      />
      <g style={{ pointerEvents: "auto" }} transform={transform}>
        {handles.map(({ handle, point }) => (
          <circle
            cx={point[0]}
            cy={point[1]}
            fill={SELECTION_ACCENT}
            key={handle}
            onPointerDown={(event) => onBeginDrag(event, handle)}
            r="4.5"
            stroke="white"
            strokeWidth="1.5"
            style={{ cursor: `${handle.replace("-", "")}-resize` }}
          />
        ))}
      </g>
    </g>
  );
}

export function SelectionToolbar({
  annotations,
  onClose,
  onBeginEdit,
  onCopyText,
  onDelete,
  onUpdate,
  pageRef,
  viewport,
}: {
  annotations: PdfAnnotation[];
  onClose: () => void;
  onBeginEdit: () => void;
  onCopyText?: () => void;
  onDelete: () => void;
  onUpdate: (updater: (annotation: PdfAnnotation) => PdfAnnotation) => void;
  pageRef: RefObject<HTMLDivElement | null>;
  viewport: PageViewport;
}) {
  const bounds = pdfRectToViewportRect(
    boundsForRects(annotations.map(annotationBounds)),
    viewport,
  );
  const first = annotations[0];
  const showsFontSize = annotations.length === 1 && first?.kind === "freeText";
  const showsImageSize =
    annotations.length === 1 && first?.kind === "imageStamp";
  const showsStroke = annotations.some(hasStroke);
  const showsOpacity = annotations.some(hasOpacity);
  const showsCopyText = annotations.some(
    (annotation) => annotation.kind === "textHighlight",
  );
  const showsColor = Boolean(first && hasColor(first));
  const showsRotate = annotations.some(
    (annotation) =>
      annotation.kind === "freeText" || annotation.kind === "imageStamp",
  );
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const visibleBounds = useVisiblePageBounds(pageRef, viewport);
  const rowHeights = [
    showsColor ? 22 : 0,
    showsOpacity ? 30 : 0,
    showsStroke ? 30 : 0,
    showsFontSize ? 30 : 0,
    showsImageSize ? 30 : 0,
    showsImageSize ? 30 : 0,
    30,
  ].filter((height) => height > 0);
  const toolbarHeight =
    22 +
    rowHeights.reduce((total, height) => total + height, 0) +
    Math.max(0, rowHeights.length - 1) * 8;
  const [measuredToolbarHeight, setMeasuredToolbarHeight] =
    useState(toolbarHeight);
  const [measuredToolbarWidth, setMeasuredToolbarWidth] = useState(260);
  const activeToolbarHeight = measuredToolbarHeight || toolbarHeight;
  const activeToolbarWidth = Math.min(
    Math.max(120, visibleBounds.right - visibleBounds.left),
    measuredToolbarWidth || 260,
  );
  const minToolbarX = visibleBounds.left;
  const maxToolbarX = Math.max(
    minToolbarX,
    visibleBounds.right - activeToolbarWidth,
  );
  const toolbarX = clamp(
    bounds.x + bounds.width / 2 - activeToolbarWidth / 2,
    minToolbarX,
    maxToolbarX,
  );
  const aboveY = bounds.y - activeToolbarHeight - 4;
  const belowY = bounds.y + bounds.height + 4;
  const minToolbarY = visibleBounds.top;
  const maxToolbarY = Math.max(
    minToolbarY,
    visibleBounds.bottom - activeToolbarHeight,
  );
  // Above the selection when it fits, below otherwise; the clamp keeps the
  // fallback on screen.
  const preferredToolbarY = aboveY >= minToolbarY ? aboveY : belowY;
  const toolbarY = clamp(preferredToolbarY, minToolbarY, maxToolbarY);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return;
    }

    const updateSize = () => {
      const bounds = toolbar.getBoundingClientRect();
      setMeasuredToolbarHeight(Math.ceil(bounds.height));
      setMeasuredToolbarWidth(Math.ceil(bounds.width));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  return (
    <foreignObject
      height={activeToolbarHeight}
      style={{ pointerEvents: "auto" }}
      width={activeToolbarWidth}
      x={toolbarX}
      y={toolbarY}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div
        className="panel floating selection-toolbar"
        ref={toolbarRef}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <SettingsPanelShell>
          {first && hasColor(first) ? (
            <div onPointerDownCapture={onBeginEdit}>
              <ColorPalette
                color={first.color}
                label={null}
                onChange={(color) =>
                  onUpdate((current) =>
                    hasColor(current) ? { ...current, color } : current,
                  )
                }
                onCommit={onClose}
              />
            </div>
          ) : null}
          {showsOpacity && first && hasOpacity(first) ? (
            <div onPointerDownCapture={onBeginEdit}>
              <NumberSetting
                label="Opacity"
                max={1}
                min={0.1}
                onChange={(value) =>
                  onUpdate((current) =>
                    hasOpacity(current)
                      ? { ...current, opacity: value }
                      : current,
                  )
                }
                step={0.05}
                value={first.opacity}
              />
            </div>
          ) : null}
          {showsStroke && first && hasStroke(first) ? (
            <div onPointerDownCapture={onBeginEdit}>
              <NumberSetting
                label="Stroke"
                max={28}
                min={0.5}
                onChange={(value) =>
                  onUpdate((current) =>
                    hasStroke(current) ? { ...current, width: value } : current,
                  )
                }
                step={0.1}
                value={first.width}
              />
            </div>
          ) : null}
          {showsFontSize && first.kind === "freeText" ? (
            <div onPointerDownCapture={onBeginEdit}>
              <NumberSetting
                label="Size"
                max={48}
                min={8}
                onChange={(value) =>
                  onUpdate((current) =>
                    current.kind === "freeText"
                      ? { ...current, fontSize: value }
                      : current,
                  )
                }
                step={1}
                value={first.fontSize}
              />
            </div>
          ) : null}
          {showsImageSize && first.kind === "imageStamp" ? (
            <>
              <div onPointerDownCapture={onBeginEdit}>
                <NumberSetting
                  label="W mm"
                  max={1000}
                  min={5}
                  onChange={(value) =>
                    onUpdate((current) =>
                      current.kind === "imageStamp"
                        ? resizeImageStampToWidth(
                            current,
                            millimetresToPdfUnits(value, viewport),
                          )
                        : current,
                    )
                  }
                  step={1}
                  value={pdfUnitsToMillimetres(
                    Math.abs(first.rect.x2 - first.rect.x1),
                    viewport,
                  )}
                />
              </div>
              <div onPointerDownCapture={onBeginEdit}>
                <NumberSetting
                  label="H mm"
                  max={1000}
                  min={5}
                  onChange={(value) =>
                    onUpdate((current) =>
                      current.kind === "imageStamp"
                        ? resizeImageStampToHeight(
                            current,
                            millimetresToPdfUnits(value, viewport),
                          )
                        : current,
                    )
                  }
                  step={1}
                  value={pdfUnitsToMillimetres(
                    Math.abs(first.rect.y2 - first.rect.y1),
                    viewport,
                  )}
                />
              </div>
            </>
          ) : null}
          <div className="selection-toolbar-actions row nowrap">
            {showsCopyText && onCopyText ? (
              <button
                className="ghost selection-copy-button row nowrap"
                onClick={onCopyText}
                type="button"
              >
                <Copy size={14} />
                Copy text
              </button>
            ) : null}
            {showsRotate ? (
              <button
                aria-label="Rotate selection 90 degrees"
                className="selection-rotate-button"
                onClick={() =>
                  onUpdate((current) =>
                    current.kind === "freeText" || current.kind === "imageStamp"
                      ? {
                          ...current,
                          rotation: ((current.rotation ?? 0) + 90) % 360,
                        }
                      : current,
                  )
                }
                title="Rotate 90°"
                type="button"
              >
                <RotateCw size={15} />
              </button>
            ) : null}
            <button
              aria-label="Delete selection"
              className="icon-center selection-delete-button"
              onClick={onDelete}
              title="Delete"
              type="button"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </SettingsPanelShell>
      </div>
    </foreignObject>
  );
}

function hasOpacity(
  annotation: PdfAnnotation,
): annotation is Extract<PdfAnnotation, { opacity: number }> {
  return (
    annotation.kind === "textHighlight" ||
    annotation.kind === "draw" ||
    annotation.kind === "freehandHighlight" ||
    annotation.kind === "freeText"
  );
}

function hasColor(
  annotation: PdfAnnotation,
): annotation is Extract<PdfAnnotation, { color: [number, number, number] }> {
  return annotation.kind !== "imageStamp";
}

function hasStroke(
  annotation: PdfAnnotation,
): annotation is Extract<PdfAnnotation, { width: number }> {
  return annotation.kind === "draw" || annotation.kind === "freehandHighlight";
}
