const MAX_PDF_FILE_BYTES = 512 * 1024 * 1024;
const PDF_HEADER_SCAN_BYTES = 1024;

export async function readPdfFile(file: File) {
  if (file.size === 0) {
    throw new Error('The selected PDF is empty.');
  }

  if (file.size > MAX_PDF_FILE_BYTES) {
    throw new Error(
      `The selected PDF is ${formatBytes(file.size)}. The current safety limit is ${formatBytes(MAX_PDF_FILE_BYTES)}.`
    );
  }

  const header = new Uint8Array(
    await file.slice(0, PDF_HEADER_SCAN_BYTES).arrayBuffer()
  );
  if (!hasPdfHeader(header)) {
    throw new Error('The selected file does not look like a PDF.');
  }

  return new Uint8Array(await file.arrayBuffer());
}

function hasPdfHeader(bytes: Uint8Array) {
  const header = [37, 80, 68, 70, 45]; // %PDF-
  const maxStart = bytes.length - header.length;
  for (let index = 0; index <= maxStart; index += 1) {
    if (header.every((value, offset) => bytes[index + offset] === value)) {
      return true;
    }
  }
  return false;
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
