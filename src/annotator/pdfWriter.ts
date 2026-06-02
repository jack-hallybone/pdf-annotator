import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFNumber,
  PDFString,
  PDFFont,
  StandardFonts,
  degrees
} from 'pdf-lib';
import {
  dotPath,
  pathLooksClosed,
  rectToQuadPoints
} from './annotationGeometry';
import {
  FREE_TEXT_LINE_HEIGHT,
  freeTextContentRect,
  freeTextVisualLines
} from './freeTextLayout';
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

export async function addBlankPageAt(
  bytes: Uint8Array,
  pageIndex: number,
  templatePageIndex: number
) {
  const pdfDoc = await PDFDocument.load(bytes);
  const sourcePage = pdfDoc.getPage(templatePageIndex);
  const { width, height } = sourcePage.getSize();
  pdfDoc.insertPage(pageIndex, [width, height]);
  return pdfDoc.save();
}

export async function removePage(bytes: Uint8Array, pageIndex: number) {
  const pdfDoc = await PDFDocument.load(bytes);
  if (pdfDoc.getPageCount() <= 1) {
    throw new Error('A PDF must keep at least one page.');
  }

  pdfDoc.removePage(pageIndex);
  return pdfDoc.save();
}

export async function rotatePageClockwise(bytes: Uint8Array, pageIndex: number) {
  const pdfDoc = await PDFDocument.load(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const currentAngle = page.getRotation().angle;
  page.setRotation(degrees((currentAngle + 90) % 360));
  return pdfDoc.save();
}

export async function mergePdfAfterPage(
  bytes: Uint8Array,
  mergeBytes: Uint8Array,
  afterPageIndex: number
) {
  const pdfDoc = await PDFDocument.load(bytes);
  const mergeDoc = await PDFDocument.load(mergeBytes);
  const pageIndexes = mergeDoc.getPageIndices();
  const copiedPages = await pdfDoc.copyPages(mergeDoc, pageIndexes);
  const insertAt = Math.min(
    Math.max(afterPageIndex + 1, 0),
    pdfDoc.getPageCount()
  );

  copiedPages.forEach((page, index) => {
    pdfDoc.insertPage(insertAt + index, page);
  });

  return {
    bytes: await pdfDoc.save(),
    insertedPageCount: copiedPages.length
  };
}

export async function writePdfAnnotations(
  bytes: Uint8Array,
  annotations: PdfAnnotation[],
  options: {
    replaceAnnotationSourceIds?: Iterable<string>;
    replacePageIndexes?: Iterable<number>;
  } = {}
) {
  const pdfDoc = await PDFDocument.load(bytes);
  const replacePageIndexes = options.replacePageIndexes
    ? new Set(options.replacePageIndexes)
    : null;
  const replaceAnnotationSourceIds = options.replaceAnnotationSourceIds
    ? sourceIdKeySet(options.replaceAnnotationSourceIds)
    : null;
  if (replaceAnnotationSourceIds === null || replaceAnnotationSourceIds.size > 0) {
    removeSupportedExistingAnnotations(
      pdfDoc,
      replacePageIndexes,
      replaceAnnotationSourceIds
    );
  }

  let freeTextFont: PDFFont | null = null;

  for (const annotation of annotations) {
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
      if (annotation.text.trim().length === 0) {
        continue;
      }

      if (!isUsableRect(annotation.rect)) {
        continue;
      }

      const fontSize = pdfFontSize(annotation.fontSize);
      const [r, g, b] = pdfColor(annotation.color);
      const rect = freeTextContentRect(
        annotation.rect,
        annotation.text,
        fontSize,
        { layoutWidth: annotation.layoutWidth }
      );
      freeTextFont ??= await pdfDoc.embedFont(StandardFonts.Helvetica);
      addAnnotation(page, {
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: rectToArray(rect),
        Contents: PDFString.of(annotation.text),
        ...annotationBase(annotation.id),
        CA: pdfOpacity(annotation.opacity),
        DA: PDFString.of(
          `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg /Helv ${fontSize} Tf`
        ),
        DR: {
          Font: {
            Helv: freeTextFont.ref
          }
        },
        AP: {
          N: freeTextAppearance(
            page,
            rect,
            annotation.text,
            fontSize,
            annotation.color,
            annotation.opacity,
            freeTextFont
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
        Contents: PDFString.of(annotation.text),
        ...annotationBase(annotation.id),
        Name: 'Note',
        Open: false,
        C: pdfColor(annotation.color),
        AP: {
          N: stickyNoteAppearance(page, annotation.rect, annotation.color)
        }
      });
    }
  }

  return pdfDoc.save();
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
  font: PDFFont
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
    `/Helv ${pdfCoordinateNumber(fontSize)} Tf`,
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
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: {
        ExtGState: {
          GS0: {
            Type: 'ExtGState',
            ca: pdfOpacity(opacity),
            CA: pdfOpacity(opacity)
          }
        },
        Font: {
          Helv: font.ref
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

function encodedAppearanceText(font: PDFFont, text: string) {
  try {
    return font.encodeText(text).toString();
  } catch {
    return font
      .encodeText(
        Array.from(text)
          .map((character) => (fontCanEncode(font, character) ? character : '?'))
          .join('')
      )
      .toString();
  }
}

function fontCanEncode(font: PDFFont, text: string) {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
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

  const rect = boundsForPoints(points, options.filledAppearance ? 1 : width * 2);
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
    `${pdfCoordinateNumber(first.x - offsetX)} ${pdfCoordinateNumber(
      first.y - offsetY
    )} m`,
    ...rest.map(
      (point) =>
        `${pdfCoordinateNumber(point.x - offsetX)} ${pdfCoordinateNumber(
          point.y - offsetY
        )} l`
    ),
    'S'
  ]
    .filter(Boolean)
    .join('\n');
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
      const annotation = annots.lookupMaybe(index, PDFDict);
      const subtype = annotationSubtype(annotation);
      const annotationRef = annots.get(index);

      if (
        subtype &&
        supportedAnnotationSubtypes.has(subtype) &&
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
    }

    for (let index = annots.size() - 1; index >= 0; index -= 1) {
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
    }
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

  if (supportedAnnotationSubtypes.has(subtype)) {
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

  return popupBelongsToSupportedAnnotation(annotation, supportedAnnotationRefs);
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
  supportedAnnotationRefs: Set<string>
) {
  const parent = annotation.get(PDFName.of('Parent'));
  if (parent instanceof PDFRef && supportedAnnotationRefs.has(parent.toString())) {
    return true;
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

function normalizedRectValues(values: number[]) {
  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3])
  ];
}

function sourceKeyNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}

function textHash(text: string) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
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
    return Array.from(new Set(parts.flatMap(sourceIdKeys)));
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

function clampPdfNumber(
  value: number,
  min: number,
  max: number,
  fallback: number
) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function pdfDate(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');

  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate()
  )}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds()
  )}Z`;
}
