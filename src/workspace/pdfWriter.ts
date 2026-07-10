import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFNumber,
  PDFString,
  PDFFont,
  StandardFonts
} from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import {
  appearanceRotationMatrix,
  dotPath,
  inkPathCommands,
  pathLooksClosed,
  rectToQuadPoints,
  rotatedAnnotationRect
} from './annotationGeometry';
import {
  clampPdfNumber,
  normalizedRectValues,
  sourceKeyNumber,
  textHash
} from './annotationSourceKey';
import {
  FREE_TEXT_LINE_HEIGHT,
  freeTextContentRect,
  freeTextVisualLines
} from './freeTextLayout';
import { loadEditablePdf, saveEditedPdf } from './pdfPageOperations';
import type { InkAnnotation, PdfAnnotation, PdfPoint, PdfRect } from './types';

const printFlag = 4;
const PDF_COORDINATE_PRECISION = 0.01;
const PDF_RATIO_PRECISION = 0.001;
const supportedAnnotationSubtypes = new Set([
  'Highlight',
  'Ink',
  'FreeText',
  'Text'
]);
const freeTextFontResourceName = 'Helvetica';
const winAnsiExtraCodePoints = new Set([
  0x0152,
  0x0153,
  0x0160,
  0x0161,
  0x0178,
  0x017d,
  0x017e,
  0x0192,
  0x02c6,
  0x02dc,
  0x2013,
  0x2014,
  0x2018,
  0x2019,
  0x201a,
  0x201c,
  0x201d,
  0x201e,
  0x2020,
  0x2021,
  0x2022,
  0x2026,
  0x2030,
  0x2039,
  0x203a,
  0x20ac,
  0x2122
]);

export class UnsupportedAnnotationTextError extends Error {
  annotationId: string;
  annotationKind: PdfAnnotation['kind'];
  characters: string[];
  pageIndex: number;

  constructor({
    annotationId,
    annotationKind,
    characters,
    pageIndex
  }: {
    annotationId: string;
    annotationKind: PdfAnnotation['kind'];
    characters: string[];
    pageIndex: number;
  }) {
    const label =
      annotationKind === 'stickyNote' ? 'note annotation' : 'text annotation';
    super(
      `A ${label} on page ${pageIndex + 1} contains unsupported ${characters.length === 1 ? 'character' : 'characters'} (${formatUnsupportedCharacters(characters)})`
    );
    this.annotationId = annotationId;
    this.annotationKind = annotationKind;
    this.characters = characters;
    this.name = 'UnsupportedAnnotationTextError';
    this.pageIndex = pageIndex;
  }
}

