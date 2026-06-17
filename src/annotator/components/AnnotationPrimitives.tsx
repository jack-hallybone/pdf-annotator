import { useEffect, useRef } from 'react';
import type { CSSProperties, ChangeEvent } from 'react';
import { rgbToCssWithAlpha } from '../annotationColors';
import { pathToViewportD } from '../pdfGeometry';
import type { PageViewport, PdfPoint } from '../types';
import { clamp } from '../viewerConfig';

export const SELECTION_ACCENT = 'var(--pdfa-accent)';
export const TEXT_HIGHLIGHT_STYLE = { mixBlendMode: 'multiply' as const };

type AutoFocusTextareaProps = {
  autoFocus?: boolean;
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
  onBlur,
  onChange,
  onFocus,
  className,
  placeholder,
  style,
  value
}: AutoFocusTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }

    const focusTextarea = () => {
      const textarea = textareaRef.current;
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
      onBlur={onBlur}
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
  onBlur,
  onFocus,
  onTextChange,
  text,
  anchorRect,
  viewport
}: NotePopoverProps) {
  const backgroundColor = color ? rgbToCssWithAlpha(color, 0.24) : undefined;
  const borderColor = color ? rgbToCssWithAlpha(color, 0.75) : undefined;
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
          Math.max(pageMargin, viewport.width - size.width - pageMargin)
        );
  const absoluteY = clamp(
    anchorRect.y,
    pageMargin,
    Math.max(pageMargin, viewport.height - size.height - pageMargin)
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
          onChange={(event) => onTextChange?.(event.target.value)}
          onBlur={onBlur}
          onFocus={onFocus}
          style={{
            backgroundColor,
            borderColor,
            boxSizing: 'border-box',
            height: size.height,
            width: size.width
          }}
          value={text}
        />
      ) : (
        <div
          className="note-popover"
          style={{
            backgroundColor,
            borderColor,
            boxSizing: 'border-box',
            maxHeight: size.height,
            width: size.width
          }}
        >
          {text}
        </div>
      )}
    </foreignObject>
  );
}

function notePopoverSize(text: string) {
  const lines = text.trim().length > 0 ? text.split(/\r?\n/) : [''];
  const longestLine = Math.max(
    ...lines.map((line) => line.trimEnd().length),
    4
  );
  return {
    width: clamp(longestLine * 7 + 22, 82, 260),
    height: clamp(lines.length * 20 + 24, 48, 180)
  };
}

export function LassoShape({
  points,
  viewport
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
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  return (
    <path
      d={`${d} Z`}
      fill="rgb(var(--pdfa-accent-rgb) / 0.08)"
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
  width
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
  viewport
}: {
  color: string;
  opacity: number;
  points: PdfPoint[];
  viewport: PageViewport;
}) {
  const d = points
    .map((point, index) => {
      const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  return <path d={`${d} Z`} fill={color} opacity={opacity} stroke="none" />;
}
