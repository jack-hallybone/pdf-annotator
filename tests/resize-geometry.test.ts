import assert from 'node:assert/strict';
import test from 'node:test';
import {
  imageStampAspectRatio,
  normalizedRect,
  resizeFreeTextWidth,
  resizeImageStampRect,
  resizeImageStampToHeight,
  resizeImageStampToWidth,
  rotatedAnnotationRect,
  unrotatePointForAnnotation
} from '../src/workspace/annotationGeometry';
import type { PdfAnnotation } from '../src/workspace/types';

function imageStamp(overrides: Partial<PdfAnnotation> = {}): PdfAnnotation {
  return {
    id: 'img-1',
    kind: 'imageStamp',
    pageIndex: 0,
    rect: { x1: 100, y1: 100, x2: 200, y2: 150 },
    imageData: '',
    mimeType: 'image/png',
    widthPx: 200,
    heightPx: 100,
    ...overrides
  } as PdfAnnotation;
}

test('normalizedRect orders corners min/max regardless of input order', () => {
  assert.deepEqual(normalizedRect({ x1: 50, y1: 80, x2: 10, y2: 20 }), {
    x1: 10,
    y1: 20,
    x2: 50,
    y2: 80
  });
});

test('imageStampAspectRatio is width/height and guards against zero height', () => {
  assert.equal(imageStampAspectRatio(imageStamp({ widthPx: 200, heightPx: 100 }) as never), 2);
  assert.equal(imageStampAspectRatio(imageStamp({ widthPx: 30, heightPx: 0 }) as never), 30);
});

test('resizeImageStampToWidth keeps 2:1 aspect ratio and pins the top-left corner', () => {
  const resized = resizeImageStampToWidth(imageStamp() as never, 300);
  // width 300 -> height 150 for a 2:1 ratio; x1/y2 (top-left anchor) unchanged.
  assert.equal(resized.rect.x1, 100);
  assert.equal(resized.rect.y2, 150);
  assert.equal(resized.rect.x2, 400);
  assert.equal(resized.rect.y1, 0); // 150 - 150
});

test('resizeImageStampToHeight keeps aspect ratio and pins the top-left corner', () => {
  const resized = resizeImageStampToHeight(imageStamp() as never, 200);
  // height 200 -> width 400 for a 2:1 ratio.
  assert.equal(resized.rect.x1, 100);
  assert.equal(resized.rect.y2, 150);
  assert.equal(resized.rect.x2, 500);
  assert.equal(resized.rect.y1, -50); // 150 - 200
});

test('resizeImageStampRect from bottom-right anchors the top-left and preserves aspect ratio', () => {
  const resized = resizeImageStampRect(
    imageStamp() as never,
    { x: 300, y: 300 },
    'bottom-right',
    1
  );
  // top-left anchor is (x1=100, y1=100). Result rect must keep aspect ratio 2:1.
  const width = resized.rect.x2 - resized.rect.x1;
  const height = resized.rect.y2 - resized.rect.y1;
  assert.ok(Math.abs(width / height - 2) < 1e-6);
  assert.equal(Math.min(resized.rect.x1, resized.rect.x2), 100);
});

// unrotatePointForAnnotation(localPoint, worldRect, rotation) maps a world
// (on-page) point to the annotation's local frame; applying it with the
// complementary angle (360 - rotation) is its own inverse, so it doubles as
// "given a point I want in local space, what world point produces it" -
// exactly what these tests need to drive a resize by a known local delta.
function worldPointFromLocal(
  localPoint: { x: number; y: number },
  worldRect: { x1: number; y1: number; x2: number; y2: number },
  rotation: number
) {
  return unrotatePointForAnnotation(localPoint, worldRect, (360 - rotation) % 360);
}

test('resizeImageStampRect keeps the anchor corner fixed in local space when the annotation itself is rotated', () => {
  const rotation = 90;
  const localRect = { x1: 100, y1: 100, x2: 300, y2: 200 }; // 200x100, matches 2:1 widthPx/heightPx
  const worldRect = rotatedAnnotationRect(localRect, rotation);
  const annotation = imageStamp({ rect: worldRect, rotation }) as never;

  // Drag the top-left handle so the local far corner (x1, y2) moves to (100, 250);
  // the anchor (opposite corner, x2/y1) must stay exactly where it started.
  const dragPoint = worldPointFromLocal({ x: 100, y: 250 }, worldRect, rotation);
  const resized = resizeImageStampRect(annotation, dragPoint, 'top-left', 1);

  const resultLocal = rotatedAnnotationRect(resized.rect, rotation);
  assert.ok(Math.abs(resultLocal.x2 - localRect.x2) < 1e-6, 'anchor x did not move');
  assert.ok(Math.abs(resultLocal.y1 - localRect.y1) < 1e-6, 'anchor y did not move');
  const width = resultLocal.x2 - resultLocal.x1;
  const height = resultLocal.y2 - resultLocal.y1;
  assert.ok(Math.abs(width / height - 2) < 1e-6, 'aspect ratio preserved');
});

test('resizeFreeTextWidth keeps the anchor edge fixed in local space when the annotation itself is rotated', () => {
  const rotation = 90;
  const localRect = { x1: 100, y1: 100, x2: 300, y2: 150 }; // 200 wide, 50 tall
  const worldRect = rotatedAnnotationRect(localRect, rotation);
  const annotation = {
    id: 'text-1',
    kind: 'freeText',
    pageIndex: 0,
    rect: worldRect,
    text: 'hello',
    fontSize: 12,
    color: [0, 0, 0],
    opacity: 1,
    rotation
  } as unknown as Extract<PdfAnnotation, { kind: 'freeText' }>;

  // Drag the right handle so the local right edge moves from x2=300 to x2=380;
  // the left edge (x1=100) and top/bottom must stay exactly where they started.
  const dragPoint = worldPointFromLocal({ x: 380, y: 125 }, worldRect, rotation);
  const resized = resizeFreeTextWidth(annotation, dragPoint, 'right');

  const resultLocal = rotatedAnnotationRect(resized.rect, rotation);
  assert.ok(Math.abs(resultLocal.x1 - localRect.x1) < 1e-6, 'left edge did not move');
  assert.ok(Math.abs(resultLocal.y1 - localRect.y1) < 1e-6, 'bottom edge did not move');
  assert.ok(Math.abs(resultLocal.y2 - localRect.y2) < 1e-6, 'top edge did not move');
  assert.ok(Math.abs(resultLocal.x2 - 380) < 1e-6, 'right edge moved to the requested width');
});