export async function writePdfAnnotations(
  bytes: Uint8Array,
  annotations: PdfAnnotation[],
  options: {
    removeAllAnnotations?: boolean;
    removeUnmatchedSupportedAnnotations?: boolean;
    replaceAnnotationSourceIds?: Iterable<string>;
    replacePageIndexes?: Iterable<number>;
    onMalformedExistingAnnotations?: (count: number) => void;
  } = {}
) {
  assertAnnotationsTextIsSupported(annotations);
  const pdfDoc = await loadEditablePdf(bytes);
  const replacePageIndexes = options.replacePageIndexes
    ? new Set(options.replacePageIndexes)
    : null;
  const replaceAnnotationSourceIds = options.replaceAnnotationSourceIds
    ? sourceIdKeySet(options.replaceAnnotationSourceIds)
    : null;
  if (options.removeAllAnnotations) {
    removeAllExistingAnnotations(pdfDoc);
  } else if (
    options.removeUnmatchedSupportedAnnotations ||
    (replaceAnnotationSourceIds && replaceAnnotationSourceIds.size > 0)
  ) {
    const malformedCount = removeSupportedExistingAnnotations(
      pdfDoc,
      replacePageIndexes,
      options.removeUnmatchedSupportedAnnotations
        ? null
        : replaceAnnotationSourceIds
    );
    if (malformedCount > 0) {
      options.onMalformedExistingAnnotations?.(malformedCount);
    }
  }

  let freeTextFont: PDFFont | null = null;

  for (const annotation of [...annotations].sort(annotationWriteOrder)) {
    if (!isWritablePageIndex(pdfDoc, annotation.pageIndex)) {
      continue;
    }

    const page = pdfDoc.getPage(annotation.pageIndex);

    if (annotation.kind === 'textHighlight') {
      const rects = annotation.rects.filter(isUsableRect);
      const quadPoints = normalizedQuadPoints(annotation.quadPoints, rects);

      if (rects.length === 0 || quadPoints.length === 0) {
        continue;
      }

      addAnnotation(page, {
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: rectToArray(boundsForRects(rects)),
        QuadPoints: quadPoints.flat().map(pdfCoordinate),
        ...annotationBase(annotation.id),
        C: pdfColor(annotation.color),
        CA: pdfOpacity(annotation.opacity),
        AP: {
          N: highlightAppearance(page, rects, annotation)
        }
      });
      continue;
    }

    if (annotation.kind === 'draw' || annotation.kind === 'freehandHighlight') {
      const width = pdfStrokeWidth(annotation.width);
      const paths = annotation.paths
        .map((path) => normalizeInkPath(path, width))
        .filter((path) => path.length > 0);
      const filledPaths =
        annotation.kind === 'freehandHighlight' && annotation.filled
          ? paths.filter(pathLooksClosed)
          : [];

      if (filledPaths.length > 0) {
        addInkAnnotation(page, annotation, filledPaths, width, {
          filledAppearance: true,
          id: filledPaths.length === paths.length ? annotation.id : `${annotation.id}-fill`
        });
      }

      const strokedPaths =
        filledPaths.length > 0
          ? paths.filter((path) => !filledPaths.includes(path))
          : paths;
      if (strokedPaths.length === 0) {
        continue;
      }

      addInkAnnotation(page, annotation, strokedPaths, width, {
        id: filledPaths.length > 0 ? `${annotation.id}-stroke` : annotation.id
      });
      continue;
    }

    if (annotation.kind === 'freeText') {
      const text = normalizedFreeText(annotation.text);
      if (text.trim().length === 0) {
        continue;
      }

      if (!isUsableRect(annotation.rect)) {
        continue;
      }

      const fontSize = pdfFontSize(annotation.fontSize);
      const [r, g, b] = pdfColor(annotation.color);
      const rotation = annotation.rotation ?? 0;
      // `annotation.rect` is the rotated on-page footprint (width/height
      // swapped for 90/270) - freeTextContentRect lays out content assuming
      // an un-rotated rect, so it needs the local footprint here, not the
      // on-page one (rotatedAnnotationRect is its own inverse for this).
      const rect = freeTextContentRect(
        rotatedAnnotationRect(annotation.rect, rotation),
        text,
        fontSize,
        { layoutWidth: annotation.layoutWidth }
      );
      freeTextFont ??= await pdfDoc.embedFont(StandardFonts.Helvetica);
      addAnnotation(page, {
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: rectToArray(rotatedAnnotationRect(rect, rotation)),
        Contents: pdfTextString(text),
        ...annotationBase(annotation.id),
        CA: pdfOpacity(annotation.opacity),
        DA: PDFString.of(
          `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg /${freeTextFontResourceName} ${fontSize} Tf`
        ),
        DR: {
          Font: {
            [freeTextFontResourceName]: freeTextFont.ref
          }
        },
        AP: {
          N: freeTextAppearance(
            page,
            rect,
            text,
            fontSize,
            annotation.color,
            annotation.opacity,
            freeTextFont,
            rotation
          )
        },
        IT: 'FreeTextTypeWriter',
        Q: 0,
        Border: [0, 0, 0],
        BS: {
          W: 0,
          S: 'S'
        },
        RD: [0, 0, 0, 0]
      });
      continue;
    }

    if (annotation.kind === 'stickyNote') {
      if (annotation.text.trim().length === 0) {
        continue;
      }

      if (!isUsableRect(annotation.rect)) {
        continue;
      }

      addAnnotation(page, {
        Type: 'Annot',
        Subtype: 'Text',
        Rect: rectToArray(annotation.rect),
        Contents: pdfTextString(annotation.text),
        ...annotationBase(annotation.id),
        Name: 'Note',
        Open: false,
        C: pdfColor(annotation.color),
        AP: {
          N: stickyNoteAppearance(page, annotation.rect, annotation.color)
        }
      });
      continue;
    }

    if (annotation.kind === 'imageStamp') {
      if (!isUsableRect(annotation.rect) || annotation.imageData.length === 0) {
        continue;
      }

      const image = await pdfDoc.embedPng(base64ToBytes(annotation.imageData));
      const imageRotation = annotation.rotation ?? 0;
      addAnnotation(page, {
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: rectToArray(rotatedAnnotationRect(annotation.rect, imageRotation)),
        ...annotationBase(annotation.id),
        Name: 'Image',
        AP: {
          N: imageStampAppearance(page, annotation.rect, image.ref, imageRotation)
        }
      });
    }
  }

  return saveEditedPdf(pdfDoc);
}

function annotationWriteOrder(left: PdfAnnotation, right: PdfAnnotation) {
  return annotationWriteRank(left) - annotationWriteRank(right);
}

