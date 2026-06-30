import assert from 'node:assert/strict';
import test from 'node:test';
import { readImageHeaderDimensions } from '../src/annotator/imageImport';

test('reads PNG dimensions from IHDR without decoding image pixels', () => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  bytes.set(ascii('IHDR'), 12);
  writeUint32be(bytes, 16, 640);
  writeUint32be(bytes, 20, 480);

  assert.deepEqual(readImageHeaderDimensions(bytes, 'image/png'), {
    height: 480,
    width: 640
  });
});

test('reads JPEG dimensions from start-of-frame marker', () => {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x02, 0x58,
    0x03, 0x20,
    0x03, 0x01, 0x11, 0x00
  ]);

  assert.deepEqual(readImageHeaderDimensions(bytes, 'image/jpeg'), {
    height: 600,
    width: 800
  });
});

test('reads WebP VP8X dimensions', () => {
  const bytes = new Uint8Array(30);
  bytes.set(ascii('RIFF'), 0);
  bytes.set(ascii('WEBP'), 8);
  bytes.set(ascii('VP8X'), 12);
  writeUint24le(bytes, 24, 1023);
  writeUint24le(bytes, 27, 767);

  assert.deepEqual(readImageHeaderDimensions(bytes, 'image/webp'), {
    height: 768,
    width: 1024
  });
});

function ascii(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0));
}

function writeUint24le(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

function writeUint32be(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
