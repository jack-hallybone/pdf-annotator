/*
 * pdf-lib's `lookupMaybe(key, Type)` throws when an entry exists but holds a
 * different legal PDF type, which is common: an /V form value may be a string,
 * name, array, stream or dictionary.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber } from "pdf-lib";

export function resolvedDictEntry(dict: PDFDict, key: PDFName) {
  const value = dict.context.lookup(dict.get(key));
  return value instanceof PDFDict ? value : undefined;
}

export function resolvedArrayEntry(dict: PDFDict, key: PDFName) {
  const value = dict.context.lookup(dict.get(key));
  return value instanceof PDFArray ? value : undefined;
}

export function resolvedNameEntry(dict: PDFDict, key: PDFName) {
  const value = dict.context.lookup(dict.get(key));
  return value instanceof PDFName ? value : undefined;
}

export function resolvedNumberEntry(dict: PDFDict, key: PDFName) {
  const value = dict.context.lookup(dict.get(key));
  return value instanceof PDFNumber ? value : undefined;
}

export function resolvedDictAt(array: PDFArray, index: number) {
  const value = array.lookup(index);
  return value instanceof PDFDict ? value : undefined;
}