function annotationWriteRank(annotation: PdfAnnotation) {
  switch (annotation.kind) {
    case 'textHighlight':
      return 0;
    case 'imageStamp':
      return 1;
    case 'freehandHighlight':
      return 2;
    case 'draw':
      return 3;
    case 'freeText':
      return 4;
    case 'stickyNote':
      return 5;
  }
}

function isWritablePageIndex(pdfDoc: PDFDocument, pageIndex: number) {
  return (
    Number.isInteger(pageIndex) &&
    pageIndex >= 0 &&
    pageIndex < pdfDoc.getPageCount()
  );
}

function annotationBase(id: string) {
  const date = PDFString.of(pdfDate());
  return {
    NM: PDFString.of(id),
    M: date,
    CreationDate: date,
    F: printFlag
  };
}

function highlightAppearance(
  page: PDFPage,
  rects: PdfRect[],
  annotation: Extract<PdfAnnotation, { kind: 'textHighlight' }>
) {
  const context = page.doc.context;
  const rect = boundsForRects(rects);
  const [x1, y1, x2, y2] = rectToArray(rect);
  const [r, g, b] = pdfColor(annotation.color);
  const opacity = pdfOpacity(annotation.opacity);
  const content = [
    'q',
    '/GS0 gs',
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    ...rects.map((highlightRect) => filledRectOperators(highlightRect, x1, y1)),
    'Q'
  ].join('\n');

  return context.register(
    context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, pdfCoordinate(x2 - x1), pdfCoordinate(y2 - y1)],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: {
        ExtGState: {
          GS0: {
            Type: 'ExtGState',
            ca: opacity,
            CA: opacity,
            BM: 'Multiply'
          }
        }
      }
    })
  );
}

function freeTextAppearance(
  page: PDFPage,
  rect: PdfRect,
  text: string,
  fontSize: number,
  color: [number, number, number],
  opacity: number,
  font: PDFFont,
  rotation = 0
) {
  const context = page.doc.context;
  const [x1, y1, x2, y2] = rectToArray(rect);
  const width = pdfCoordinate(x2 - x1);
  const height = pdfCoordinate(y2 - y1);
  const [r, g, b] = pdfColor(color);
  const lineHeight = pdfCoordinate(fontSize * FREE_TEXT_LINE_HEIGHT);
  const baselineY = Math.max(0, height - fontSize);
  const lines = freeTextVisualLines(text, fontSize, width);
  const content = [
    'q',
    '/GS0 gs',
    'BT',
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    `/${freeTextFontResourceName} ${pdfCoordinateNumber(fontSize)} Tf`,
    `${pdfCoordinateNumber(lineHeight)} TL`,
    `0 ${pdfCoordinateNumber(baselineY)} Td`,
    lines.map((line, index) =>
      `${index === 0 ? '' : 'T*\n'}${encodedAppearanceText(font, line)} Tj`
    ).join('\n'),
    'ET',
    'Q'
  ].join('\n');

  return context.register(
    context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, width, height],
      Matrix: appearanceRotationMatrix(rotation, width, height),
      Resources: {
        ExtGState: {
          GS0: {
            Type: 'ExtGState',
            ca: pdfOpacity(opacity),
            CA: pdfOpacity(opacity)
          }
        },
        Font: {
          [freeTextFontResourceName]: font.ref
        }
      }
    })
  );
}

function stickyNoteAppearance(
  page: PDFPage,
  rect: PdfRect,
  color: [number, number, number]
) {
  const context = page.doc.context;
  const [x1, y1, x2, y2] = rectToArray(rect);
  const width = pdfCoordinate(x2 - x1);
  const height = pdfCoordinate(y2 - y1);
  const fold = pdfCoordinate(Math.min(width, height) * 0.32);
  const [r, g, b] = pdfColor(color);
  const content = [
    'q',
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    `${pdfNumber(r * 0.72)} ${pdfNumber(g * 0.72)} ${pdfNumber(b * 0.72)} RG`,
    '0.75 w',
    `0 0 ${pdfCoordinateNumber(width)} ${pdfCoordinateNumber(height)} re`,
    'B',
    `${pdfCoordinateNumber(width - fold)} ${pdfCoordinateNumber(height)} m`,
    `${pdfCoordinateNumber(width - fold)} ${pdfCoordinateNumber(height - fold)} l`,
    `${pdfCoordinateNumber(width)} ${pdfCoordinateNumber(height - fold)} l`,
    'S',
    'Q'
  ].join('\n');

  return context.register(
    context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, width, height],
      Matrix: [1, 0, 0, 1, 0, 0]
    })
  );
}

