import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  degrees
} from 'pdf-lib';
import type { InkAnnotation, PdfAnnotation, PdfPoint, PdfRect } from './types';

const printFlag = 4;
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
        QuadPoints: quadPoints.flat(),
        ...annotationBase(annotation.id),
        C: pdfColor(annotation.color),
        CA: pdfOpacity(annotation.opacity)
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
      const rect = freeTextContentRect(annotation, fontSize);
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
        C: pdfColor(annotation.color)
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
      path.flatMap((point) => [point.x, point.y])
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
      BBox: [0, 0, x2 - x1, y2 - y1],
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
    `${pdfNumber(width)} w`,
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
      BBox: [0, 0, x2 - x1, y2 - y1],
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
    `${pdfNumber(first.x - offsetX)} ${pdfNumber(first.y - offsetY)} m`,
    ...rest.map(
      (point) =>
        `${pdfNumber(point.x - offsetX)} ${pdfNumber(point.y - offsetY)} l`
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
    return `${pdfNumber(points[0].x - offsetX)} ${pdfNumber(
      points[0].y - offsetY
    )} m\n${pdfNumber(points[0].x - offsetX)} ${pdfNumber(
      points[0].y - offsetY
    )} l\nS`;
  }

  const [first, ...rest] = points;
  return [
    `${pdfNumber(first.x - offsetX)} ${pdfNumber(first.y - offsetY)} m`,
    ...catmullRomSegments(points, offsetX, offsetY),
    rest.length === 1
      ? `${pdfNumber(rest[0].x - offsetX)} ${pdfNumber(rest[0].y - offsetY)} l`
      : '',
    'S'
  ]
    .filter(Boolean)
    .join('\n');
}

function catmullRomSegments(
  points: PdfPoint[],
  offsetX: number,
  offsetY: number
) {
  if (points.length < 3) {
    return [];
  }

  const segments: string[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const c1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6
    };
    const c2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6
    };
    segments.push(
      `${pdfNumber(c1.x - offsetX)} ${pdfNumber(c1.y - offsetY)} ${pdfNumber(
        c2.x - offsetX
      )} ${pdfNumber(c2.y - offsetY)} ${pdfNumber(
        p2.x - offsetX
      )} ${pdfNumber(p2.y - offsetY)} c`
    );
  }

  return segments;
}

function normalizeInkPath(path: PdfPoint[], width: number) {
  const finitePath = path.filter(isFinitePoint);
  if (finitePath.length === 0) {
    return finitePath;
  }

  const bounds = boundsForPoints(finitePath, 0);
  const minSize = Math.max(width, 1.5);
  if (
    finitePath.length > 1 &&
    (bounds.x2 - bounds.x1 >= minSize ||
      bounds.y2 - bounds.y1 >= minSize)
  ) {
    return finitePath;
  }

  const center = finitePath[Math.floor(finitePath.length / 2)] ?? finitePath[0];
  const radius = minSize / 2;
  return [
    { x: center.x - radius, y: center.y },
    { x: center.x, y: center.y + radius },
    { x: center.x + radius, y: center.y },
    { x: center.x, y: center.y - radius },
    { x: center.x - radius, y: center.y }
  ];
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

function pathLooksClosed(path: PdfPoint[]) {
  if (path.length < 4) {
    return false;
  }

  const finitePath = path.filter(isFinitePoint);
  if (finitePath.length < 4) {
    return false;
  }

  const first = finitePath[0];
  const last = finitePath[finitePath.length - 1];
  const bounds = boundsForPoints(finitePath, 0);
  const diagonal = Math.hypot(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1);
  const closingDistance = Math.hypot(first.x - last.x, first.y - last.y);
  return closingDistance <= Math.max(2, diagonal * 0.03);
}

function freeTextContentRect(
  annotation: Extract<PdfAnnotation, { kind: 'freeText' }>,
  fontSize: number
) {
  const lines = annotation.text.split(/\r?\n/);
  const longestLine = Math.max(...lines.map((line) => line.length), 1);
  const width = Math.min(
    Math.max(longestLine * fontSize * 0.58, fontSize * 3),
    Math.abs(annotation.rect.x2 - annotation.rect.x1)
  );
  const height = Math.min(
    Math.max(lines.length * fontSize * 1.25, fontSize * 1.5),
    Math.abs(annotation.rect.y2 - annotation.rect.y1)
  );
  const x1 = Math.min(annotation.rect.x1, annotation.rect.x2);
  const y2 = Math.max(annotation.rect.y1, annotation.rect.y2);

  return {
    x1,
    y1: y2 - height,
    x2: x1 + width,
    y2
  };
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
        annotationRef instanceof PDFRef &&
        shouldRemoveSupportedAnnotation(
          annotation,
          annotationRef,
          replaceAnnotationSourceIds
        )
      ) {
        supportedAnnotationRefs.add(annotationRef.toString());
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
          replaceAnnotationSourceIds
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
  replaceAnnotationSourceIds: Set<string> | null
) {
  if (!subtype || !annotation) {
    return false;
  }

  if (supportedAnnotationSubtypes.has(subtype)) {
    return (
      annotationRef instanceof PDFRef &&
      shouldRemoveSupportedAnnotation(
        annotation,
        annotationRef,
        replaceAnnotationSourceIds
      )
    );
  }

  if (subtype !== 'Popup') {
    return false;
  }

  return popupBelongsToSupportedAnnotation(annotation, supportedAnnotationRefs);
}

function shouldRemoveSupportedAnnotation(
  annotation: PDFDict | undefined,
  annotationRef: PDFRef,
  replaceAnnotationSourceIds: Set<string> | null
) {
  if (!replaceAnnotationSourceIds) {
    return true;
  }

  return annotationSourceKeys(annotationRef, annotation).some((sourceKey) =>
    replaceAnnotationSourceIds.has(sourceKey)
  );
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

function annotationSourceKeys(ref: PDFRef, annotation?: PDFDict) {
  const values = [ref.toString(), pdfStringEntry(annotation, 'NM')].filter(
    (value): value is string => Boolean(value)
  );
  return values.flatMap(sourceIdKeys);
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

function sourceIdKeys(sourceId: string) {
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
    Math.min(rect.x1, rect.x2),
    Math.min(rect.y1, rect.y2),
    Math.max(rect.x1, rect.x2),
    Math.max(rect.y1, rect.y2)
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

function rectToQuadPoints(rect: PdfRect) {
  return [
    rect.x1,
    rect.y2,
    rect.x2,
    rect.y2,
    rect.x1,
    rect.y1,
    rect.x2,
    rect.y1
  ];
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
    clampPdfNumber(color[0], 0, 1, 0),
    clampPdfNumber(color[1], 0, 1, 0),
    clampPdfNumber(color[2], 0, 1, 0)
  ];
}

function pdfOpacity(opacity: number) {
  return clampPdfNumber(opacity, 0, 1, 1);
}

function pdfStrokeWidth(width: number) {
  return clampPdfNumber(width, 0.1, 72, 1);
}

function pdfFontSize(fontSize: number) {
  return clampPdfNumber(fontSize, 1, 144, 16);
}

function pdfNumber(value: number) {
  return Number(value.toFixed(4)).toString();
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
