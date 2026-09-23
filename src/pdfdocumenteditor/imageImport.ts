export type PreparedImageStamp = {
  data: string;
  heightPx: number;
  mimeType: "image/png";
  widthPx: number;
};

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_IMAGE_DIMENSION = 1800;
const MAX_IMAGE_PIXELS = 2_400_000;
/*
 * What one stamp may weigh, which the pixel caps above do not bound:
 * `imageData` is base64 held for as long as the tab lives, and every undo entry
 * naming the stamp names that string.
 */
export const MAX_IMAGE_STAMP_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_ENCODE_ATTEMPTS = 6;
const MAX_SOURCE_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_IMAGE_DIMENSION = 12_000;
const MAX_SOURCE_IMAGE_PIXELS = 16_000_000;
const IMAGE_HEADER_SCAN_BYTES = 64 * 1024;
const jpegStartOfFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

type ImageHeaderDimensions = {
  height: number;
  width: number;
};

export async function prepareImageStampFromFile(file: File) {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Only PNG, JPEG and WebP images are supported.");
  }

  return prepareImageStampBlob(file);
}

export async function prepareImageStampFromClipboardItems(
  items: DataTransferItemList,
) {
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !SUPPORTED_IMAGE_TYPES.has(item.type)) {
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      return prepareImageStampBlob(file);
    }
  }

  return null;
}

// The async Clipboard API, for a button-triggered paste rather than a native
// paste event - the browser's own permission prompt is the cost of that.
export async function prepareImageStampFromSystemClipboard() {
  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const type = item.types.find((candidate) =>
      SUPPORTED_IMAGE_TYPES.has(candidate),
    );
    if (type) {
      return prepareImageStampBlob(await item.getType(type));
    }
  }

  return null;
}

async function prepareImageStampBlob(blob: Blob): Promise<PreparedImageStamp> {
  if (blob.size === 0) {
    throw new Error("The image is empty.");
  }
  if (blob.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("Images larger than 32 MiB are not supported.");
  }

  // JPEG permits arbitrarily large metadata before its start-of-frame marker,
  // so the whole (already size-capped) file is scanned and an oversized image
  // cannot reach createImageBitmap with its dimensions still unknown.
  const headerScanBytes =
    blob.type === "image/jpeg" ? blob.size : IMAGE_HEADER_SCAN_BYTES;
  const headerDimensions = readImageHeaderDimensions(
    new Uint8Array(await blob.slice(0, headerScanBytes).arrayBuffer()),
    blob.type,
  );
  if (!headerDimensions) {
    throw new Error("Could not verify the image dimensions safely.");
  }
  assertSafeSourceImageDimensions(headerDimensions);

  const bitmap = await createImageBitmap(blob);
  try {
    assertSafeSourceImageDimensions({
      height: bitmap.height,
      width: bitmap.width,
    });

    const encoded = await encodedWithinByteBudget(
      boundedImageDimensions(bitmap.width, bitmap.height),
      (dimensions) => encodeBitmapAsPngBase64(bitmap, dimensions),
    );
    return {
      data: encoded.data,
      heightPx: encoded.height,
      mimeType: "image/png",
      widthPx: encoded.width,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * The bound is the measurement, never the estimate: only an encoding already
 * weighed against `MAX_IMAGE_STAMP_BYTES` is returned.
 */
export async function encodedWithinByteBudget(
  dimensions: ImageHeaderDimensions,
  encode: (dimensions: ImageHeaderDimensions) => Promise<string>,
) {
  let current = dimensions;
  for (let attempt = 0; attempt < MAX_IMAGE_ENCODE_ATTEMPTS; attempt += 1) {
    const data = await encode(current);
    if (data.length <= MAX_IMAGE_STAMP_BYTES) {
      return { data, height: current.height, width: current.width };
    }

    current = scaledDimensions(
      current,
      Math.sqrt(MAX_IMAGE_STAMP_BYTES / data.length) * 0.9,
    );
  }

  throw new Error("The image could not be reduced to a size this app can add.");
}

function boundedImageDimensions(
  width: number,
  height: number,
): ImageHeaderDimensions {
  const dimensionScale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(width, height),
  );
  const pixelScale = Math.min(
    1,
    Math.sqrt(MAX_IMAGE_PIXELS / Math.max(1, width * height)),
  );

  return scaledDimensions(
    { height, width },
    Math.min(dimensionScale, pixelScale),
  );
}

function scaledDimensions(
  { height, width }: ImageHeaderDimensions,
  scale: number,
): ImageHeaderDimensions {
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

async function encodeBitmapAsPngBase64(
  bitmap: ImageBitmap,
  { height, width }: ImageHeaderDimensions,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare the image.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  return blobToBase64(await canvasToPngBlob(canvas));
}

export function readImageHeaderDimensions(
  bytes: Uint8Array,
  mimeType: string,
): ImageHeaderDimensions | null {
  switch (mimeType) {
    case "image/png":
      return readPngDimensions(bytes);
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
    default:
      return null;
  }
}

function assertSafeSourceImageDimensions({
  height,
  width,
}: ImageHeaderDimensions) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    Math.max(width, height) > MAX_SOURCE_IMAGE_DIMENSION ||
    width * height > MAX_SOURCE_IMAGE_PIXELS
  ) {
    throw new Error("The image dimensions are too large to import safely.");
  }
}

function readPngDimensions(bytes: Uint8Array): ImageHeaderDimensions | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    ascii(bytes, 1, 4) !== "PNG" ||
    ascii(bytes, 12, 16) !== "IHDR"
  ) {
    return null;
  }

  return {
    height: uint32be(bytes, 20),
    width: uint32be(bytes, 16),
  };
}

