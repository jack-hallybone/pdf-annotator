import { useEffect, useRef } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import {
  ensureContrastAgainst,
  flattenOver,
  foregroundOn,
  rgbToCss,
  rgbToCssWithAlpha,
} from "../annotationColors";
import type { RgbColor } from "../annotationColors";
import { pathToViewportD } from "../pdfGeometry";
import type { PageViewport, PdfPoint } from "../types";
import { clamp } from "../viewerConfig";

/* eslint-disable react-refresh/only-export-components --
 * The style and pointer helpers are colocated with the components using them. */
export const SELECTION_ACCENT = "var(--app-selection)";
export const TEXT_HIGHLIGHT_STYLE = { mixBlendMode: "multiply" as const };

// The popover paints its colour at this alpha over the page, which is opaque
// white in both schemes, so that is what its text must stay legible against.
const NOTE_POPOVER_FILL_ALPHA = 0.24;
const NOTE_POPOVER_BACKDROP: RgbColor = [1, 1, 1];

type AutoFocusTextareaProps = {
  autoFocus?: boolean;
  ignoreInitialBlurMs?: number;
  onBlur?: () => void;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  className: string;
  placeholder?: string;
  style?: CSSProperties;
  value: string;
};

export function AutoFocusTextarea({
  autoFocus = false,
  ignoreInitialBlurMs = 0,
  onBlur,
  onChange,
  onFocus,
  className,
  placeholder,
  style,
  value,
}: AutoFocusTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusStartedAtRef = useRef(0);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }

    const focusTextarea = () => {
      const textarea = textareaRef.current;
      focusStartedAtRef.current ||= performance.now();
      textarea?.focus({ preventScroll: true });
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    };

    focusTextarea();
    const frame = window.requestAnimationFrame(focusTextarea);
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  return (
    <textarea
      className={className}
      onBlur={() => {
        const elapsed = performance.now() - focusStartedAtRef.current;
        if (ignoreInitialBlurMs > 0 && elapsed < ignoreInitialBlurMs) {
          window.requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            textarea?.focus({ preventScroll: true });
            textarea?.setSelectionRange(
              textarea.value.length,
              textarea.value.length,
            );
          });
          return;
        }

        onBlur?.();
      }}
      onChange={onChange}
      onFocus={onFocus}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      placeholder={placeholder}
      ref={textareaRef}
      style={style}
      value={value}
    />
  );
}

type NotePopoverProps = {
  autoFocus?: boolean;
  color?: [number, number, number];
  editable?: boolean;
  ignoreInitialBlurMs?: number;
  onBlur?: () => void;
  onFocus?: () => void;
  onTextChange?: (text: string) => void;
  text: string;
  anchorRect: { x: number; y: number; width: number; height: number };
  viewport: PageViewport;
};

export function NotePopover({
  autoFocus = false,
  color,
  editable = false,
  ignoreInitialBlurMs = 0,
  onBlur,
  onFocus,
  onTextChange,
  text,
  anchorRect,
  viewport,
}: NotePopoverProps) {
  const backgroundColor = color
    ? rgbToCssWithAlpha(color, NOTE_POPOVER_FILL_ALPHA)
    : undefined;
  // The border keeps the note's hue, darkened only as far as the 3:1 WCAG
  // floor for a UI boundary, since a pale note has no visible edge otherwise.
  const borderColor = color
    ? rgbToCss(
        ensureContrastAgainst(
          flattenOver(color, NOTE_POPOVER_BACKDROP, 0.75),
          NOTE_POPOVER_BACKDROP,
          3,
        ),
      )
    : undefined;
  // The text sits on a tint of the note colour, so it cannot use the theme
  // ink: in dark mode that is near-white over a pastel, unreadable across the
  // whole palette.
  const textColor = foregroundOn(
    color
      ? flattenOver(color, NOTE_POPOVER_BACKDROP, NOTE_POPOVER_FILL_ALPHA)
      : NOTE_POPOVER_BACKDROP,
  );
  const size = notePopoverSize(text);
  const margin = 8;
  const pageMargin = 4;
  const anchorWidth = Math.max(anchorRect.width, 22);
  const rightX = anchorRect.x + anchorWidth + margin;
  const leftX = anchorRect.x - size.width - margin;
  const absoluteX =
    rightX + size.width <= viewport.width - pageMargin
      ? rightX
      : clamp(
          leftX,
          pageMargin,
          Math.max(pageMargin, viewport.width - size.width - pageMargin),
        );
  const absoluteY = clamp(
    anchorRect.y,
    pageMargin,
    Math.max(pageMargin, viewport.height - size.height - pageMargin),
  );

  return (
    <foreignObject
      height={size.height}
      width={size.width}
      x={absoluteX - anchorRect.x}
      y={absoluteY - anchorRect.y}
    >
      {editable ? (
        <AutoFocusTextarea
          autoFocus={autoFocus}
          className="note-popover note-popover-editor"
          ignoreInitialBlurMs={ignoreInitialBlurMs}
          onChange={(event) => onTextChange?.(event.target.value)}
          onBlur={onBlur}
          onFocus={onFocus}
          style={{
            backgroundColor,
            borderColor,
            color: textColor,
            boxSizing: "border-box",
            height: size.height,
            width: size.width,
          }}
          value={text}
        />
      ) : (
        <div
          className="note-popover"
          style={{
            backgroundColor,
            borderColor,
            color: textColor,
            boxSizing: "border-box",
            maxHeight: size.height,
            width: size.width,
          }}
        >
          {text}
        </div>
      )}
    </foreignObject>
  );
}

function notePopoverSize(text: string) {
  const lines = text.trim().length > 0 ? text.split(/\r?\n/) : [""];
  const longestLine = Math.max(
    ...lines.map((line) => line.trimEnd().length),
    4,
  );
  return {
    width: clamp(longestLine * 7 + 22, 82, 260),
    height: clamp(lines.length * 20 + 24, 48, 180),
  };
}

export function LassoShape({
  points,
  viewport,
}: {
  points: PdfPoint[];
  viewport: PageViewport;
}) {
  if (points.length === 0) {
    return null;
  }

  const d = points
    .map((point, index) => {
      const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  return (
    <path
      d={`${d} Z`}
      fill="rgb(from var(--app-selection) r g b / 0.08)"
      stroke={SELECTION_ACCENT}
      strokeDasharray="5 4"
      strokeWidth="1.5"
    />
  );
}

export function PathShape({
  color,
  opacity,
  points,
  style,
  viewport,
  width,
}: {
  color: string;
  opacity: number;
  points: PdfPoint[];
  style?: CSSProperties;
  viewport: PageViewport;
  width: number;
}) {
  const d = pathToViewportD(points, viewport);

  return (
    <path
      d={d}
      fill="none"
      opacity={opacity}
      shapeRendering="geometricPrecision"
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={width}
      style={style}
    />
  );
}

export function FilledPathShape({
  color,
  opacity,
  points,
  viewport,
}: {
  color: string;
  opacity: number;
  points: PdfPoint[];
  viewport: PageViewport;
}) {
  const d = points
    .map((point, index) => {
      const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  return <path d={`${d} Z`} fill={color} opacity={opacity} stroke="none" />;
}
