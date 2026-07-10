import assert from 'node:assert/strict';
import test from 'node:test';
import UPNG_ from '@pdf-lib/upng';

// Node's native ESM loader does not unwrap a nested `.default` the way
// bundlers do: since @pdf-lib/upng's CJS build sets `exports.default = UPNG`
// under `exports.__esModule = true`, a plain `import UPNG from '@pdf-lib/upng'`
// resolves to `{ __esModule: true, default: UPNG }` itself, not the inner
// UPNG object. Unwrap it once here so the rest of this file can call
// UPNG.encode/decode/toRGBA8 directly.
const UPNG = (UPNG_ as unknown as { default?: typeof UPNG_ }).default ?? UPNG_;
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFHexString
} from 'pdf-lib';
import {
  annotationBounds,
  annotationHitTest,
  appearanceRotationMatrix,
  rotatedAnnotationRect,
  rotationFromAppearanceMatrix
} from '../src/workspace/annotationGeometry';
import { writePdfAnnotations } from '../src/workspace/pdfWriter';
import type { PdfAnnotation } from '../src/workspace/types';
import { loadTestPdf, readFixture } from './pdfTestUtils';

// annotationImport.ts imports `pdfjs-dist` (for the AnnotationType enum), whose
// browser build touches `DOMMatrix` at module top level. Static ES imports are
// hoisted and evaluated before any of this file's own code runs, so the only
// way to load it in plain Node is to install minimal browser polyfills first
// and then load it with a *dynamic* import (which is not hoisted).
installBrowserPolyfills();
const { extractAppearanceRotationAndRect, extractStampImage } = await import(
  '../src/workspace/annotationImport'
);

function installBrowserPolyfills() {
  class FakeDOMMatrix {}
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= FakeDOMMatrix;

  class FakeImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  (globalThis as { ImageData?: unknown }).ImageData ??= FakeImageData;

  (globalThis as { document?: unknown }).document ??= {
    createElement(tagName: string) {
      if (tagName !== 'canvas') {
        throw new Error(`unsupported element in test polyfill: ${tagName}`);
      }

      let pixels: FakeImageData | null = null;
      return {
        width: 0,
        height: 0,
        getContext(kind: string) {
          if (kind !== '2d') {
            return null;
          }
          return {
            putImageData(imageData: FakeImageData) {
              pixels = imageData;
            }
          };
        },
        toDataURL(mimeType: string) {
          if (mimeType !== 'image/png' || !pixels) {
            return '';
          }
          const encoded = UPNG.encode(
            [pixels.data.buffer.slice(
              pixels.data.byteOffset,
              pixels.data.byteOffset + pixels.data.byteLength
            )],
            pixels.width,
            pixels.height,
            0
          );
          const base64 = Buffer.from(encoded).toString('base64');
          return `data:image/png;base64,${base64}`;
        }
      };
    }
  };
}

// A 2x2 solid, fully-opaque red PNG - used across the image-stamp tests
// below. Built from raw pixels rather than a hand-crafted base64 literal so
// there's no ambiguity about what every pixel actually decodes to.
const RED_2X2_PNG_BASE64 = (() => {
  const rgba = new Uint8ClampedArray(2 * 2 * 4);
  for (let pixel = 0; pixel < 4; pixel += 1) {
    rgba[pixel * 4] = 255;
    rgba[pixel * 4 + 1] = 0;
    rgba[pixel * 4 + 2] = 0;
    rgba[pixel * 4 + 3] = 255;
  }
  const encoded = UPNG.encode(
    [rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)],
    2,
    2,
    0
  );
  return Buffer.from(encoded).toString('base64');
})();

test('appearanceRotationMatrix / rotationFromAppearanceMatrix round-trip for every rotation this app writes', () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const [a, b, c, d] = appearanceRotationMatrix(rotation, 40, 100);
    assert.equal(
      rotationFromAppearanceMatrix(a, b, c, d),
      rotation,
      `rotation ${rotation}`
    );
  }
});