function imageStampAppearance(
  page: PDFPage,
  rect: PdfRect,
  imageRef: PDFRef,
  rotation = 0
) {
  const context = page.doc.context;
  const [x1, y1, x2, y2] = rectToArray(rect);
  const width = pdfCoordinate(x2 - x1);
  const height = pdfCoordinate(y2 - y1);
  const content = [
    'q',
    `${pdfCoordinateNumber(width)} 0 0 ${pdfCoordinateNumber(height)} 0 0 cm`,
    '/Im0 Do',
    'Q'
  ].join('\n');

  return context.register(
    context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, width, height],
      Matrix: appearanceRotationMatrix(rotation, width, height),
      Resources: {
        XObject: {
          Im0: imageRef
        }
      }
    })
  );
}

function encodedAppearanceText(font: PDFFont, text: string) {
  return font.encodeText(text).toString();
}

function pdfTextString(text: string) {
  const literal = PDFString.of(text);
  return literal.decodeText() === text ? literal : PDFHexString.fromText(text);
}

export function assertAnnotationsTextIsSupported(annotations: PdfAnnotation[]) {
  for (const annotation of annotations) {
    const unsupported = unsupportedAnnotationTextCharacters(annotation);
    if (unsupported.length > 0) {
      throw new UnsupportedAnnotationTextError({
        annotationId: annotation.id,
        annotationKind: annotation.kind,
        characters: unsupported,
        pageIndex: annotation.pageIndex
      });
    }
  }
}

function unsupportedAnnotationTextCharacters(annotation: PdfAnnotation) {
  if (annotation.kind !== 'freeText' || annotation.text.trim().length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      graphemeClusters(normalizedFreeText(annotation.text)).filter(
        (cluster) => !isSupportedFreeTextCluster(cluster)
      )
    )
  );
}

function normalizedFreeText(text: string) {
  return text.normalize('NFC');
}

function isSupportedFreeTextCluster(cluster: string) {
  return Array.from(cluster).every(isSupportedFreeTextCharacter);
}

function isSupportedFreeTextCharacter(character: string) {
  if (character === '\n' || character === '\r') {
    return true;
  }

  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xff) ||
      winAnsiExtraCodePoints.has(codePoint))
  );
}

function graphemeClusters(text: string) {
  const clusters: string[] = [];
  for (const character of Array.from(text)) {
    if (clusters.length > 0 && isGraphemeExtension(character)) {
      clusters[clusters.length - 1] += character;
    } else {
      clusters.push(character);
    }
  }
  return clusters;
}

function isGraphemeExtension(character: string) {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0xe0100 && codePoint <= 0xe01ef))
  );
}

function formatUnsupportedCharacters(characters: string[]) {
  const visibleCharacters = characters.slice(0, 5).map((character) =>
    JSON.stringify(character)
  );
  return `${visibleCharacters.join(', ')}${characters.length > 5 ? ', ...' : ''}`;
}

function filledRectOperators(rect: PdfRect, offsetX: number, offsetY: number) {
  const x = pdfCoordinate(Math.min(rect.x1, rect.x2) - offsetX);
  const y = pdfCoordinate(Math.min(rect.y1, rect.y2) - offsetY);
  const width = pdfCoordinate(Math.abs(rect.x2 - rect.x1));
  const height = pdfCoordinate(Math.abs(rect.y2 - rect.y1));
  return `${pdfCoordinateNumber(x)} ${pdfCoordinateNumber(y)} ${pdfCoordinateNumber(width)} ${pdfCoordinateNumber(height)} re\nf`;
}

function addInkAnnotation(
  page: PDFPage,
  annotation: InkAnnotation,
  paths: PdfPoint[][],
  width: number,
  options: { filledAppearance?: boolean; id: string }
) {
  const points = paths.flat();
  if (points.length === 0) {
    return;
  }

  const rect = boundsForPoints(
    options.filledAppearance ? points : inkAppearanceBoundsPoints(paths),
    options.filledAppearance ? 1 : width * 2
  );
  const appearanceRef = options.filledAppearance
    ? filledInkAppearance(page, paths, rect, annotation)
    : strokedInkAppearance(page, paths, rect, annotation, width);
  const annotationWidth = options.filledAppearance ? 0 : width;

  addAnnotation(page, {
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: rectToArray(rect),
    InkList: paths.map((path) =>
      path.flatMap((point) => [pdfCoordinate(point.x), pdfCoordinate(point.y)])
    ),
    ...annotationBase(options.id),
    C: pdfColor(annotation.color),
    CA: pdfOpacity(annotation.opacity),
    IT: annotation.kind === 'freehandHighlight' ? 'InkHighlight' : 'Ink',
    ...(appearanceRef ? { AP: { N: appearanceRef } } : {}),
    Border: [0, 0, annotationWidth],
    BS: {
      W: annotationWidth,
      S: 'S'
    }
  });
}

