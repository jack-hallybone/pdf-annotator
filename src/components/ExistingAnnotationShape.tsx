import { AnnotationType } from 'pdfjs-dist';
import {
  existingInkColor,
  existingInkOpacity,
  existingInkWidth,
  isSvgRenderedExistingAnnotation,
  pdfjsColorToCss
} from '../annotationColors';
import {
  isInkHighlight,
  normalizeInkLists,
  pathLooksClosed
} from '../annotationImport';
import type { ExistingPdfAnnotation } from '../annotationImport';
import {
  pdfArrayRectToViewportRect,
  quadPointsToPolygons,
  pointsToSvg
} from '../pdfGeometry';
import type { PageViewport, PdfPoint } from '../types';
import {
  FilledPathShape,
  NotePopover,
  PathShape,
  TEXT_HIGHLIGHT_STYLE
} from './AnnotationPrimitives';

type ExistingAnnotationShapeProps = {
  annotation: ExistingPdfAnnotation;
  isHovered: boolean;
  onHoverChange: (hovered: boolean) => void;
  viewport: PageViewport;
};

export function ExistingAnnotationShape({
  annotation,
  isHovered,
  onHoverChange,
  viewport
}: ExistingAnnotationShapeProps) {
  if (!isSvgRenderedExistingAnnotation(annotation)) {
    return null;
  }

  const color = pdfjsColorToCss(annotation.color, '#facc15');
  const fillColor = pdfjsColorToCss(
    annotation.interiorColor,
    annotation.annotationType === AnnotationType.HIGHLIGHT ? color : 'none'
  );
  const opacity = annotation.opacity ?? annotation.ca ?? 0.35;

  switch (annotation.annotationType) {
    case AnnotationType.HIGHLIGHT:
      return (
        <g>
          {quadPointsToPolygons(annotation.quadPoints, annotation.rect).map(
            (points, index) => (
              <polygon
                fill={color}
                key={`${annotation.id}-highlight-${index}`}
                opacity={opacity}
                points={pointsToSvg(points, viewport)}
                style={TEXT_HIGHLIGHT_STYLE}
              />
            )
          )}
        </g>
      );

    case AnnotationType.UNDERLINE:
    case AnnotationType.STRIKEOUT:
    case AnnotationType.SQUIGGLY:
      return (
        <g>
          {quadPointsToPolygons(annotation.quadPoints, annotation.rect).map(
            (points, index) => (
              <TextMarkupLine
                color={color}
                key={`${annotation.id}-markup-${index}`}
                points={points}
                type={annotation.annotationType}
                viewport={viewport}
              />
            )
          )}
        </g>
      );

    case AnnotationType.INK: {
      const inkPaths = normalizeInkLists(annotation);
      const inkIsHighlight = isInkHighlight(annotation);
      const inkColor = existingInkColor(annotation, color, inkIsHighlight);
      return (
        <g>
          {inkPaths.map((path, index) =>
            inkIsHighlight && pathLooksClosed(path) ? (
              <FilledPathShape
                color={inkColor}
                key={`${annotation.id}-ink-${index}`}
                opacity={existingInkOpacity(annotation, inkIsHighlight)}
                points={path}
                viewport={viewport}
              />
            ) : (
              <PathShape
                color={inkColor}
                key={`${annotation.id}-ink-${index}`}
                opacity={existingInkOpacity(annotation, inkIsHighlight)}
                points={path}
                viewport={viewport}
                width={existingInkWidth(annotation, inkIsHighlight)}
              />
            )
          )}
        </g>
      );
    }

    case AnnotationType.FREETEXT: {
      const rect = pdfArrayRectToViewportRect(annotation.rect, viewport);
      return (
        <foreignObject
          height={rect.height}
          width={rect.width}
          x={rect.x}
          y={rect.y}
        >
          <div className="h-full w-full whitespace-pre-wrap rounded border border-app-ink/12 bg-app-ui px-2 py-1 text-[12px] leading-snug text-app-ink">
            {(annotation.textContent ?? [annotation.contentsObj?.str ?? ''])
              .filter(Boolean)
              .join('\n')}
          </div>
        </foreignObject>
      );
    }

    case AnnotationType.TEXT: {
      const rect = pdfArrayRectToViewportRect(annotation.rect, viewport);
      const noteText = annotation.contentsObj?.str ?? 'Note';
      return (
        <g
          className="annotation-hit"
          onPointerEnter={() => onHoverChange(true)}
          onPointerLeave={() => onHoverChange(false)}
          style={{ cursor: 'pointer', pointerEvents: 'auto' }}
          transform={`translate(${rect.x} ${rect.y})`}
        >
          <title>{noteText}</title>
          <rect
            fill={color}
            height={Math.max(rect.height, 22)}
            rx="3"
            stroke="#854d0e"
            width={Math.max(rect.width, 22)}
          />
          <path
            d="M6 7h12M6 12h10M6 17h8"
            fill="none"
            stroke="#713f12"
            strokeLinecap="round"
            strokeWidth="1.5"
          />
          {isHovered ? (
            <NotePopover
              anchorRect={rect}
              text={noteText}
              viewport={viewport}
            />
          ) : null}
        </g>
      );
    }

    case AnnotationType.SQUARE: {
      const rect = pdfArrayRectToViewportRect(annotation.rect, viewport);
      return (
        <rect
          fill={fillColor}
          fillOpacity={fillColor === 'none' ? 0 : opacity}
          height={rect.height}
          opacity={annotation.opacity ?? 1}
          stroke={color}
          strokeWidth={annotation.borderStyle?.width ?? 1}
          width={rect.width}
          x={rect.x}
          y={rect.y}
        />
      );
    }

    case AnnotationType.CIRCLE: {
      const rect = pdfArrayRectToViewportRect(annotation.rect, viewport);
      return (
        <ellipse
          cx={rect.x + rect.width / 2}
          cy={rect.y + rect.height / 2}
          fill={fillColor}
          fillOpacity={fillColor === 'none' ? 0 : opacity}
          opacity={annotation.opacity ?? 1}
          rx={rect.width / 2}
          ry={rect.height / 2}
          stroke={color}
          strokeWidth={annotation.borderStyle?.width ?? 1}
        />
      );
    }

    case AnnotationType.LINE: {
      const [x1, y1, x2, y2] = annotation.lineCoordinates ?? annotation.rect;
      const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
      const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2);
      return (
        <line
          opacity={annotation.opacity ?? 1}
          stroke={color}
          strokeLinecap="round"
          strokeWidth={annotation.borderStyle?.width ?? 1}
          x1={vx1}
          x2={vx2}
          y1={vy1}
          y2={vy2}
        />
      );
    }

    default:
      return null;
  }
}

