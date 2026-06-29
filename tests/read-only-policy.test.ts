import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCreateOutputCopy,
  canEditReadOnlyCopy
} from '../src/annotator/readOnlyPolicy';

test('only non-encrypted protected PDFs can be edited as a copy', () => {
  assert.equal(canEditReadOnlyCopy('PDF/A compliant'), true);
  assert.equal(canEditReadOnlyCopy('signed/certified'), true);
  assert.equal(canEditReadOnlyCopy('password protected'), false);
  assert.equal(canEditReadOnlyCopy(null), false);
});

test('encrypted PDFs cannot use output-copy routes', () => {
  assert.equal(canCreateOutputCopy('PDF/A compliant'), true);
  assert.equal(canCreateOutputCopy('signed/certified'), true);
  assert.equal(canCreateOutputCopy('password protected'), false);
  assert.equal(canCreateOutputCopy(null), true);
});