test('rotationFromAppearanceMatrix declines a matrix this app never writes, rather than guessing', () => {
  // A uniform 2x scale (not one of our four pure-rotation matrices).
  assert.equal(rotationFromAppearanceMatrix(2, 0, 0, 2), null);
  // A shear large enough to survive the implementation's integer rounding.
  assert.equal(rotationFromAppearanceMatrix(1, 0.6, 0, 1), null);
});

test('annotationBounds and annotationHitTest account for per-annotation rotation', () => {
  const rect = { x1: 100, y1: 200, x2: 140, y2: 300 }; // 40 wide, 100 tall
  const stamp: PdfAnnotation = {
    id: 'bounds-test-stamp',
    kind: 'imageStamp',
    pageIndex: 0,
    rect,
    imageData: '',
    mimeType: 'image/png',
    widthPx: 2,
    heightPx: 2,
    rotation: 90
  };

  const bounds = annotationBounds(stamp);
  // Rotated 90: the 40x100 footprint becomes 100x40, centered the same.
  assert.equal(Math.abs(bounds.x2 - bounds.x1), 100);
  assert.equal(Math.abs(bounds.y2 - bounds.y1), 40);

  const expected = rotatedAnnotationRect(rect, 90);
  assert.deepEqual(bounds, expected);

  // A point that's inside the rotated (wide/short) footprint but would be
  // outside the original (narrow/tall) one.
  const insideRotatedOnly = { x: 130, y: 250 };
  assert.equal(annotationHitTest(stamp, insideRotatedOnly, 1), true);
});

test('image-stamp rotation survives a write -> reimport round trip, pixels included', async () => {
  const bytes = await readFixture('test-annotated.pdf');

  for (const rotation of [0, 90, 180, 270] as const) {
    const rect = { x1: 100, y1: 500, x2: 140, y2: 600 }; // 40 wide, 100 tall
    const id = `reimport-stamp-${rotation}`;
    const stamp: PdfAnnotation = {
      id,
      kind: 'imageStamp',
      pageIndex: 0,
      rect,
      imageData: RED_2X2_PNG_BASE64,
      mimeType: 'image/png',
      widthPx: 2,
      heightPx: 2,
      rotation
    };

    const output = await writePdfAnnotations(bytes, [stamp], {
      replaceAnnotationSourceIds: [id],
      replacePageIndexes: [0]
    });

    const fakeAnnotation = await findAnnotationById(output, 0, id);
    assert.ok(fakeAnnotation, `${id}: annotation not found in output`);

    const extracted = await extractStampImage(output, 0, fakeAnnotation!);
    assert.ok(extracted, `rotation ${rotation}: extraction failed`);
    assert.equal(extracted!.rotation, rotation, `rotation ${rotation}: recovered rotation`);
    assert.equal(extracted!.widthPx, 2);
    assert.equal(extracted!.heightPx, 2);
    assertRectsClose(extracted!.rect, rect, `rotation ${rotation}: recovered rect`);

    const decoded = decodePngDataUrlToRGBA(extracted!.imageData);
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
    for (let pixel = 0; pixel < 4; pixel += 1) {
      assert.equal(decoded.data[pixel * 4], 255, `rotation ${rotation}: red channel`);
      assert.equal(decoded.data[pixel * 4 + 1], 0, `rotation ${rotation}: green channel`);
      assert.equal(decoded.data[pixel * 4 + 2], 0, `rotation ${rotation}: blue channel`);
    }
  }
});

