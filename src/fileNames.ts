import {
  HIDDEN_CHARACTER_CLASS_BODY,
  stripHiddenCharacters,
} from "./hiddenCharacters";

const MAX_SAFE_PDF_FILENAME_LENGTH = 180;
const WINDOWS_RESERVED_FILE_STEMS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safePdfFileName(name: string, fallback = "annotated.pdf") {
  const cleaned = cleanFileName(name) || cleanFileName(fallback) || "annotated";
  return truncatePdfFileName(
    avoidWindowsReservedName(ensurePdfExtension(cleaned)),
  );
}

/*
 * A user-typed stem, or null when nothing legal is left: unlike
 * `safePdfFileName`, this one may reject rather than fall back.
 */
export function pdfFileNameFromStem(stem: string): string | null {
  const cleaned = stripUnsafeFileNameChars(stem, " ").replace(/\.pdf$/i, "");
  return cleaned ? `${cleaned}.pdf` : null;
}

/*
 * A file's name as text a reader is shown, not as a path, and possibly empty.
 */
export function displayableFileName(name: string) {
  return stripHiddenCharacters(name).replace(/\s+/g, " ").trim();
}

function cleanFileName(name: string) {
  const cleaned = stripUnsafeFileNameChars(name, "_").replace(/[. ]+$/g, "");

  return /^_+$/.test(cleaned) ? "" : cleaned;
}

/*
 * Two classes, only one about the filesystem: `<>:"/\|?*` are what a path
 * cannot hold, and the rest is what a person cannot see.
 */
const UNSAFE_FILE_NAME_CHARS = new RegExp(
  `[${HIDDEN_CHARACTER_CLASS_BODY}<>:"/\\\\|?*]+`,
  "gu",
);

function stripUnsafeFileNameChars(name: string, replacement: string) {
  return name
    .replace(UNSAFE_FILE_NAME_CHARS, replacement)
    .replace(/\s+/g, " ")
    .trim();
}

function ensurePdfExtension(name: string) {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function avoidWindowsReservedName(name: string) {
  const stem = (name.split(".", 1)[0] ?? name).replace(/[. ]+$/g, "");
  return WINDOWS_RESERVED_FILE_STEMS.test(stem) ? `_${name}` : name;
}

function truncatePdfFileName(name: string) {
  if (name.length <= MAX_SAFE_PDF_FILENAME_LENGTH) {
    return name;
  }

  const extension = ".pdf";
  const maxStemLength = MAX_SAFE_PDF_FILENAME_LENGTH - extension.length;
  const stem = name.slice(0, -extension.length);
  const truncatedStem =
    stem.slice(0, maxStemLength).replace(/[. ]+$/g, "") || "annotated";
  return `${truncatedStem}${extension}`;
}
