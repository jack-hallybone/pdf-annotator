import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const outputDir = 'build';
const outputPath = join(outputDir, 'icon.ico');
const supersample = 4;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, createIco(iconSizes));

function createIco(sizes) {
  const images = sizes.map((size) => encodePng(size, drawIcon(size)));
  const headerSize = 6 + images.length * 16;
  let imageOffset = headerSize;
  const entries = images.map((image, index) => {
    const size = sizes[index];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    imageOffset += image.length;
    return entry;
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  return Buffer.concat([header, ...entries, ...images]);
}

function drawIcon(size) {
  const highSize = size * supersample;
  const pixels = new Uint8ClampedArray(highSize * highSize * 4);

  for (let y = 0; y < highSize; y += 1) {
    for (let x = 0; x < highSize; x += 1) {
      const unitX = ((x + 0.5) / highSize) * 24;
      const unitY = ((y + 0.5) / highSize) * 24;
      const color = pixelColor(unitX, unitY);
      writePixel(pixels, highSize, x, y, color);
    }
  }

  return downsample(pixels, highSize, size);
}

function pixelColor(x, y) {
  if (!insideRoundedRect(x, y, 0, 0, 24, 24, 5)) {
    return [255, 255, 255, 0];
  }

  let color = [255, 255, 255, 255];
  const chisel = [
    [9, 11],
    [3, 17],
    [3, 20],
    [12, 20],
    [15, 17]
  ];

  if (insidePolygon(x, y, chisel)) {
    color = [255, 254, 78, 255];
  }

  if (distanceToPolyline(x, y, [...chisel, chisel[0]]) <= 0.9) {
    color = [23, 28, 28, 255];
  }

  const body = [
    [22, 12],
    [17.4, 16.6],
    [15.6, 16.9],
    [14.4, 16.6],
    [9.4, 11.6],
    [9.1, 9.8],
    [9.4, 8.6],
    [14, 4]
  ];
  if (distanceToPolyline(x, y, body) <= 0.85) {
    color = [23, 28, 28, 255];
  }

  return color;
}

function downsample(source, sourceSize, targetSize) {
  const target = new Uint8ClampedArray(targetSize * targetSize * 4);
  const ratio = sourceSize / targetSize;

  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const totals = [0, 0, 0];
      let alphaTotal = 0;
      let count = 0;
      for (let yy = 0; yy < ratio; yy += 1) {
        for (let xx = 0; xx < ratio; xx += 1) {
          const sourceOffset =
            ((y * ratio + yy) * sourceSize + (x * ratio + xx)) * 4;
          const alpha = source[sourceOffset + 3] / 255;
          totals[0] += source[sourceOffset] * alpha;
          totals[1] += source[sourceOffset + 1] * alpha;
          totals[2] += source[sourceOffset + 2] * alpha;
          alphaTotal += alpha;
          count += 1;
        }
      }

      const alpha = alphaTotal / count;
      const color =
        alphaTotal > 0
          ? [
              totals[0] / alphaTotal,
              totals[1] / alphaTotal,
              totals[2] / alphaTotal,
              alpha * 255
            ]
          : [255, 255, 255, 0];
      writePixel(target, targetSize, x, y, color);
    }
  }

  return target;
}

function encodePng(size, pixels) {
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    scanlines[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      const sourceOffset = (y * size + x) * 4;
      const targetOffset = rowOffset + 1 + x * 4;
      scanlines[targetOffset] = pixels[sourceOffset];
      scanlines[targetOffset + 1] = pixels[sourceOffset + 1];
      scanlines[targetOffset + 2] = pixels[sourceOffset + 2];
      scanlines[targetOffset + 3] = pixels[sourceOffset + 3];
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr(size)),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function ihdr(size) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(size, 0);
  buffer.writeUInt32BE(size, 4);
  buffer.writeUInt8(8, 8);
  buffer.writeUInt8(6, 9);
  buffer.writeUInt8(0, 10);
  buffer.writeUInt8(0, 11);
  buffer.writeUInt8(0, 12);
  return buffer;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePixel(pixels, width, x, y, color) {
  const offset = (y * width + x) * 4;
  pixels[offset] = Math.round(color[0]);
  pixels[offset + 1] = Math.round(color[1]);
  pixels[offset + 2] = Math.round(color[2]);
  pixels[offset + 3] = Math.round(color[3]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  const nearestX = clamp(x, left + radius, right - radius);
  const nearestY = clamp(y, top + radius, bottom - radius);
  return distance(x, y, nearestX, nearestY) <= radius;
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolyline(x, y, points) {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    nearest = Math.min(
      nearest,
      distanceToSegment(x, y, points[index], points[index + 1])
    );
  }
  return nearest;
}

function distanceToSegment(x, y, start, end) {
  const [x1, y1] = start;
  const [x2, y2] = end;
  const lengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lengthSquared === 0) {
    return distance(x, y, x1, y1);
  }
  const t = clamp(
    ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / lengthSquared,
    0,
    1
  );
  return distance(x, y, x1 + t * (x2 - x1), y1 + t * (y2 - y1));
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