test('freeText rotation survives a write -> reimport round trip', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const rect = { x1: 72, y1: 600, x2: 172, y2: 640 }; // 100 wide, 40 tall
  const id = 'reimport-freetext-rotated';
  const text: PdfAnnotation = {
    id,
    kind: 'freeText',
    pageIndex: 0,
    rect,
    text: 'rotated label',
    fontSize: 12,
    color: [0.05, 0.2, 0.42],
    opacity: 1,
    rotation: 90
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [id],
    replacePageIndexes: [0]
  });

  const fakeAnnotation = await findAnnotationById(output, 0, id);
  assert.ok(fakeAnnotation);

  const appearance = await extractAppearanceRotationAndRect(
    output,
    0,
    fakeAnnotation!
  );
  assert.ok(appearance, 'expected rotation/rect to be recovered');
  assert.equal(appearance!.rotation, 90);
});

test('extractStampImage rejects a non-8-bit image instead of misreading its pixel bytes', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const id = 'malformed-16bit-stamp';
  const stamp: PdfAnnotation = {
    id,
    kind: 'imageStamp',
    pageIndex: 0,
    rect: { x1: 100, y1: 500, x2: 140, y2: 600 },
    imageData: RED_2X2_PNG_BASE64,
    mimeType: 'image/png',
    widthPx: 2,
    heightPx: 2,
    rotation: 0
  };

  const output = await writePdfAnnotations(bytes, [stamp], {
    replaceAnnotationSourceIds: [id],
    replacePageIndexes: [0]
  });

  const mutated = await mutateStampImageDict(output, 0, id, (imageDict) => {
    imageDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(16));
  });

  const fakeAnnotation = await findAnnotationById(mutated, 0, id);
  assert.ok(fakeAnnotation);
  const extracted = await extractStampImage(mutated, 0, fakeAnnotation!);
  assert.equal(extracted, null);
});

test('extractStampImage rejects a non-identity /Decode array instead of misreading its pixel bytes', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const id = 'malformed-decode-stamp';
  const stamp: PdfAnnotation = {
    id,
    kind: 'imageStamp',
    pageIndex: 0,
    rect: { x1: 100, y1: 500, x2: 140, y2: 600 },
    imageData: RED_2X2_PNG_BASE64,
    mimeType: 'image/png',
    widthPx: 2,
    heightPx: 2,
    rotation: 0
  };

  const output = await writePdfAnnotations(bytes, [stamp], {
    replaceAnnotationSourceIds: [id],
    replacePageIndexes: [0]
  });

  const mutated = await mutateStampImageDict(output, 0, id, (imageDict, context) => {
    imageDict.set(PDFName.of('Decode'), context.obj([1, 0, 1, 0, 1, 0]));
  });

  const fakeAnnotation = await findAnnotationById(mutated, 0, id);
  assert.ok(fakeAnnotation);
  const extracted = await extractStampImage(mutated, 0, fakeAnnotation!);
  assert.equal(extracted, null);
});

test('extractAppearanceRotationAndRect declines when BBox and Rect disagree (a scaled, non-this-app appearance)', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const id = 'malformed-scaled-stamp';
  const stamp: PdfAnnotation = {
    id,
    kind: 'imageStamp',
    pageIndex: 0,
    rect: { x1: 100, y1: 500, x2: 140, y2: 600 },
    imageData: RED_2X2_PNG_BASE64,
    mimeType: 'image/png',
    widthPx: 2,
    heightPx: 2,
    rotation: 0
  };

  const output = await writePdfAnnotations(bytes, [stamp], {
    replaceAnnotationSourceIds: [id],
    replacePageIndexes: [0]
  });

  const mutated = await mutateFormDict(output, 0, id, (formDict, context) => {
    // Scale the BBox to double size instead of matching Rect 1:1 - a
    // "translate only" assumption this app's own writer always satisfies,
    // but a hypothetical third-party tool might not.
    formDict.set(PDFName.of('BBox'), context.obj([0, 0, 80, 200]));
  });

  const fakeAnnotation = await findAnnotationById(mutated, 0, id);
  assert.ok(fakeAnnotation);
  const extracted = await extractStampImage(mutated, 0, fakeAnnotation!);
  assert.equal(extracted, null);
});