function filledInkAppearance(
  page: PDFPage,
  paths: PdfPoint[][],
  rect: PdfRect,
  annotation: InkAnnotation
) {
  const context = page.doc.context;
  const [x1, y1, x2, y2] = rectToArray(rect);
  const [r, g, b] = pdfColor(annotation.color);
  const opacity = pdfOpacity(annotation.opacity);
  const content = [
    'q',
    '/GS0 gs',
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    ...paths.map((path) => filledPathOperators(path, x1, y1)),
    'Q'
  ]
    .filter(Boolean)
    .join('\n');

  return context.register(
    context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, pdfCoordinate(x2 - x1), pdfCoordinate(y2 - y1)],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: {
        ExtGState: {
          GS0: {
            Type: 'ExtGState',
            ca: opacity,
            CA: opacity,
            BM: 'Multiply'
          }
        }
      }
    })
  );
}

function strokedInkAppearance(
  page: PDFPage,
  paths: PdfPoint[][],
  rect: PdfRect,
  annotation: InkAnnotation,
  width: number
) {
  const context = page.doc.context;
  const [x1, y1, x2, y2] = rectToArray(rect);
  const [r, g, b] = pdfColor(annotation.color);
  const opacity = pdfOpacity(annotation.opacity);
  const content = [
    'q',
    '/GS0 gs',
    '1 J',
    '1 j',
    `${pdfCoordinateNumber(width)} w`,
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} RG`,
    ...paths.map((path) => strokedPathOperators(path, x1, y1)),
    'Q'
  ]
    .filter(Boolean)
    .join('\n');

  return context.register(
    context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, pdfCoordinate(x2 - x1), pdfCoordinate(y2 - y1)],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: {
        ExtGState: {
          GS0: {
            Type: 'ExtGState',
            ca: opacity,
            CA: opacity,
            BM:
              annotation.kind === 'freehandHighlight' ? 'Multiply' : 'Normal'
          }
        }
      }
    })
  );
}

function filledPathOperators(path: PdfPoint[], offsetX: number, offsetY: number) {
  const vertices = polygonVertices(path);
  if (vertices.length < 3) {
    return '';
  }

  const [first, ...rest] = vertices;
  return [
    `${pdfCoordinateNumber(first.x - offsetX)} ${pdfCoordinateNumber(
      first.y - offsetY
    )} m`,
    ...rest.map(
      (point) =>
        `${pdfCoordinateNumber(point.x - offsetX)} ${pdfCoordinateNumber(
          point.y - offsetY
        )} l`
    ),
    'h',
    'f'
  ].join('\n');
}

function strokedPathOperators(
  path: PdfPoint[],
  offsetX: number,
  offsetY: number
) {
  const points = path.filter(isFinitePoint);
  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    return `${pdfCoordinateNumber(points[0].x - offsetX)} ${pdfCoordinateNumber(
      points[0].y - offsetY
    )} m\n${pdfCoordinateNumber(
      points[0].x - offsetX
    )} ${pdfCoordinateNumber(
      points[0].y - offsetY
    )} l\nS`;
  }

  const [first, ...rest] = points;
  return [
    ...inkPathCommands([first, ...rest]).map((command) => {
      if (command.type === 'move') {
        return `${pdfCoordinateNumber(
          command.point.x - offsetX
        )} ${pdfCoordinateNumber(command.point.y - offsetY)} m`;
      }

      if (command.type === 'line') {
        return `${pdfCoordinateNumber(
          command.point.x - offsetX
        )} ${pdfCoordinateNumber(command.point.y - offsetY)} l`;
      }

      return `${pdfCoordinateNumber(
        command.control1.x - offsetX
      )} ${pdfCoordinateNumber(
        command.control1.y - offsetY
      )} ${pdfCoordinateNumber(
        command.control2.x - offsetX
      )} ${pdfCoordinateNumber(
        command.control2.y - offsetY
      )} ${pdfCoordinateNumber(
        command.point.x - offsetX
      )} ${pdfCoordinateNumber(command.point.y - offsetY)} c`;
    }),
    'S'
  ]
    .filter(Boolean)
    .join('\n');
}

function inkAppearanceBoundsPoints(paths: PdfPoint[][]) {
  return paths.flatMap((path) =>
    inkPathCommands(path).flatMap((command) =>
      command.type === 'curve'
        ? [command.control1, command.control2, command.point]
        : [command.point]
    )
  );
}

function normalizeInkPath(path: PdfPoint[], width: number) {
  const finitePath = path.filter(isFinitePoint);
  if (finitePath.length === 0) {
    return finitePath;
  }

  const bounds = boundsForPoints(finitePath, 0);
  const minSize = Math.max(width, 0.5);
  if (
    finitePath.length > 1 &&
    (bounds.x2 - bounds.x1 >= minSize ||
      bounds.y2 - bounds.y1 >= minSize)
  ) {
    return finitePath;
  }

  const center = finitePath[Math.floor(finitePath.length / 2)] ?? finitePath[0];
  return dotPath(center, minSize);
}

function polygonVertices(path: PdfPoint[]) {
  const finitePath = path.filter(isFinitePoint);
  if (finitePath.length < 2) {
    return finitePath;
  }

  const first = finitePath[0];
  const last = finitePath[finitePath.length - 1];
  return Math.hypot(first.x - last.x, first.y - last.y) <= 0.01
    ? finitePath.slice(0, -1)
    : finitePath;
}

function removeSupportedExistingAnnotations(
  pdfDoc: PDFDocument,
  replacePageIndexes: Set<number> | null,
  replaceAnnotationSourceIds: Set<string> | null
) {
  // Keyed by "pageIndex:index" so the same malformed annotation isn't
  // double-counted across the two passes below.
  const malformedAnnotationKeys = new Set<string>();

  for (const [pageIndex, page] of pdfDoc.getPages().entries()) {
    if (replacePageIndexes && !replacePageIndexes.has(pageIndex)) {
      continue;
    }

    const annots = page.node.Annots();

    if (!annots) {
      continue;
    }

    const supportedAnnotationRefs = new Set<string>();
    for (let index = 0; index < annots.size(); index += 1) {
      try {
        const annotation = annots.lookupMaybe(index, PDFDict);
        const subtype = annotationSubtype(annotation);
        const annotationRef = annots.get(index);

        if (
          subtype &&
          isRemovableAnnotationSubtype(subtype, replaceAnnotationSourceIds) &&
          shouldRemoveSupportedAnnotation(
            annotation,
            annotationRef,
            pageIndex,
            index,
            replaceAnnotationSourceIds
          )
        ) {
          if (annotationRef instanceof PDFRef) {
            supportedAnnotationRefs.add(annotationRef.toString());
          }
        }
      } catch {
        // A malformed pre-existing annotation (a wrong-typed Rect, Subtype,
        // etc. - pdf-lib's lookupMaybe throws rather than returning undefined
        // for a present-but-wrong-typed value) shouldn't be able to abort the
        // whole save. Leave whatever we can't safely inspect alone, and count
        // it so the caller can let the user know something was skipped.
        malformedAnnotationKeys.add(`${pageIndex}:${index}`);
      }
    }

    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      try {
        const annotation = annots.lookupMaybe(index, PDFDict);
        const subtype = annotationSubtype(annotation);
        const annotationRef = annots.get(index);

        if (
          shouldRemoveExistingAnnotation(
            annotation,
            annotationRef,
            subtype,
            supportedAnnotationRefs,
            replaceAnnotationSourceIds,
            pageIndex,
            index
          )
        ) {
          annots.remove(index);
        }
      } catch {
        // Same as above - a single malformed existing annotation must not
        // block removal/preservation decisions for the rest of the page.
        malformedAnnotationKeys.add(`${pageIndex}:${index}`);
      }
    }
  }

  return malformedAnnotationKeys.size;
}

function removeAllExistingAnnotations(pdfDoc: PDFDocument) {
  for (const page of pdfDoc.getPages()) {
    page.node.delete(PDFName.of('Annots'));
  }
}

function annotationSubtype(annotation: PDFDict | undefined) {
  return annotation?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
}

function shouldRemoveExistingAnnotation(
  annotation: PDFDict | undefined,
  annotationRef: unknown,
  subtype: string | undefined,
  supportedAnnotationRefs: Set<string>,
  replaceAnnotationSourceIds: Set<string> | null,
  pageIndex: number,
  annotationIndex: number
) {
  if (!subtype || !annotation) {
    return false;
  }

  if (isRemovableAnnotationSubtype(subtype, replaceAnnotationSourceIds)) {
    return shouldRemoveSupportedAnnotation(
      annotation,
      annotationRef,
      pageIndex,
      annotationIndex,
      replaceAnnotationSourceIds
    );
  }

  if (subtype !== 'Popup') {
    return false;
  }

  return popupBelongsToSupportedAnnotation(
    annotation,
    supportedAnnotationRefs,
    replaceAnnotationSourceIds === null
  );
}

function isRemovableAnnotationSubtype(
  subtype: string,
  replaceAnnotationSourceIds: Set<string> | null
) {
  if (supportedAnnotationSubtypes.has(subtype)) {
    return true;
  }

  // Image stamps created by this app are editable only when we can match their
  // /NM id. Do not bulk-remove arbitrary Stamp annotations from other software.
  return subtype === 'Stamp' && replaceAnnotationSourceIds !== null;
}

function shouldRemoveSupportedAnnotation(
  annotation: PDFDict | undefined,
  annotationRef: unknown,
  pageIndex: number,
  annotationIndex: number,
  replaceAnnotationSourceIds: Set<string> | null
) {
  if (!replaceAnnotationSourceIds) {
    return true;
  }

  return annotationSourceKeys(
    pageIndex,
    annotationIndex,
    annotationRef,
    annotation
  ).some((sourceKey) => replaceAnnotationSourceIds.has(sourceKey));
}

function popupBelongsToSupportedAnnotation(
  annotation: PDFDict,
  supportedAnnotationRefs: Set<string>,
  allowSubtypeFallback = false
) {
  const parent = annotation.get(PDFName.of('Parent'));
  if (parent instanceof PDFRef && supportedAnnotationRefs.has(parent.toString())) {
    return true;
  }

  if (!allowSubtypeFallback) {
    return false;
  }

  const parentSubtype = annotationSubtype(
    annotation.lookupMaybe(PDFName.of('Parent'), PDFDict)
  );
  return Boolean(parentSubtype && supportedAnnotationSubtypes.has(parentSubtype));
}

function annotationSourceKeys(
  pageIndex: number,
  annotationIndex: number,
  ref: unknown,
  annotation?: PDFDict
) {
  const values = [
    ref instanceof PDFRef ? ref.toString() : null,
    pdfStringEntry(annotation, 'NM'),
    annotationGeometrySourceKey(annotation),
    `page:${pageIndex}:annotation-${annotationIndex}`
  ].filter((value): value is string => Boolean(value));
  return values.flatMap(sourceIdKeys);
}

function annotationGeometrySourceKey(annotation?: PDFDict) {
  const subtype = annotationSubtype(annotation)?.toLowerCase();
  const rect = pdfRectSourceKey(annotation);
  if (!subtype || !rect) {
    return '';
  }

  const contents = pdfStringEntry(annotation, 'Contents')?.trim();
  return `geom:${subtype}:${rect}:${contents ? textHash(contents) : 'empty'}`;
}

function pdfRectSourceKey(annotation?: PDFDict) {
  const rect = annotation?.lookupMaybe(PDFName.of('Rect'), PDFArray);
  if (!rect || rect.size() < 4) {
    return '';
  }

  const values = Array.from({ length: 4 }, (_, index) => {
    const value = rect.lookupMaybe(index, PDFNumber)?.asNumber();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
  if (!isFiniteNumberArray(values)) {
    return '';
  }

  return normalizedRectValues(values)
    .map((value) => sourceKeyNumber(value))
    .join(',');
}

function isFiniteNumberArray(values: Array<number | null>): values is number[] {
  return values.every(
    (value) => typeof value === 'number' && Number.isFinite(value)
  );
}

function pdfStringEntry(annotation: PDFDict | undefined, key: string) {
  return annotation
    ?.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)
    ?.decodeText();
}

function sourceIdKeySet(sourceIds: Iterable<string>) {
  const keys = new Set<string>();
  for (const sourceId of sourceIds) {
    for (const key of sourceIdKeys(sourceId)) {
      if (isUnsafeFallbackSourceIdPart(key)) {
        continue;
      }
      keys.add(key);
    }
  }
  return keys;
}

function sourceIdKeys(sourceId: string): string[] {
  const parts = sourceId
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const preciseParts = parts.filter((part) => !isFallbackSourceIdPart(part));
    const selectedParts = preciseParts.length > 0 ? preciseParts : parts;
    return Array.from(new Set(selectedParts.flatMap(sourceIdKeys)));
  }

  const normalized = sourceId.toLowerCase().replace(/\s+/g, '');
  const keys = new Set([normalized]);
  const refWithGeneration = sourceId.match(/^(\d+)\s+(\d+)\s+r$/i);
  if (refWithGeneration) {
    const [, objectNumber, generationNumber] = refWithGeneration;
    keys.add(`${objectNumber}${generationNumber}r`);
    if (generationNumber === '0') {
      keys.add(`${objectNumber}r`);
    }
  }

  const refWithoutGeneration = sourceId.match(/^(\d+)\s*r$/i);
  if (refWithoutGeneration) {
    const [, objectNumber] = refWithoutGeneration;
    keys.add(`${objectNumber}r`);
    keys.add(`${objectNumber}0r`);
  }

  return Array.from(keys);
}

function isFallbackSourceIdPart(sourceId: string) {
  const normalized = sourceId.trim().toLowerCase();
  return normalized.startsWith('geom:') || normalized.startsWith('page:');
}

function isUnsafeFallbackSourceIdPart(sourceId: string) {
  return sourceId.trim().toLowerCase().startsWith('page:');
}

function addAnnotation(page: PDFPage, object: Record<string, unknown>) {
  const context = page.doc.context;
  let annots = page.node.Annots();

  if (!annots) {
    annots = context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }

  annots.push(
    context.register(
      context.obj({
        P: page.ref,
        ...object
      } as any)
    )
  );
}

function boundsForRects(rects: PdfRect[]) {
  return rects.reduce(
    (bounds, rect) => ({
      x1: Math.min(bounds.x1, rect.x1, rect.x2),
      y1: Math.min(bounds.y1, rect.y1, rect.y2),
      x2: Math.max(bounds.x2, rect.x1, rect.x2),
      y2: Math.max(bounds.y2, rect.y1, rect.y2)
    }),
    {
      x1: Number.POSITIVE_INFINITY,
      y1: Number.POSITIVE_INFINITY,
      x2: Number.NEGATIVE_INFINITY,
      y2: Number.NEGATIVE_INFINITY
    }
  );
}

function boundsForPoints(points: PdfPoint[], padding: number) {
  const bounds = points.reduce(
    (result, point) => ({
      x1: Math.min(result.x1, point.x),
      y1: Math.min(result.y1, point.y),
      x2: Math.max(result.x2, point.x),
      y2: Math.max(result.y2, point.y)
    }),
    {
      x1: Number.POSITIVE_INFINITY,
      y1: Number.POSITIVE_INFINITY,
      x2: Number.NEGATIVE_INFINITY,
      y2: Number.NEGATIVE_INFINITY
    }
  );

  return {
    x1: bounds.x1 - padding,
    y1: bounds.y1 - padding,
    x2: bounds.x2 + padding,
    y2: bounds.y2 + padding
  };
}

function rectToArray(rect: PdfRect) {
  return [
    pdfCoordinate(Math.min(rect.x1, rect.x2)),
    pdfCoordinate(Math.min(rect.y1, rect.y2)),
    pdfCoordinate(Math.max(rect.x1, rect.x2)),
    pdfCoordinate(Math.max(rect.y1, rect.y2))
  ];
}

function normalizedQuadPoints(quadPoints: number[][], rects: PdfRect[]) {
  const finiteQuadPoints = quadPoints.filter(
    (quad) => quad.length === 8 && quad.every(Number.isFinite)
  );
  return finiteQuadPoints.length > 0
    ? finiteQuadPoints
    : rects.map(rectToQuadPoints);
}

function isUsableRect(rect: PdfRect) {
  return (
    Number.isFinite(rect.x1) &&
    Number.isFinite(rect.y1) &&
    Number.isFinite(rect.x2) &&
    Number.isFinite(rect.y2) &&
    Math.abs(rect.x2 - rect.x1) > 0 &&
    Math.abs(rect.y2 - rect.y1) > 0
  );
}

function isFinitePoint(point: PdfPoint) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function pdfColor(color: [number, number, number]): [number, number, number] {
  return [
    pdfRatio(clampPdfNumber(color[0], 0, 1, 0)),
    pdfRatio(clampPdfNumber(color[1], 0, 1, 0)),
    pdfRatio(clampPdfNumber(color[2], 0, 1, 0))
  ];
}

function pdfOpacity(opacity: number) {
  return pdfRatio(clampPdfNumber(opacity, 0, 1, 1));
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pdfStrokeWidth(width: number) {
  return pdfCoordinate(clampPdfNumber(width, 0.1, 72, 1));
}

function pdfFontSize(fontSize: number) {
  return pdfCoordinate(clampPdfNumber(fontSize, 1, 144, 16));
}

function pdfNumber(value: number) {
  return Number(value.toFixed(4)).toString();
}

function pdfCoordinate(value: number) {
  return roundPdfNumber(value, PDF_COORDINATE_PRECISION);
}

function pdfCoordinateNumber(value: number) {
  return pdfCoordinate(value).toString();
}

function pdfRatio(value: number) {
  return roundPdfNumber(value, PDF_RATIO_PRECISION);
}

function roundPdfNumber(value: number, precision: number) {
  const decimals = Math.max(0, Math.ceil(-Math.log10(precision)));
  return Number((Math.round(value / precision) * precision).toFixed(decimals));
}

function pdfDate(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');

  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate()
  )}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds()
  )}Z`;
}