function readJpegDimensions(bytes: Uint8Array): ImageHeaderDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }

    if (offset + 1 >= bytes.length) {
      return null;
    }

    const segmentLength = uint16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }

    if (jpegStartOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        height: uint16be(bytes, offset + 3),
        width: uint16be(bytes, offset + 5),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function readWebpDimensions(bytes: Uint8Array): ImageHeaderDimensions | null {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const chunkType = ascii(bytes, 12, 16);
  const dataOffset = 20;
  if (chunkType === "VP8X" && bytes.length >= dataOffset + 10) {
    return {
      height: uint24le(bytes, dataOffset + 7) + 1,
      width: uint24le(bytes, dataOffset + 4) + 1,
    };
  }

  if (
    chunkType === "VP8L" &&
    bytes.length >= dataOffset + 5 &&
    bytes[dataOffset] === 0x2f
  ) {
    const b0 = bytes[dataOffset + 1];
    const b1 = bytes[dataOffset + 2];
    const b2 = bytes[dataOffset + 3];
    const b3 = bytes[dataOffset + 4];
    return {
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      width: 1 + (((b1 & 0x3f) << 8) | b0),
    };
  }

  if (
    chunkType === "VP8 " &&
    bytes.length >= dataOffset + 10 &&
    bytes[dataOffset + 3] === 0x9d &&
    bytes[dataOffset + 4] === 0x01 &&
    bytes[dataOffset + 5] === 0x2a
  ) {
    return {
      height: uint16le(bytes, dataOffset + 8) & 0x3fff,
      width: uint16le(bytes, dataOffset + 6) & 0x3fff,
    };
  }

  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  if (bytes.length < end) {
    return "";
  }

  return String.fromCharCode(...bytes.slice(start, end));
}

function uint16be(bytes: Uint8Array, offset: number) {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function uint16le(bytes: Uint8Array, offset: number) {
  return bytes[offset] + bytes[offset + 1] * 0x100;
}

function uint24le(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000
  );
}

function uint32be(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not encode the image."));
      }
    }, "image/png");
  });
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}
