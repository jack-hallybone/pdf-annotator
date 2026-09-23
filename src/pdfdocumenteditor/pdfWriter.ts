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
  StandardFonts,
} from "pdf-lib";
import type { PDFDocument } from "pdf-lib";
import {
  appearanceRotationMatrix,
  boundsForPoints,
  boundsForRects,
  dotPath,
  inkPathCommands,
  isFinitePoint,
  pathLooksClosed,
  rectToQuadPoints,
  rotatedAnnotationRect,
} from "./annotationGeometry";
import {
  UNRESOLVED_SOURCE_ID_PREFIX,
  canonicalPdfReferenceKey,
  clampPdfNumber,
  directSourceId,
  directSourcePosition,
  normalizedRectValues,
  sourceKeyNumber,
  textHash,
  unresolvedSourceId,
  unresolvedSourceReason,
} from "./annotationSourceKey";
import {
  FREE_TEXT_LINE_HEIGHT,
  freeTextContentRect,
  freeTextVisualLines,
} from "./freeTextLayout";
import type { PdfPageMapping } from "./pageIdentity";
import { ANNOTATION_BOOKMARK_KEY } from "./annotationBookmarkKey";
import { normalizeAnnotationComment } from "./annotationComments";
import { loadEditablePdf, saveEditedPdf } from "./pdfPageOperations";
import type { InkAnnotation, PdfAnnotation, PdfPoint, PdfRect } from "./types";

const printFlag = 4;
const MAX_ANNOTATION_ID_LENGTH = 512;
const MAX_ANNOTATION_SOURCE_ID_LENGTH = 4096;
const PDF_COORDINATE_PRECISION = 0.01;
const PDF_RATIO_PRECISION = 0.001;
const supportedAnnotationSubtypes = new Set([
  "Highlight",
  "Ink",
  "FreeText",
  "Text",
]);
const freeTextFontResourceName = "Helvetica";
const winAnsiExtraCodePoints = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6,
  0x02dc, 0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e,
  0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

export class UnsupportedAnnotationTextError extends Error {
  annotationId: string;
  annotationKind: PdfAnnotation["kind"];
  characters: string[];
  pageIndex: number;

  constructor({
    annotationId,
    annotationKind,
    characters,
    pageIndex,
  }: {
    annotationId: string;
    annotationKind: PdfAnnotation["kind"];
    characters: string[];
    pageIndex: number;
  }) {
    const label =
      annotationKind === "stickyNote" ? "note annotation" : "text annotation";
    super(
      `A ${label} on page ${pageIndex + 1} contains unsupported ${characters.length === 1 ? "character" : "characters"} (${formatUnsupportedCharacters(characters)})`,
    );
    this.annotationId = annotationId;
    this.annotationKind = annotationKind;
    this.characters = characters;
    this.name = "UnsupportedAnnotationTextError";
    this.pageIndex = pageIndex;
  }
}

export class PdfAnnotationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfAnnotationIntegrityError";
  }
}

type ExistingAnnotationTarget = {
  annotation: PDFDict;
  entry: PDFDict | PDFRef;
  pageIndex: number;
};

type WritePdfAnnotationsOptions = {
  removeAllAnnotations?: boolean;
  removeUnmatchedSupportedAnnotations?: boolean;
  replaceAnnotationSourceIds?: Iterable<string>;
  replacePageIndexes?: Iterable<number>;
  onMalformedExistingAnnotations?: (count: number) => void;
};

// For a caller that is not making these bytes its next baseline; every save
// must use writeAnnotatedPdf and carry its `sources` back into the session.
export async function writePdfAnnotations(
  bytes: Uint8Array,
  annotations: PdfAnnotation[],
  options: WritePdfAnnotationsOptions = {},
) {
  return (await writeAnnotatedPdf(bytes, annotations, options)).bytes;
}

