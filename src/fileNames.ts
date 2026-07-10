const MAX_SAFE_PDF_FILENAME_LENGTH = 180;
const WINDOWS_RESERVED_FILE_STEMS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safePdfFileName(name: string, fallback = 'annotated.pdf') {
  const cleaned = cleanFileName(name) || cleanFileName(fallback) || 'annotated';
  return truncatePdfFileName(
    avoidWindowsReservedName(ensurePdfExtension(cleaned))
  );
}

function cleanFileName(name: string) {
  const cleaned = name
    // Intentionally strips ASCII control characters from filenames.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  return /^_+$/.test(cleaned) ? '' : cleaned;
}

function ensurePdfExtension(name: string) {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function avoidWindowsReservedName(name: string) {
  const stem = (name.split('.', 1)[0] ?? name).replace(/[. ]+$/g, '');
  return WINDOWS_RESERVED_FILE_STEMS.test(stem) ? `_${name}` : name;
}

function truncatePdfFileName(name: string) {
  if (name.length <= MAX_SAFE_PDF_FILENAME_LENGTH) {
    return name;
  }

  const extension = '.pdf';
  const maxStemLength = MAX_SAFE_PDF_FILENAME_LENGTH - extension.length;
  const stem = name.slice(0, -extension.length);
  const truncatedStem =
    stem.slice(0, maxStemLength).replace(/[. ]+$/g, '') || 'annotated';
  return `${truncatedStem}${extension}`;
}
