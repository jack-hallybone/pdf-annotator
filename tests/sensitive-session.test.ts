import assert from 'node:assert/strict';
import test from 'node:test';
import { markNonSerializable } from '../src/workspace/sensitiveSession';

test('markNonSerializable throws on JSON.stringify instead of leaking data', () => {
  const value = markNonSerializable({ pdfBytes: new Uint8Array([1, 2, 3]) });
  assert.throws(() => JSON.stringify(value));
});

test('markNonSerializable leaves normal field access and enumeration untouched', () => {
  const value = markNonSerializable({ fileName: 'document.pdf', scale: 1 });
  assert.equal(value.fileName, 'document.pdf');
  assert.deepEqual(Object.keys(value), ['fileName', 'scale']);
});

test('markNonSerializable guard also fires for values nested under a stringified parent', () => {
  const value = markNonSerializable({ secret: 'bytes' });
  assert.throws(() => JSON.stringify({ wrapper: value }));
});