function assertRectsClose(
  actual: { x1: number; y1: number; x2: number; y2: number },
  expected: { x1: number; y1: number; x2: number; y2: number },
  message: string
) {
  const tolerance = 0.5;
  for (const key of ['x1', 'y1', 'x2', 'y2'] as const) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) <= tolerance,
      `${message}: ${key} expected ~${expected[key]}, got ${actual[key]}`
    );
  }
}

function decodePngDataUrlToRGBA(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const frames = UPNG.toRGBA8(png);
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(frames[0])
  };
}

async function findAnnotationById(
  bytes: Uint8Array,
  pageIndex: number,
  nm: string
): Promise<{ id: string; rect: number[] } | null> {
  const pdfDoc = await loadTestPdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const annots = page.node.Annots();
  if (!annots) {
    return null;
  }

  for (let index = 0; index < annots.size(); index += 1) {
    const ref = annots.get(index);
    if (!(ref instanceof PDFRef)) {
      continue;
    }

    const dict = pdfDoc.context.lookup(ref, PDFDict);
    const name = dict
      .lookupMaybe(PDFName.of('NM'), PDFString, PDFHexString)
      ?.decodeText();
    if (name !== nm) {
      continue;
    }

    const rectArray = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    const rect = rectArray
      ? [0, 1, 2, 3].map(
          (i) => rectArray.lookupMaybe(i, PDFNumber)?.asNumber() ?? 0
        )
      : [0, 0, 0, 0];

    return {
      id:
        ref.generationNumber === 0
          ? `${ref.objectNumber}R`
          : `${ref.objectNumber}R${ref.generationNumber}`,
      rect
    };
  }

  return null;
}

async function findFormAndImageDicts(
  bytes: Uint8Array,
  pageIndex: number,
  nm: string
) {
  const pdfDoc = await loadTestPdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const annots = page.node.Annots();
  if (!annots) {
    throw new Error('no annotations on page');
  }

  for (let index = 0; index < annots.size(); index += 1) {
    const ref = annots.get(index);
    if (!(ref instanceof PDFRef)) {
      continue;
    }

    const dict = pdfDoc.context.lookup(ref, PDFDict);
    const name = dict
      .lookupMaybe(PDFName.of('NM'), PDFString, PDFHexString)
      ?.decodeText();
    if (name !== nm) {
      continue;
    }

    const apDict = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
    const formRef = apDict?.get(PDFName.of('N'));
    const formStream =
      formRef instanceof PDFRef
        ? pdfDoc.context.lookup(formRef)
        : formRef;
    if (!(formStream instanceof PDFRawStream)) {
      throw new Error('expected a Form XObject appearance stream');
    }

    const resources = formStream.dict.lookupMaybe(
      PDFName.of('Resources'),
      PDFDict
    );
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const imageKey = xObjects?.keys()[0];
    const imageRef = imageKey ? xObjects?.get(imageKey) : undefined;
    const imageStream =
      imageRef instanceof PDFRef ? pdfDoc.context.lookup(imageRef) : imageRef;
    if (!(imageStream instanceof PDFRawStream)) {
      throw new Error('expected an Image XObject');
    }

    return { pdfDoc, formDict: formStream.dict, imageDict: imageStream.dict };
  }

  throw new Error(`annotation ${nm} not found`);
}

async function mutateStampImageDict(
  bytes: Uint8Array,
  pageIndex: number,
  nm: string,
  mutate: (imageDict: PDFDict, context: PDFContext) => void
) {
  const { pdfDoc, imageDict } = await findFormAndImageDicts(bytes, pageIndex, nm);
  mutate(imageDict, pdfDoc.context);
  return pdfDoc.save();
}

async function mutateFormDict(
  bytes: Uint8Array,
  pageIndex: number,
  nm: string,
  mutate: (formDict: PDFDict, context: PDFContext) => void
) {
  const { pdfDoc, formDict } = await findFormAndImageDicts(bytes, pageIndex, nm);
  mutate(formDict, pdfDoc.context);
  return pdfDoc.save();
}
