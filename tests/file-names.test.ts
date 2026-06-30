import assert from 'node:assert/strict';
import test from 'node:test';
import { safePdfFileName } from '../src/fileNames';

test('PDF filenames are sanitized and keep a PDF extension', () => {
  assert.equal(safePdfFileName('quarterly/report'), 'quarterly_report.pdf');
  assert.equal(safePdfFileName('invoice'), 'invoice.pdf');
  assert.equal(safePdfFileName('already.PDF'), 'already.PDF');
  assert.equal(safePdfFileName('name. '), 'name.pdf');
});

test('PDF filenames avoid Windows reserved device names', () => {
  assert.equal(safePdfFileName('CON.pdf'), '_CON.pdf');
  assert.equal(safePdfFileName('CON .pdf'), '_CON .pdf');
  assert.equal(safePdfFileName('lpt1'), '_lpt1.pdf');
});

test('PDF filenames fall back safely', () => {
  assert.equal(safePdfFileName(' /// ', 'fallback'), 'fallback.pdf');
  assert.equal(safePdfFileName(' /// ', 'NUL.pdf'), '_NUL.pdf');
});