export async function writeAnnotatedPdf(
  bytes: Uint8Array,
  annotations: PdfAnnotation[],
  options: WritePdfAnnotationsOptions = {},
): Promise<{ bytes: Uint8Array; sources: WrittenAnnotationSources }> {
  assertAnnotationsTextIsSupported(annotations);
  const pdfDoc = await loadEditablePdf(bytes);
  // Before anything is removed, updated or pushed: this is the layout the
  // identities handed in were minted against.
  const entriesBefore = captureAnnotsEntryPositions(pdfDoc);
  const replacePageIndexes = options.replacePageIndexes
    ? new Set(options.replacePageIndexes)
    : null;
  const requestedReplacementSourceIds = options.replaceAnnotationSourceIds
    ? Array.from(options.replaceAnnotationSourceIds)
    : [];
  const { handledSourceIds, targets: updateTargets } =
    options.removeAllAnnotations || options.removeUnmatchedSupportedAnnotations
      ? {
          handledSourceIds: new Set<string>(),
          targets: new Map<string, ExistingAnnotationTarget>(),
        }
      : resolveAnnotationUpdateTargets(
          pdfDoc,
          annotations,
          requestedReplacementSourceIds,
        );
  const replaceAnnotationSourceIds =
    requestedReplacementSourceIds.length > 0
      ? sourceIdKeySet(
          requestedReplacementSourceIds.filter(
            (sourceId) => !handledSourceIds.has(sourceId),
          ),
        )
      : null;
  if (replaceAnnotationSourceIds?.size) {
    if (
      !options.removeAllAnnotations &&
      !options.removeUnmatchedSupportedAnnotations
    ) {
      assertReplacementKeysAreResolved(replaceAnnotationSourceIds);
    }
    const replacementCounts = assertReplacementKeysAreUnique(
      pdfDoc,
      replacePageIndexes,
      replaceAnnotationSourceIds,
    );
    if (
      !options.removeAllAnnotations &&
      !options.removeUnmatchedSupportedAnnotations
    ) {
      assertReplacementKeysWereFound(
        replaceAnnotationSourceIds,
        replacementCounts,
      );
    }
  }
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
        : replaceAnnotationSourceIds,
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
    let updateTarget = updateTargets.get(annotation.id);
    const takeUpdateTarget = () => {
      const target = updateTarget;
      updateTarget = undefined;
      return target;
    };

    if (annotation.kind === "textHighlight") {
      const rects = annotation.rects.filter(isUsableRect);
      const quadPoints = normalizedQuadPoints(annotation.quadPoints, rects);

      if (rects.length === 0 || quadPoints.length === 0) {
        continue;
      }

      addAnnotation(
        page,
        {
          Type: "Annot",
          Subtype: "Highlight",
          Rect: rectToArray(boundsForRects(rects)),
          QuadPoints: quadPoints.flatMap((quad) =>
            Array.from(quad, pdfCoordinate),
          ),
          ...annotationBase(annotation.id),
          ...annotationCommentEntry(annotation.comment),
          ...annotationBookmarkEntry(annotation),
          C: pdfColor(annotation.color),
          CA: pdfOpacity(annotation.opacity),
          AP: {
            N: highlightAppearance(page, rects, annotation),
          },
        },
        takeUpdateTarget(),
        clearedAnnotationKeys(annotation, annotation.comment),
      );
      continue;
    }

    if (annotation.kind === "draw" || annotation.kind === "freehandHighlight") {
      const width = pdfStrokeWidth(annotation.width);
      const paths = annotation.paths
        .map((path) => normalizeInkPath(path, width))
        .filter((path) => path.length > 0);
      const filledPaths =
        annotation.kind === "freehandHighlight" && annotation.filled
          ? paths.filter(pathLooksClosed)
          : [];

      if (filledPaths.length > 0) {
        addInkAnnotation(page, annotation, filledPaths, width, {
          filledAppearance: true,
          id:
            filledPaths.length === paths.length
              ? annotation.id
              : `${annotation.id}-fill`,
          updateTarget: takeUpdateTarget(),
        });
      }

      const filledPathSet = new Set(filledPaths);
      const strokedPaths =
        filledPaths.length > 0
          ? paths.filter((path) => !filledPathSet.has(path))
          : paths;
      if (strokedPaths.length === 0) {
        continue;
      }

      addInkAnnotation(page, annotation, strokedPaths, width, {
        id: filledPaths.length > 0 ? `${annotation.id}-stroke` : annotation.id,
        updateTarget: takeUpdateTarget(),
      });
      continue;
    }

    if (annotation.kind === "freeText") {
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
      // freeTextContentRect lays out against an un-rotated rect, so it needs
      // the local footprint, not `annotation.rect`'s rotated on-page one.
      const rect = freeTextContentRect(
        rotatedAnnotationRect(annotation.rect, rotation),
        text,
        fontSize,
        { layoutWidth: annotation.layoutWidth },
      );
      freeTextFont ??= await pdfDoc.embedFont(StandardFonts.Helvetica);
      addAnnotation(
        page,
        {
          Type: "Annot",
          Subtype: "FreeText",
          Rect: rectToArray(rotatedAnnotationRect(rect, rotation)),
          Contents: pdfTextString(text),
          ...annotationBase(annotation.id),
          ...annotationBookmarkEntry(annotation),
          CA: pdfOpacity(annotation.opacity),
          DA: PDFString.of(
            `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg /${freeTextFontResourceName} ${fontSize} Tf`,
          ),
          DR: {
            Font: {
              [freeTextFontResourceName]: freeTextFont.ref,
            },
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
              rotation,
            ),
          },
          IT: "FreeTextTypeWriter",
          Q: 0,
          Border: [0, 0, 0],
          BS: {
            W: 0,
            S: "S",
          },
          RD: [0, 0, 0, 0],
        },
        takeUpdateTarget(),
        clearedAnnotationKeys(annotation, text),
      );
      continue;
    }

    if (annotation.kind === "stickyNote") {
      if (annotation.text.trim().length === 0) {
        continue;
      }

      if (!isUsableRect(annotation.rect)) {
        continue;
      }

      addAnnotation(
        page,
        {
          Type: "Annot",
          Subtype: "Text",
          Rect: rectToArray(annotation.rect),
          Contents: pdfTextString(annotation.text),
          ...annotationBase(annotation.id),
          ...annotationBookmarkEntry(annotation),
          Name: "Note",
          Open: false,
          C: pdfColor(annotation.color),
          AP: {
            N: stickyNoteAppearance(page, annotation.rect, annotation.color),
          },
        },
        takeUpdateTarget(),
        clearedAnnotationKeys(annotation, annotation.text),
      );
      continue;
    }

    if (annotation.kind === "imageStamp") {
      if (!isUsableRect(annotation.rect) || annotation.imageData.length === 0) {
        continue;
      }

      const image = await pdfDoc.embedPng(base64ToBytes(annotation.imageData));
      const imageRotation = annotation.rotation ?? 0;
      addAnnotation(
        page,
        {
          Type: "Annot",
          Subtype: "Stamp",
          Rect: rectToArray(
            rotatedAnnotationRect(annotation.rect, imageRotation),
          ),
          ...annotationBase(annotation.id),
          ...annotationCommentEntry(annotation.comment),
          ...annotationBookmarkEntry(annotation),
          Name: "Image",
          AP: {
            N: imageStampAppearance(
              page,
              annotation.rect,
              image.ref,
              imageRotation,
            ),
          },
        },
        takeUpdateTarget(),
        clearedAnnotationKeys(annotation, annotation.comment),
      );
    }
  }

  const output = await saveEditedPdf(pdfDoc);
  // After saveEditedPdf, not before: stripping signature widgets shifts every
  // direct dictionary behind them.
  return {
    bytes: output,
    sources: writtenAnnotationSources(
      entriesBefore,
      captureAnnotsEntryPositions(pdfDoc),
    ),
  };
}

function annotationWriteOrder(left: PdfAnnotation, right: PdfAnnotation) {
  return annotationWriteRank(left) - annotationWriteRank(right);
}

function annotationWriteRank(annotation: PdfAnnotation) {
  switch (annotation.kind) {
    case "textHighlight":
      return 0;
    case "imageStamp":
      return 1;
    case "freehandHighlight":
      return 2;
    case "draw":
      return 3;
    case "freeText":
      return 4;
    case "stickyNote":
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
    // PDFString.of does not escape PDF literal delimiters, and ids can enter
    // via the exported host API, so /NM is written as a hex string.
    NM: PDFHexString.fromText(id),
    M: date,
    CreationDate: date,
    F: printFlag,
  };
}

type AppearanceDict = NonNullable<
  Parameters<PDFPage["doc"]["context"]["flateStream"]>[1]
>;

// Every appearance is the same Form XObject envelope; only the content stream,
// the box and the resources differ.
function registerAppearanceStream(
  page: PDFPage,
  content: string,
  {
    width,
    height,
    matrix = [1, 0, 0, 1, 0, 0],
    resources,
  }: {
    width: number;
    height: number;
    matrix?: number[];
    resources?: AppearanceDict;
  },
) {
  const context = page.doc.context;
  return context.register(
    context.flateStream(content, {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [0, 0, width, height],
      Matrix: matrix,
      ...(resources ? { Resources: resources } : {}),
    }),
  );
}

function opacityResources(opacity: number, blendMode?: string): AppearanceDict {
  return {
    ExtGState: {
      GS0: {
        Type: "ExtGState",
        ca: opacity,
        CA: opacity,
        ...(blendMode ? { BM: blendMode } : {}),
      },
    },
  };
}

function highlightAppearance(
  page: PDFPage,
  rects: PdfRect[],
  annotation: Extract<PdfAnnotation, { kind: "textHighlight" }>,
) {
  const rect = boundsForRects(rects);
  const [x1, y1, x2, y2] = rectToArray(rect);
  const [r, g, b] = pdfColor(annotation.color);
  const content = [
    "q",
    "/GS0 gs",
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    ...rects.map((highlightRect) => filledRectOperators(highlightRect, x1, y1)),
    "Q",
  ].join("\n");

  return registerAppearanceStream(page, content, {
    width: pdfCoordinate(x2 - x1),
    height: pdfCoordinate(y2 - y1),
    resources: opacityResources(pdfOpacity(annotation.opacity), "Multiply"),
  });
}

