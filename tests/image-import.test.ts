import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_STAMP_BYTES,
  encodedWithinByteBudget,
  readImageHeaderDimensions,
} from "../src/pdfdocumenteditor/imageImport";

test("reads PNG dimensions from IHDR without decoding image pixels", () => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  bytes.set(ascii("IHDR"), 12);
  writeUint32be(bytes, 16, 640);
  writeUint32be(bytes, 20, 480);

  assert.deepEqual(readImageHeaderDimensions(bytes, "image/png"), {
    height: 480,
    width: 640,
  });
});

test("reads JPEG dimensions from start-of-frame marker", () => {
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b,
    0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x11, 0x00,
  ]);

  assert.deepEqual(readImageHeaderDimensions(bytes, "image/jpeg"), {
    height: 600,
    width: 800,
  });
});

test("reads WebP VP8X dimensions", () => {
  const bytes = new Uint8Array(30);
  bytes.set(ascii("RIFF"), 0);
  bytes.set(ascii("WEBP"), 8);
  bytes.set(ascii("VP8X"), 12);
  writeUint24le(bytes, 24, 1023);
  writeUint24le(bytes, 27, 767);

  assert.deepEqual(readImageHeaderDimensions(bytes, "image/webp"), {
    height: 768,
    width: 1024,
  });
});

// The pixel caps say how big a stamp may be drawn and this says how much it may
// weigh, driven with an encoder standing in for the canvas because the loop is
// the bound and the canvas is not.

/** An encoder whose output tracks pixel count, as a PNG's does. */
function encoderAt(bytesPerPixel: number) {
  const sizes: number[] = [];
  return {
    sizes,
    encode: async ({ height, width }: { height: number; width: number }) => {
      const bytes = Math.max(1, Math.round(width * height * bytesPerPixel));
      sizes.push(bytes);
      return "A".repeat(bytes);
    },
  };
}

test("an image that encodes past the byte cap is re-encoded smaller until it fits", async () => {
  // 1800x1333 of four-channel noise measures 12.25 MiB through the real
  // encoder; this is that shape.
  const { encode, sizes } = encoderAt((12.25 * 1024 * 1024) / (1800 * 1333));

  const encoded = await encodedWithinByteBudget(
    { height: 1333, width: 1800 },
    encode,
  );

  assert.ok(
    encoded.data.length <= MAX_IMAGE_STAMP_BYTES,
    `the stamp kept ${encoded.data.length} bytes, past the ${MAX_IMAGE_STAMP_BYTES}-byte cap`,
  );
  assert.ok(
    sizes[0] > MAX_IMAGE_STAMP_BYTES,
    "the first encode already fitted, so nothing about the cap was tested",
  );
  assert.ok(
    encoded.width < 1800 && encoded.height < 1333,
    "the stamp fitted the cap without being made smaller",
  );
});

test("an image already inside the cap is encoded once, at its full size", async () => {
  // A flat screenshot measures 68 KiB at the same dimensions: the common case
  // must not be re-encoded or shrunk.
  const { encode, sizes } = encoderAt((68 * 1024) / (1800 * 1333));

  const encoded = await encodedWithinByteBudget(
    { height: 1333, width: 1800 },
    encode,
  );

  assert.equal(sizes.length, 1);
  assert.deepEqual(
    { height: encoded.height, width: encoded.width },
    { height: 1333, width: 1800 },
  );
});

test("an encoder that never fits is refused rather than answered with an oversized stamp", async () => {
  // The bound is the measurement, so an encoder whose output ignores the size it
  // is asked for has to end in a refusal, not in a stamp over the cap.
  await assert.rejects(
    () =>
      encodedWithinByteBudget({ height: 1333, width: 1800 }, async () =>
        "A".repeat(MAX_IMAGE_STAMP_BYTES + 1),
      ),
    /could not be reduced/,
  );
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