function TextMarkupLine({
  color,
  points,
  type,
  viewport
}: {
  color: string;
  points: PdfPoint[];
  type: number;
  viewport: PageViewport;
}) {
  const lowerLeft = points[2] ?? points[0];
  const lowerRight = points[3] ?? points[1];
  const upperLeft = points[0];
  const upperRight = points[1] ?? points[0];
  const y =
    type === AnnotationType.STRIKEOUT
      ? (upperLeft.y + lowerLeft.y) / 2
      : lowerLeft.y;
  const [x1, y1] = viewport.convertToViewportPoint(lowerLeft.x, y);
  const [x2, y2] = viewport.convertToViewportPoint(lowerRight.x, y);

  if (type === AnnotationType.SQUIGGLY) {
    const segments = 12;
    const path = Array.from({ length: segments + 1 }, (_, index) => {
      const t = index / segments;
      const x = x1 + (x2 - x1) * t;
      const yPoint = y1 + (y2 - y1) * t + (index % 2 === 0 ? -2 : 2);
      return `${index === 0 ? 'M' : 'L'} ${x} ${yPoint}`;
    }).join(' ');
    return <path d={path} fill="none" stroke={color} strokeWidth="1.5" />;
  }

  return (
    <>
      <line
        stroke={color}
        strokeWidth="1.5"
        x1={x1}
        x2={x2}
        y1={y1}
        y2={y2}
      />
      {type === AnnotationType.STRIKEOUT ? (
        <line
          opacity="0.3"
          stroke={color}
          strokeWidth="1"
          x1={viewport.convertToViewportPoint(upperLeft.x, upperLeft.y)[0]}
          x2={viewport.convertToViewportPoint(upperRight.x, upperRight.y)[0]}
          y1={viewport.convertToViewportPoint(upperLeft.x, upperLeft.y)[1]}
          y2={viewport.convertToViewportPoint(upperRight.x, upperRight.y)[1]}
        />
      ) : null}
    </>
  );
}