function freeTextAppearance(
  page: PDFPage,
  rect: PdfRect,
  text: string,
  fontSize: number,
  color: [number, number, number],
  opacity: number,
  font: PDFFont,
  rotation = 0,
) {
  const [x1, y1, x2, y2] = rectToArray(rect);
  const width = pdfCoordinate(x2 - x1);
  const height = pdfCoordinate(y2 - y1);
  const [r, g, b] = pdfColor(color);
  const lineHeight = pdfCoordinate(fontSize * FREE_TEXT_LINE_HEIGHT);
  const baselineY = Math.max(0, height - fontSize);
  const lines = freeTextVisualLines(text, fontSize, width);
  const content = [
    "q",
    "/GS0 gs",
    "BT",
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    `/${freeTextFontResourceName} ${pdfCoordinateNumber(fontSize)} Tf`,
    `${pdfCoordinateNumber(lineHeight)} TL`,
    `0 ${pdfCoordinateNumber(baselineY)} Td`,
    lines
      .map(
        (line, index) =>
          `${index === 0 ? "" : "T*\n"}${encodedAppearanceText(font, line)} Tj`,
      )
      .join("\n"),
    "ET",
    "Q",
  ].join("\n");

  return registerAppearanceStream(page, content, {
    width,
    height,
    matrix: appearanceRotationMatrix(rotation, width, height),
    resources: {
      ...opacityResources(pdfOpacity(opacity)),
      Font: {
        [freeTextFontResourceName]: font.ref,
      },
    },
  });
}

function stickyNoteAppearance(
  page: PDFPage,
  rect: PdfRect,
  color: [number, number, number],
) {
  const [x1, y1, x2, y2] = rectToArray(rect);
  const width = pdfCoordinate(x2 - x1);
  const height = pdfCoordinate(y2 - y1);
  const fold = pdfCoordinate(Math.min(width, height) * 0.32);
  const [r, g, b] = pdfColor(color);
  const content = [
    "q",
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    `${pdfNumber(r * 0.72)} ${pdfNumber(g * 0.72)} ${pdfNumber(b * 0.72)} RG`,
    "0.75 w",
    `0 0 ${pdfCoordinateNumber(width)} ${pdfCoordinateNumber(height)} re`,
    "B",
    `${pdfCoordinateNumber(width - fold)} ${pdfCoordinateNumber(height)} m`,
    `${pdfCoordinateNumber(width - fold)} ${pdfCoordinateNumber(height - fold)} l`,
    `${pdfCoordinateNumber(width)} ${pdfCoordinateNumber(height - fold)} l`,
    "S",
    "Q",
  ].join("\n");

  return registerAppearanceStream(page, content, { width, height });
}

function imageStampAppearance(
  page: PDFPage,
  rect: PdfRect,
  imageRef: PDFRef,
  rotation = 0,
) {
  const [x1, y1, x2, y2] = rectToArray(rect);
  const width = pdfCoordinate(x2 - x1);
  const height = pdfCoordinate(y2 - y1);
  const content = [
    "q",
    `${pdfCoordinateNumber(width)} 0 0 ${pdfCoordinateNumber(height)} 0 0 cm`,
    "/Im0 Do",
    "Q",
  ].join("\n");

  return registerAppearanceStream(page, content, {
    width,
    height,
    matrix: appearanceRotationMatrix(rotation, width, height),
    resources: {
      XObject: {
        Im0: imageRef,
      },
    },
  });
}

function encodedAppearanceText(font: PDFFont, text: string) {
  return font.encodeText(text).toString();
}

function pdfTextString(text: string) {
  // PDFString.of() does not escape '(', ')' or '\', so a note as ordinary as
  // ":)" terminates the literal early and corrupts the object.
  const literal = PDFString.of(text);
  if (/[()\\]/.test(text) || literal.decodeText() !== text) {
    return PDFHexString.fromText(text);
  }
  return literal;
}

export function assertAnnotationsTextIsSupported(annotations: PdfAnnotation[]) {
  assertAnnotationIdsAreSafe(annotations);
  for (const annotation of annotations) {
    const unsupported = unsupportedAnnotationTextCharacters(annotation);
    if (unsupported.length > 0) {
      throw new UnsupportedAnnotationTextError({
        annotationId: annotation.id,
        annotationKind: annotation.kind,
        characters: unsupported,
        pageIndex: annotation.pageIndex,
      });
    }
  }
}

function assertAnnotationIdsAreSafe(annotations: PdfAnnotation[]) {
  const ids = new Set<string>();
  for (const annotation of annotations) {
    const id: unknown = annotation.id;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_ANNOTATION_ID_LENGTH ||
      id.trim() !== id ||
      id.includes("|") ||
      /^(?:direct|geom|page|unresolved):/i.test(id) ||
      canonicalPdfReferenceKey(id) !== null ||
      // Ids are host input; controls must not reach PDF metadata or state keys.
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(id)
    ) {
      throw new PdfAnnotationIntegrityError(
        `An annotation on page ${annotation.pageIndex + 1} has an invalid identifier.`,
      );
    }

    const sourceId: unknown = annotation.sourceId;
    if (
      sourceId !== undefined &&
      (typeof sourceId !== "string" ||
        sourceId.length === 0 ||
        sourceId.length > MAX_ANNOTATION_SOURCE_ID_LENGTH ||
        sourceId.trim() !== sourceId ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f]/.test(sourceId))
    ) {
      throw new PdfAnnotationIntegrityError(
        `An annotation on page ${annotation.pageIndex + 1} has an invalid source identifier.`,
      );
    }

    const normalizedId = id.normalize("NFC");
    if (ids.has(normalizedId)) {
      throw new PdfAnnotationIntegrityError(
        `Two annotations use the same identifier (${id}). Saving was stopped to avoid replacing the wrong annotation.`,
      );
    }
    ids.add(normalizedId);
  }
}

function unsupportedAnnotationTextCharacters(annotation: PdfAnnotation) {
  if (annotation.kind !== "freeText" || annotation.text.trim().length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      graphemeClusters(normalizedFreeText(annotation.text)).filter(
        (cluster) => !isSupportedFreeTextCluster(cluster),
      ),
    ),
  );
}

function normalizedFreeText(text: string) {
  return text.normalize("NFC");
}

function isSupportedFreeTextCluster(cluster: string) {
  return Array.from(cluster).every(isSupportedFreeTextCharacter);
}

