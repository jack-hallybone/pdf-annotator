import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendDraftInkPoints,
  appendMutableInkPoint,
  freehandHighlightMinLength,
  inkDotMaxLength
} from '../src/workspace/inkCapture';
import { millimetresToPdfUnits, pdfUnitsToMillimetres } from '../src/workspace/pdfUnits';
import type { PageViewport } from '../src/workspace/types';

// millimetresToPdfUnits/pdfUnitsToMillimetres only read viewport.userUnit.
function viewport(userUnit = 1): PageViewport {
  return { userUnit } as PageViewport;
}

test('millimetresToPdfUnits and pdfUnitsToMillimetres round-trip', () => {
  const mm = 10;
  const pdf = millimetresToPdfUnits(mm, viewport());
  // 10mm at 72 units/inch, 25.4mm/inch -> ~28.35 units
  assert.ok(Math.abs(pdf - (10 * 72) / 25.4) < 1e-9);
  assert.ok(Math.abs(pdfUnitsToMillimetres(pdf, viewport()) - mm) < 1e-9);
});

test('conversions honour a page /UserUnit scale', () => {
  const scaled = millimetresToPdfUnits(10, viewport(2));
  const unscaled = millimetresToPdfUnits(10, viewport(1));
  assert.ok(Math.abs(scaled - unscaled / 2) < 1e-9);
});

test('conversions fall back to userUnit=1 for invalid values', () => {
  assert.equal(
    millimetresToPdfUnits(10, viewport(0)),
    millimetresToPdfUnits(10, viewport(1))
  );
  assert.equal(
    millimetresToPdfUnits(10, viewport(Number.NaN)),
    millimetresToPdfUnits(10, viewport(1))
  );
});

test('appendMutableInkPoint drops points closer than minDistance and skips non-finite', () => {
  const path = [{ x: 0, y: 0 }];
  appendMutableInkPoint(path, { x: 0.5, y: 0 }, 1); // too close -> dropped
  assert.equal(path.length, 1);
  appendMutableInkPoint(path, { x: 2, y: 0 }, 1); // far enough -> kept
  assert.equal(path.length, 2);
  appendMutableInkPoint(path, { x: Number.NaN, y: 0 }, 1); // non-finite -> dropped
  assert.equal(path.length, 2);
});

test('appendDraftInkPoints thins a dense stream by capture spacing', () => {
  const path: { x: number; y: number }[] = [];
  const dense = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.001, y: 0 }));
  appendDraftInkPoints(path, dense, viewport());
  // Capture spacing is 0.05mm (~0.14 units); most sub-spacing points collapse.
  assert.ok(path.length > 0);
  assert.ok(path.length < dense.length);
});

test('inkDotMaxLength and freehandHighlightMinLength scale with zoom via userUnit', () => {
  assert.ok(inkDotMaxLength(viewport(1)) > inkDotMaxLength(viewport(2)));
  assert.ok(freehandHighlightMinLength(viewport(1)) > 0);
});
