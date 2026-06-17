export type PreparedImageStamp = {
  data: string;
  downsampled: boolean;
  heightPx: number;
  mimeType: 'image/png';
  sourceBytes: number;
  widthPx: number;
};

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const MAX_IMAGE_DIMENSION = 1800;
const MAX_IMAGE_PIXELS = 2_400_000;

export async function prepareImageStampFromFile(file: File) {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Only PNG, JPEG and WebP images are supported.');
  }

  return prepareImageStampBlob(file);
}

export async function prepareImageStampFromBlob(blob: Blob) {
  if (!SUPPORTED_IMAGE_TYPES.has(blob.type)) {
    throw new Error('Only PNG, JPEG and WebP images are supported.');
  }

  return prepareImageStampBlob(blob);
}

export async function prepareImageStampFromClipboardItems(
  items: DataTransferItemList
) {
  for (const item of Array.from(items)) {
    if (item.kind !== 'file' || !SUPPORTED_IMAGE_TYPES.has(item.type)) {
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      return prepareImageStampBlob(file);
    }
  }

  return null;
}

async function prepareImageStampBlob(blob: Blob): Promise<PreparedImageStamp> {
  const bitmap = await createImageBitmap(blob);
  try {
    const dimensions = boundedImageDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not prepare the image.');
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const pngBlob = await canvasToPngBlob(canvas);
    return {
      data: await blobToBase64(pngBlob),
      downsampled: dimensions.scale < 1,
      heightPx: canvas.height,
      mimeType: 'image/png',
      sourceBytes: blob.size,
      widthPx: canvas.width
    };
  } finally {
    bitmap.close();
  }
}

function boundedImageDimensions(width: number, height: number) {
  const dimensionScale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(width, height)
  );
  const pixelScale = Math.min(
    1,
    Math.sqrt(MAX_IMAGE_PIXELS / Math.max(1, width * height))
  );
  const scale = Math.min(dimensionScale, pixelScale);

  return {
    height: Math.max(1, Math.round(height * scale)),
    scale,
    width: Math.max(1, Math.round(width * scale))
  };
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Could not encode the image.'));
      }
    }, 'image/png');
  });
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}