function isSupportedFreeTextCharacter(character: string) {
  if (character === "\n" || character === "\r") {
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
  const visibleCharacters = characters
    .slice(0, 5)
    .map((character) => JSON.stringify(character));
  return `${visibleCharacters.join(", ")}${characters.length > 5 ? ", ..." : ""}`;
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
  options: {
    filledAppearance?: boolean;
    id: string;
    updateTarget?: ExistingAnnotationTarget;
  },
) {
  const points = paths.flat();
  if (points.length === 0) {
    return;
  }

  const rect = appearanceBounds(
    options.filledAppearance ? points : inkAppearanceBoundsPoints(paths),
    options.filledAppearance ? 1 : width * 2,
  );
  const appearanceRef = options.filledAppearance
    ? filledInkAppearance(page, paths, rect, annotation)
    : strokedInkAppearance(page, paths, rect, annotation, width);
  const annotationWidth = options.filledAppearance ? 0 : width;

  addAnnotation(
    page,
    {
      Type: "Annot",
      Subtype: "Ink",
      Rect: rectToArray(rect),
      InkList: paths.map((path) =>
        path.flatMap((point) => [
          pdfCoordinate(point.x),
          pdfCoordinate(point.y),
        ]),
      ),
      ...annotationBase(options.id),
      ...annotationCommentEntry(annotation.comment),
      ...annotationBookmarkEntry(annotation),
      C: pdfColor(annotation.color),
      CA: pdfOpacity(annotation.opacity),
      IT: annotation.kind === "freehandHighlight" ? "InkHighlight" : "Ink",
      ...(appearanceRef ? { AP: { N: appearanceRef } } : {}),
      Border: [0, 0, annotationWidth],
      BS: {
        W: annotationWidth,
        S: "S",
      },
    },
    options.updateTarget,
    clearedAnnotationKeys(annotation, annotation.comment),
  );
}

function filledInkAppearance(
  page: PDFPage,
  paths: PdfPoint[][],
  rect: PdfRect,
  annotation: InkAnnotation,
) {
  const [x1, y1, x2, y2] = rectToArray(rect);
  const [r, g, b] = pdfColor(annotation.color);
  const content = [
    "q",
    "/GS0 gs",
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`,
    ...paths.map((path) => filledPathOperators(path, x1, y1)),
    "Q",
  ]
    .filter(Boolean)
    .join("\n");

  return registerAppearanceStream(page, content, {
    width: pdfCoordinate(x2 - x1),
    height: pdfCoordinate(y2 - y1),
    resources: opacityResources(pdfOpacity(annotation.opacity), "Multiply"),
  });
}

function strokedInkAppearance(
  page: PDFPage,
  paths: PdfPoint[][],
  rect: PdfRect,
  annotation: InkAnnotation,
  width: number,
) {
  const [x1, y1, x2, y2] = rectToArray(rect);
  const [r, g, b] = pdfColor(annotation.color);
  const content = [
    "q",
    "/GS0 gs",
    "1 J",
    "1 j",
    `${pdfCoordinateNumber(width)} w`,
    `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} RG`,
    ...paths.map((path) => strokedPathOperators(path, x1, y1)),
    "Q",
  ]
    .filter(Boolean)
    .join("\n");

  return registerAppearanceStream(page, content, {
    width: pdfCoordinate(x2 - x1),
    height: pdfCoordinate(y2 - y1),
    resources: opacityResources(
      pdfOpacity(annotation.opacity),
      annotation.kind === "freehandHighlight" ? "Multiply" : "Normal",
    ),
  });
}

function filledPathOperators(
  path: PdfPoint[],
  offsetX: number,
  offsetY: number,
) {
  const vertices = polygonVertices(path);
  if (vertices.length < 3) {
    return "";
  }

  const [first, ...rest] = vertices;
  return [
    `${pdfCoordinateNumber(first.x - offsetX)} ${pdfCoordinateNumber(first.y - offsetY)} m`,
    ...rest.map(
      (point) =>
        `${pdfCoordinateNumber(point.x - offsetX)} ${pdfCoordinateNumber(point.y - offsetY)} l`,
    ),
    "h",
    "f",
  ].join("\n");
}

function strokedPathOperators(
  path: PdfPoint[],
  offsetX: number,
  offsetY: number,
) {
  const points = path.filter(isFinitePoint);
  if (points.length === 0) {
    return "";
  }

  if (points.length === 1) {
    return `${pdfCoordinateNumber(points[0].x - offsetX)} ${pdfCoordinateNumber(
      points[0].y - offsetY,
    )} m\n${pdfCoordinateNumber(points[0].x - offsetX)} ${pdfCoordinateNumber(
      points[0].y - offsetY,
    )} l\nS`;
  }

  const [first, ...rest] = points;
  return [
    ...inkPathCommands([first, ...rest]).map((command) => {
      if (command.type === "move") {
        return `${pdfCoordinateNumber(
          command.point.x - offsetX,
        )} ${pdfCoordinateNumber(command.point.y - offsetY)} m`;
      }

      if (command.type === "line") {
        return `${pdfCoordinateNumber(
          command.point.x - offsetX,
        )} ${pdfCoordinateNumber(command.point.y - offsetY)} l`;
      }

      return `${pdfCoordinateNumber(command.control1.x - offsetX)} ${pdfCoordinateNumber(
        command.control1.y - offsetY,
      )} ${pdfCoordinateNumber(command.control2.x - offsetX)} ${pdfCoordinateNumber(
        command.control2.y - offsetY,
      )} ${pdfCoordinateNumber(
        command.point.x - offsetX,
      )} ${pdfCoordinateNumber(command.point.y - offsetY)} c`;
    }),
    "S",
  ]
    .filter(Boolean)
    .join("\n");
}

function inkAppearanceBoundsPoints(paths: PdfPoint[][]) {
  return paths.flatMap((path) =>
    inkPathCommands(path).flatMap((command) =>
      command.type === "curve"
        ? [command.control1, command.control2, command.point]
        : [command.point],
    ),
  );
}

function normalizeInkPath(path: PdfPoint[], width: number) {
  const finitePath = path.filter(isFinitePoint);
  if (finitePath.length === 0) {
    return finitePath;
  }

  const bounds = boundsForPoints(finitePath);
  const minSize = Math.max(width, 0.5);
  if (
    finitePath.length > 1 &&
    (bounds.x2 - bounds.x1 >= minSize || bounds.y2 - bounds.y1 >= minSize)
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

function resolveAnnotationUpdateTargets(
  pdfDoc: PDFDocument,
  annotations: PdfAnnotation[],
  requestedSourceIds: string[],
  // Only the copy path passes it: reports what it cannot pin down instead of
  // throwing.
  onUnwritable?: (annotationId: string) => void,
) {
  const targets = new Map<string, ExistingAnnotationTarget>();
  const handledSourceIds = new Set<string>();
  const usedTargets = new Set<PDFDict>();

  for (const annotation of annotations) {
    try {
      resolveOneAnnotationUpdateTarget(pdfDoc, annotation, requestedSourceIds, {
        handledSourceIds,
        targets,
        usedTargets,
      });
    } catch (error) {
      if (!onUnwritable || !(error instanceof PdfAnnotationIntegrityError)) {
        throw error;
      }
      onUnwritable(annotation.id);
    }
  }

  return { handledSourceIds, targets };
}

function resolveOneAnnotationUpdateTarget(
  pdfDoc: PDFDocument,
  annotation: PdfAnnotation,
  requestedSourceIds: string[],
  {
    handledSourceIds,
    targets,
    usedTargets,
  }: {
    handledSourceIds: Set<string>;
    targets: Map<string, ExistingAnnotationTarget>;
    usedTargets: Set<PDFDict>;
  },
) {
  const sourceId = annotation.sourceId ?? annotation.id;
  assertSourceIdIsResolved(sourceId, annotation.pageIndex);
  const shouldLookForExisting =
    Boolean(annotation.sourceId) ||
    requestedSourceIds.some(
      (requested) => sourceIdKeys(requested)[0] === sourceIdKeys(sourceId)[0],
    );
  if (!shouldLookForExisting) {
    return;
  }

  const matches = findExistingAnnotationTargets(
    pdfDoc,
    sourceId,
    annotation.sourceId ? null : annotation.pageIndex,
  );
  if (matches.length > 1) {
    throw new PdfAnnotationIntegrityError(
      `More than one source annotation matches an edit on page ${annotation.pageIndex + 1}. Saving was stopped to avoid changing the wrong annotation.`,
    );
  }
  if (matches.length === 0) {
    if (annotation.sourceId) {
      throw new PdfAnnotationIntegrityError(
        `The source annotation for an edit on page ${annotation.pageIndex + 1} could not be identified. Saving was stopped to avoid creating a duplicate.`,
      );
    }
    return;
  }

  const [target] = matches;
  assertTargetSubtypeMatches(target, annotation);
  if (usedTargets.has(target.annotation)) {
    throw new PdfAnnotationIntegrityError(
      "Two edits resolve to the same source annotation. Saving was stopped to protect the document.",
    );
  }
  usedTargets.add(target.annotation);
  targets.set(annotation.id, target);

  const matchedKey = sourceIdKeys(sourceId)[0];
  for (const requested of requestedSourceIds) {
    if (
      requested === annotation.id ||
      sourceIdKeys(requested)[0] === matchedKey
    ) {
      handledSourceIds.add(requested);
    }
  }
}

// A copy may leave an annotation out; a save may not.
type UnwritableAnnotations = {
  /** Ids of annotations whose source this file cannot be sure of. */
  annotationIds: ReadonlySet<string>;
  /** Requested removals that name nothing this file can be sure of. */
  removalSourceIds: ReadonlySet<string>;
  // Annotations left out, counted once each: not the size of the two sets
  // above, since an edited annotation whose identity is lost is in both.
  omittedAnnotationCount: number;
};

export async function unwritableAnnotations(
  bytes: Uint8Array,
  annotations: PdfAnnotation[],
  options: WritePdfAnnotationsOptions = {},
): Promise<UnwritableAnnotations> {
  const pdfDoc = await loadEditablePdf(bytes);
  const annotationIds = new Set<string>();
  const requestedSourceIds = options.replaceAnnotationSourceIds
    ? Array.from(options.replaceAnnotationSourceIds)
    : [];
  const { handledSourceIds } = resolveAnnotationUpdateTargets(
    pdfDoc,
    annotations,
    requestedSourceIds,
    (annotationId) => annotationIds.add(annotationId),
  );

  // A removal keyed to an omitted annotation has to go too: it would take the
  // dictionary out while nothing is written in its place.
  const omittedKeys = new Set(
    annotations
      .filter((annotation) => annotationIds.has(annotation.id))
      .map(
        (annotation) => sourceIdKeys(annotation.sourceId ?? annotation.id)[0],
      ),
  );
  const remaining = requestedSourceIds.filter(
    (sourceId) => !handledSourceIds.has(sourceId),
  );
  const replacementKeys = sourceIdKeySet(remaining);
  const counts = replacementKeyCounts(
    pdfDoc,
    options.replacePageIndexes ? new Set(options.replacePageIndexes) : null,
    replacementKeys,
  );
  const unwritableKeys = new Set<string>();
  for (const key of replacementKeys) {
    const count = counts.get(key) ?? 0;
    if (
      unresolvedSourceReason(key) ||
      count > 1 ||
      (namesAPlaceInTheFile(key) && count === 0)
    ) {
      unwritableKeys.add(key);
    }
  }

  const removalSourceIds = new Set(
    requestedSourceIds.filter((sourceId) => {
      const [key] = sourceIdKeys(sourceId);
      return (
        key !== undefined && (unwritableKeys.has(key) || omittedKeys.has(key))
      );
    }),
  );

  // Keys, not source ids: two spellings are one annotation.
  const separatelyOmittedKeys = new Set(
    [...removalSourceIds]
      .map((sourceId) => sourceIdKeys(sourceId)[0])
      .filter((key) => key !== undefined && !omittedKeys.has(key)),
  );

  return {
    annotationIds,
    omittedAnnotationCount: annotationIds.size + separatelyOmittedKeys.size,
    removalSourceIds,
  };
}

// The write half of the /Annots position rule: an edit whose source could not
// be pinned down stops the save.
function assertSourceIdIsResolved(sourceId: string, pageIndex: number) {
  const reason = unresolvedSourceReason(sourceId);
  if (!reason) {
    return;
  }

  throw new PdfAnnotationIntegrityError(
    reason === "ambiguous"
      ? `More than one annotation in the file matches an edit on page ${pageIndex + 1}. Saving was stopped to avoid changing the wrong annotation.`
      : `The source annotation for an edit on page ${pageIndex + 1} could not be located in the file. Saving was stopped to avoid changing the wrong annotation.`,
  );
}

// The dictionary an edit updates has to be the kind that edit writes: updating
// in place sets /Subtype, so a drifted position would retype a neighbour.
function assertTargetSubtypeMatches(
  target: ExistingAnnotationTarget,
  annotation: PdfAnnotation,
) {
  const expected = annotationSubtypeForKind(annotation.kind);
  if (annotationSubtype(target.annotation) === expected) {
    return;
  }

  throw new PdfAnnotationIntegrityError(
    `The source annotation for an edit on page ${annotation.pageIndex + 1} is a different kind of annotation than the edit. Saving was stopped to avoid changing the wrong annotation.`,
  );
}

function annotationSubtypeForKind(kind: PdfAnnotation["kind"]) {
  switch (kind) {
    case "textHighlight":
      return "Highlight";
    case "draw":
    case "freehandHighlight":
      return "Ink";
    case "freeText":
      return "FreeText";
    case "stickyNote":
      return "Text";
    case "imageStamp":
      return "Stamp";
  }
}

// Removals carry the same rule: a deletion whose source could not be pinned
// down stops the save rather than quietly staying in the file.
function assertReplacementKeysAreResolved(replacementKeys: Set<string>) {
  for (const key of replacementKeys) {
    const reason = unresolvedSourceReason(key);
    if (!reason) {
      continue;
    }

    throw new PdfAnnotationIntegrityError(
      reason === "ambiguous"
        ? "More than one annotation in the file matches an annotation that was removed. Saving was stopped to avoid deleting unrelated content."
        : "An annotation that was removed could not be located in the file. Saving was stopped to avoid deleting unrelated content.",
    );
  }
}

// Re-mints identities from what was written, since the written bytes become the
// baseline without being re-imported.

/** What this write did to one identity that existed in the input bytes. */
type WrittenAnnotationSource =
  /** Still in the file; `sourceId` is what names it there now. */
  | { kind: "moved"; sourceId: string }
  /** This write took it out of the file. */
  | { kind: "removed" }
  /** It could not be followed; `sourceId` is an identity that stops a save. */
  | { kind: "unresolved"; sourceId: string };

/** Keyed by the canonical source key of the identity in the input bytes. */
export type WrittenAnnotationSources = ReadonlyMap<
  string,
  WrittenAnnotationSource
>;

type AnnotsEntryPosition = { index: number; pageIndex: number };

type AnnotsEntryPositions = {
  /** Entries that appear more than once, so a position cannot name them. */
  ambiguous: Set<unknown>;
  positions: Map<unknown, AnnotsEntryPosition>;
};

// Keyed by the entry object itself, the one thing that survives an update in
// place: addAnnotation mutates the dictionary already in the array.
function captureAnnotsEntryPositions(
  pdfDoc: PDFDocument,
): AnnotsEntryPositions {
  const ambiguous = new Set<unknown>();
  const positions = new Map<unknown, AnnotsEntryPosition>();

  for (const [pageIndex, page] of pdfDoc.getPages().entries()) {
    let annots: PDFArray | undefined;
    try {
      annots = page.node.Annots();
    } catch {
      // A present-but-wrong-typed /Annots: nothing on this page can be
      // followed, so every identity here falls through to unresolved.
      continue;
    }
    if (!annots) {
      continue;
    }

    for (let index = 0; index < annots.size(); index += 1) {
      const entry = annots.get(index);
      if (entry === undefined) {
        continue;
      }

      const key = entry instanceof PDFRef ? entry.toString() : entry;
      if (positions.has(key)) {
        ambiguous.add(key);
        continue;
      }
      positions.set(key, { index, pageIndex });
    }
  }

  return { ambiguous, positions };
}

function writtenAnnotationSources(
  before: AnnotsEntryPositions,
  after: AnnotsEntryPositions,
) {
  const sources = new Map<string, WrittenAnnotationSource>();

  for (const [key, position] of before.positions) {
    const sourceKey =
      typeof key === "string"
        ? canonicalPdfReferenceKey(key)
        : sourceIdKeys(directSourceId(position.pageIndex, position.index))[0];
    if (!sourceKey) {
      continue;
    }

    if (before.ambiguous.has(key) || after.ambiguous.has(key)) {
      sources.set(sourceKey, {
        kind: "unresolved",
        sourceId: unresolvedSourceId(
          "ambiguous",
          position.pageIndex,
          position.index,
        ),
      });
      continue;
    }

    const next = after.positions.get(key);
    if (!next) {
      sources.set(sourceKey, { kind: "removed" });
      continue;
    }

    sources.set(sourceKey, {
      kind: "moved",
      sourceId:
        typeof key === "string"
          ? key
          : directSourceId(next.pageIndex, next.index),
    });
  }

  return sources;
}

// `pageMapping` is required, not defaulted: assuming the two numberings agree
// lands a later save's edit on a neighbour.
export function remapAnnotationSources<T extends PdfAnnotation>(
  annotations: T[],
  sources: WrittenAnnotationSources,
  pageMapping: PdfPageMapping,
): T[] {
  let changed = false;
  const next = annotations.map((annotation) => {
    const sourceId = remappedSourceId(
      annotation.sourceId,
      sources,
      annotation.pageIndex,
      pageMapping,
    );
    if (sourceId === annotation.sourceId) {
      return annotation;
    }
    changed = true;
    return { ...annotation, sourceId };
  });

  return changed ? next : annotations;
}

// An applied removal is dropped: carrying its position forward lets it delete
// whatever moved into the slot.
export function remapRemovedAnnotationSources(
  removedSourceIds: Iterable<string>,
  sources: WrittenAnnotationSources,
  pageMapping: PdfPageMapping,
  // Null means not known, and the page test below is skipped rather than made
  // against a guess.
  pageOfRemovedSource: (sourceId: string) => number | null = () => null,
): string[] {
  const next: string[] = [];
  for (const sourceId of removedSourceIds) {
    const written = writtenFileSourceId(sourceId, pageMapping);
    const source =
      written === null ? null : trackedWrittenSource(written, sources);
    if (source?.kind === "removed") {
      continue;
    }
    next.push(
      remappedSourceId(
        sourceId,
        sources,
        pageOfRemovedSource(sourceId),
        pageMapping,
      ) ?? sourceId,
    );
  }
  return next;
}

function remappedSourceId(
  sourceId: string | undefined,
  sources: WrittenAnnotationSources,
  /** The page the annotation is on, or null when that is not known. */
  annotationPageIndex: number | null,
  pageMapping: PdfPageMapping,
) {
  if (!sourceId) {
    return sourceId;
  }

  // Asked of the annotation's page, not only the page a `direct:` identity
  // spells: an indirect reference carries no page, and that is the page an undo
  // re-creates its object on.
  if (
    annotationPageIndex !== null &&
    pageMapping.backward(annotationPageIndex) === null
  ) {
    return sourceId;
  }

  const written = writtenFileSourceId(sourceId, pageMapping);
  if (written === null) {
    return sourceId;
  }

  const source = trackedWrittenSource(written, sources);
  if (!source) {
    // Either an identity this writer never tracks, or one already stale in the
    // input, which shiftedSourceId tells apart.
    return shiftedSourceId(sourceId, annotationPageIndex ?? 0);
  }

  if (source.kind === "removed") {
    // Known removed, not merely unconfirmed, so the identity is dropped rather
    // than retired as `unresolved:`; the writer then writes it fresh.
    return undefined;
  }

  const restated = identitySourceId(source.sourceId, pageMapping);
  if (restated === null) {
    // The write moved it onto a page these identities' document does not have,
    // so nothing here can name it.
    return shiftedSourceId(sourceId, annotationPageIndex ?? 0);
  }

  // Left exactly as it was: restating an unchanged identity in the writer's own
  // spelling would churn every work signature for nothing.
  return sourceIdKeys(restated)[0] === sourceIdKeys(sourceId)[0]
    ? sourceId
    : restated;
}

// Null when the identity names a page the written file does not have.
function writtenFileSourceId(sourceId: string, pageMapping: PdfPageMapping) {
  const position = directSourcePosition(sourceIdKeys(sourceId)[0]);
  if (!position) {
    return sourceId;
  }

  const pageIndex = pageMapping.backward(position.pageIndex);
  return pageIndex === null
    ? null
    : directSourceId(pageIndex, position.annotationIndex);
}

/** The written file's answer, put back into the numbering it was asked in. */
function identitySourceId(sourceId: string, pageMapping: PdfPageMapping) {
  const position = directSourcePosition(sourceIdKeys(sourceId)[0]);
  if (!position) {
    return sourceId;
  }

  const pageIndex = pageMapping.forward(position.pageIndex);
  return pageIndex === null
    ? null
    : directSourceId(pageIndex, position.annotationIndex);
}

// Null when this writer does not track that shape of identity at all.
function trackedWrittenSource(
  sourceId: string,
  sources: WrittenAnnotationSources,
) {
  if (unresolvedSourceReason(sourceId)) {
    return null;
  }

  const [key] = sourceIdKeys(sourceId);
  return isPositionalSourceKey(key) ? (sources.get(key) ?? null) : null;
}

function isPositionalSourceKey(sourceKey: string | undefined) {
  return Boolean(
    sourceKey &&
    (sourceKey.startsWith("direct:") || sourceKey.startsWith("ref:")),
  );
}

function shiftedSourceId(sourceId: string, pageIndex: number) {
  if (
    unresolvedSourceReason(sourceId) ||
    !isPositionalSourceKey(sourceIdKeys(sourceId)[0])
  ) {
    return sourceId;
  }

  const position = directSourcePosition(sourceIdKeys(sourceId)[0]);
  return unresolvedSourceId(
    "shifted",
    position?.pageIndex ?? pageIndex,
    position?.annotationIndex ?? 0,
  );
}

// One walk, because two questions are asked of it and must answer over the same
// members: a filter that drifted between them would let a key read as unique
// while the write found a second match.
function* fileAnnotations(
  pdfDoc: PDFDocument,
  onPage: (pageIndex: number) => boolean,
) {
  for (const [pageIndex, page] of pdfDoc.getPages().entries()) {
    if (!onPage(pageIndex)) {
      continue;
    }
    const annots = page.node.Annots();
    if (!annots) {
      continue;
    }
    for (let index = 0; index < annots.size(); index += 1) {
      try {
        const annotation = annots.lookupMaybe(index, PDFDict);
        const subtype = annotationSubtype(annotation);
        if (
          !annotation ||
          !subtype ||
          (!supportedAnnotationSubtypes.has(subtype) && subtype !== "Stamp")
        ) {
          continue;
        }
        yield {
          annotation,
          entry: annots.get(index),
          index,
          pageIndex,
        };
      } catch {
        continue;
      }
    }
  }
}

function findExistingAnnotationTargets(
  pdfDoc: PDFDocument,
  sourceId: string,
  preferredPageIndex: number | null,
) {
  const [sourceKey] = sourceIdKeys(sourceId);
  if (!sourceKey || isUnsafeFallbackSourceIdPart(sourceKey)) {
    return [];
  }

  const matches: ExistingAnnotationTarget[] = [];
  for (const { annotation, entry, index, pageIndex } of fileAnnotations(
    pdfDoc,
    (page) => preferredPageIndex === null || page === preferredPageIndex,
  )) {
    // An update target has to be something the writer can name back: a
    // reference or a dictionary written straight into the array.
    if (!(entry instanceof PDFRef) && !(entry instanceof PDFDict)) {
      continue;
    }
    if (
      annotationSourceKeys(pageIndex, index, entry, annotation).includes(
        sourceKey,
      )
    ) {
      matches.push({ annotation, entry, pageIndex });
    }
  }
  return matches;
}

// Only a key naming a place in the file can be checked against the document:
// one drawn and deleted before any save legitimately matches nothing.
function namesAPlaceInTheFile(replacementKey: string) {
  return (
    replacementKey.startsWith("ref:") || replacementKey.startsWith("direct:")
  );
}

function assertReplacementKeysAreUnique(
  pdfDoc: PDFDocument,
  replacePageIndexes: Set<number> | null,
  replacementKeys: Set<string>,
) {
  const counts = replacementKeyCounts(
    pdfDoc,
    replacePageIndexes,
    replacementKeys,
  );

  if (Array.from(counts.values()).some((count) => count > 1)) {
    throw new PdfAnnotationIntegrityError(
      "More than one annotation matches a requested replacement. Saving was stopped to avoid deleting unrelated content.",
    );
  }

  return counts;
}

/** How many annotations in the file each replacement key matches. */
function replacementKeyCounts(
  pdfDoc: PDFDocument,
  replacePageIndexes: Set<number> | null,
  replacementKeys: Set<string>,
) {
  const counts = new Map<string, number>();
  for (const { annotation, entry, index, pageIndex } of fileAnnotations(
    pdfDoc,
    (page) => !replacePageIndexes || replacePageIndexes.has(page),
  )) {
    for (const key of annotationSourceKeys(
      pageIndex,
      index,
      entry,
      annotation,
    )) {
      if (replacementKeys.has(key)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  return counts;
}

// The other end of the same count: the check above refuses a removal key
// matching two annotations, and this one refuses a key matching none.
function assertReplacementKeysWereFound(
  replacementKeys: Set<string>,
  counts: Map<string, number>,
) {
  for (const key of replacementKeys) {
    if (!namesAPlaceInTheFile(key) || (counts.get(key) ?? 0) > 0) {
      continue;
    }

    throw new PdfAnnotationIntegrityError(
      "An annotation that was removed could not be found in the file. Saving was stopped rather than leaving it in the document.",
    );
  }
}

function removeSupportedExistingAnnotations(
  pdfDoc: PDFDocument,
  replacePageIndexes: Set<number> | null,
  replaceAnnotationSourceIds: Set<string> | null,
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
            replaceAnnotationSourceIds,
          )
        ) {
          if (annotationRef instanceof PDFRef) {
            supportedAnnotationRefs.add(annotationRef.toString());
          }
        }
      } catch {
        // pdf-lib's lookupMaybe throws on a present-but-wrong-typed value,
        // which must not abort the save.
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
            index,
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
    page.node.delete(PDFName.of("Annots"));
  }
}

function annotationSubtype(annotation: PDFDict | undefined) {
  return annotation?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
}

function shouldRemoveExistingAnnotation(
  annotation: PDFDict | undefined,
  annotationRef: unknown,
  subtype: string | undefined,
  supportedAnnotationRefs: Set<string>,
  replaceAnnotationSourceIds: Set<string> | null,
  pageIndex: number,
  annotationIndex: number,
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
      replaceAnnotationSourceIds,
    );
  }

  if (subtype !== "Popup") {
    return false;
  }

  return popupBelongsToSupportedAnnotation(
    annotation,
    supportedAnnotationRefs,
    replaceAnnotationSourceIds === null,
  );
}

function isRemovableAnnotationSubtype(
  subtype: string,
  replaceAnnotationSourceIds: Set<string> | null,
) {
  if (supportedAnnotationSubtypes.has(subtype)) {
    return true;
  }

  // Never bulk-remove Stamp annotations from other software: this app's own
  // image stamps are removable only through a matched /NM id.
  return subtype === "Stamp" && replaceAnnotationSourceIds !== null;
}

function shouldRemoveSupportedAnnotation(
  annotation: PDFDict | undefined,
  annotationRef: unknown,
  pageIndex: number,
  annotationIndex: number,
  replaceAnnotationSourceIds: Set<string> | null,
) {
  if (!replaceAnnotationSourceIds) {
    return true;
  }

  return annotationSourceKeys(
    pageIndex,
    annotationIndex,
    annotationRef,
    annotation,
  ).some((sourceKey) => replaceAnnotationSourceIds.has(sourceKey));
}

function popupBelongsToSupportedAnnotation(
  annotation: PDFDict,
  supportedAnnotationRefs: Set<string>,
  allowSubtypeFallback = false,
) {
  const parent = annotation.get(PDFName.of("Parent"));
  if (
    parent instanceof PDFRef &&
    supportedAnnotationRefs.has(parent.toString())
  ) {
    return true;
  }

  if (!allowSubtypeFallback) {
    return false;
  }

  const parentSubtype = annotationSubtype(
    annotation.lookupMaybe(PDFName.of("Parent"), PDFDict),
  );
  return Boolean(
    parentSubtype && supportedAnnotationSubtypes.has(parentSubtype),
  );
}

function annotationSourceKeys(
  pageIndex: number,
  annotationIndex: number,
  ref: unknown,
  annotation?: PDFDict,
) {
  const values = [
    ref instanceof PDFRef ? ref.toString() : null,
    !(ref instanceof PDFRef)
      ? directSourceId(pageIndex, annotationIndex)
      : null,
    pdfStringEntry(annotation, "NM"),
    annotationGeometrySourceKey(annotation),
    `page:${pageIndex}:annotation-${annotationIndex}`,
  ].filter((value): value is string => Boolean(value));
  return values.flatMap(sourceIdKeys);
}

function annotationGeometrySourceKey(annotation?: PDFDict) {
  const subtype = annotationSubtype(annotation)?.toLowerCase();
  const rect = pdfRectSourceKey(annotation);
  if (!subtype || !rect) {
    return "";
  }

  const contents = pdfStringEntry(annotation, "Contents")?.trim();
  return `geom:${subtype}:${rect}:${contents ? textHash(contents) : "empty"}`;
}

function pdfRectSourceKey(annotation?: PDFDict) {
  const rect = annotation?.lookupMaybe(PDFName.of("Rect"), PDFArray);
  if (!rect || rect.size() < 4) {
    return "";
  }

  const values = Array.from({ length: 4 }, (_, index) => {
    const value = rect.lookupMaybe(index, PDFNumber)?.asNumber();
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  if (!isFiniteNumberArray(values)) {
    return "";
  }

  return normalizedRectValues(values)
    .map((value) => sourceKeyNumber(value))
    .join(",");
}

function isFiniteNumberArray(values: Array<number | null>): values is number[] {
  return values.every(
    (value) => typeof value === "number" && Number.isFinite(value),
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
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    // Exactly one primary identity: treating every alias as an or condition
    // can delete a second annotation sharing /NM or geometry.
    const referencePart = parts.find((part) => canonicalPdfReferenceKey(part));
    const precisePart = parts.find((part) => !isFallbackSourceIdPart(part));
    const geometryPart = parts.find((part) =>
      part.toLowerCase().startsWith("geom:"),
    );
    return sourceIdKeys(
      referencePart ?? precisePart ?? geometryPart ?? parts[0],
    );
  }

  const referenceKey = canonicalPdfReferenceKey(sourceId);
  if (referenceKey) {
    return [referenceKey];
  }

  const normalized = sourceId.trim().normalize("NFC");
  if (normalized.toLowerCase().startsWith("geom:")) {
    return [`geom:${normalized.slice(5)}`];
  }
  if (normalized.toLowerCase().startsWith("direct:")) {
    return [`direct:${normalized.slice(7)}`];
  }
  if (normalized.toLowerCase().startsWith(UNRESOLVED_SOURCE_ID_PREFIX)) {
    // Deliberately a key annotationSourceKeys never produces, so an unconfirmed
    // identity matches nothing and the save stops on it.
    return [`${UNRESOLVED_SOURCE_ID_PREFIX}${normalized.slice(11)}`];
  }
  if (normalized.toLowerCase().startsWith("page:")) {
    return [`page:${normalized.slice(5)}`];
  }

  return [`id:${normalized}`];
}

function isFallbackSourceIdPart(sourceId: string) {
  const normalized = sourceId.trim().toLowerCase();
  return normalized.startsWith("geom:") || normalized.startsWith("page:");
}

function isUnsafeFallbackSourceIdPart(sourceId: string) {
  return sourceId.trim().toLowerCase().startsWith("page:");
}

const preservedExistingAnnotationKeys = new Set(["CreationDate", "F", "NM"]);

// Paired with clearedAnnotationKeys: addAnnotation only sets the keys it is
// handed, so an emptied comment must be removed or the old note comes back.
function annotationCommentEntry(comment: string) {
  const normalized = normalizeAnnotationComment(comment);
  return normalized ? { Contents: pdfTextString(normalized) } : {};
}

function annotationBookmarkEntry(annotation: PdfAnnotation) {
  return annotation.bookmarked ? { [ANNOTATION_BOOKMARK_KEY]: true } : {};
}

/** The keys this annotation's current state means must not be in the file. */
function clearedAnnotationKeys(annotation: PdfAnnotation, comment: string) {
  const cleared: string[] = [];
  if (!normalizeAnnotationComment(comment)) {
    cleared.push("Contents");
  }
  if (!annotation.bookmarked) {
    cleared.push(ANNOTATION_BOOKMARK_KEY);
  }
  return cleared;
}

function addAnnotation(
  page: PDFPage,
  object: Record<string, unknown>,
  updateTarget?: ExistingAnnotationTarget,
  clearKeys: string[] = [],
) {
  const context = page.doc.context;
  const nextAnnotation = context.obj({
    P: page.ref,
    ...object,
    // pdf-lib's recursive LiteralObject input type is private.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as unknown as PDFDict;

  if (updateTarget) {
    moveExistingAnnotationTarget(page, updateTarget);
    for (const key of nextAnnotation.keys()) {
      const keyName = key.decodeText();
      if (
        preservedExistingAnnotationKeys.has(keyName) &&
        updateTarget.annotation.has(key)
      ) {
        continue;
      }

      const value = nextAnnotation.get(key);
      if (value) {
        updateTarget.annotation.set(key, value);
      }
    }

    for (const key of clearKeys) {
      updateTarget.annotation.delete(PDFName.of(key));
    }
    return;
  }

  let annots = page.node.Annots();

  if (!annots) {
    annots = context.obj([]);
    page.node.set(PDFName.of("Annots"), annots);
  }

  annots.push(context.register(nextAnnotation));
}

function moveExistingAnnotationTarget(
  destinationPage: PDFPage,
  target: ExistingAnnotationTarget,
) {
  if (
    target.pageIndex === destinationPage.doc.getPages().indexOf(destinationPage)
  ) {
    return;
  }

  const sourcePage = destinationPage.doc.getPage(target.pageIndex);
  const sourceAnnots = sourcePage.node.Annots();
  if (!sourceAnnots) {
    throw new PdfAnnotationIntegrityError(
      "The original annotation could not be found while moving it. Saving was stopped to protect the document.",
    );
  }

  let destinationAnnots = destinationPage.node.Annots();
  if (!destinationAnnots) {
    destinationAnnots = destinationPage.doc.context.obj([]);
    destinationPage.node.set(PDFName.of("Annots"), destinationAnnots);
  }

  const popupEntries: Array<PDFDict | PDFRef> = [];
  if (target.entry instanceof PDFRef) {
    for (let index = sourceAnnots.size() - 1; index >= 0; index -= 1) {
      const popup = sourceAnnots.lookupMaybe(index, PDFDict);
      const parent = popup?.get(PDFName.of("Parent"));
      if (
        popup &&
        annotationSubtype(popup) === "Popup" &&
        parent instanceof PDFRef &&
        parent.toString() === target.entry.toString()
      ) {
        const entry = sourceAnnots.get(index);
        if (entry instanceof PDFRef || entry instanceof PDFDict) {
          popup.set(PDFName.of("P"), destinationPage.ref);
          popupEntries.push(entry);
          sourceAnnots.remove(index);
        }
      }
    }
  }

  let removed = false;
  for (let index = sourceAnnots.size() - 1; index >= 0; index -= 1) {
    const entry = sourceAnnots.get(index);
    const annotation = sourceAnnots.lookupMaybe(index, PDFDict);
    if (
      (target.entry instanceof PDFRef &&
        entry instanceof PDFRef &&
        entry.toString() === target.entry.toString()) ||
      (!(target.entry instanceof PDFRef) && annotation === target.annotation)
    ) {
      sourceAnnots.remove(index);
      removed = true;
      break;
    }
  }

  if (!removed) {
    throw new PdfAnnotationIntegrityError(
      "The original annotation changed while it was being moved. Saving was stopped to protect the document.",
    );
  }

  destinationAnnots.push(target.entry);
  for (const popupEntry of popupEntries.reverse()) {
    destinationAnnots.push(popupEntry);
  }
  target.pageIndex = destinationPage.doc.getPages().indexOf(destinationPage);
}

// A stroke straddles its path, so a BBox on the tight bounds clips half the
// ink.
function appearanceBounds(points: PdfPoint[], padding: number): PdfRect {
  const bounds = boundsForPoints(points);
  return {
    x1: bounds.x1 - padding,
    y1: bounds.y1 - padding,
    x2: bounds.x2 + padding,
    y2: bounds.y2 + padding,
  };
}

function rectToArray(rect: PdfRect) {
  return [
    pdfCoordinate(Math.min(rect.x1, rect.x2)),
    pdfCoordinate(Math.min(rect.y1, rect.y2)),
    pdfCoordinate(Math.max(rect.x1, rect.x2)),
    pdfCoordinate(Math.max(rect.y1, rect.y2)),
  ];
}

function normalizedQuadPoints(quadPoints: number[][], rects: PdfRect[]) {
  const finiteQuadPoints = quadPoints.filter(
    (quad) => quad.length === 8 && quad.every(Number.isFinite),
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

function pdfColor(color: [number, number, number]): [number, number, number] {
  return [
    pdfRatio(clampPdfNumber(color[0], 0, 1, 0)),
    pdfRatio(clampPdfNumber(color[1], 0, 1, 0)),
    pdfRatio(clampPdfNumber(color[2], 0, 1, 0)),
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
  const pad = (value: number) => String(value).padStart(2, "0");

  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
