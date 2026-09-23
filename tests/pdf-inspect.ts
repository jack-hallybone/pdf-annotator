// The readers the deleted-page suites assert over, written independently of the
// source so they measure the file rather than agree with the implementation.
import assert from "node:assert/strict";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";
import {
  markersIn as markersMatching,
  matches as matchesPattern,
  streamText,
} from "./pdfMarkers";
import { loadTestPdf } from "./pdfTestUtils";

export const SECRET = /^SECRET-/;

export const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

// `LETTERHEAD-` is its own prefix because the letterhead probe asserts the same
// entries kept in one arrangement and taken in another.
const MARKER = /(?:SECRET|KEEP|SHARED|LETTERHEAD)-[A-Za-z0-9-]+/;

const matches = (text: string) => matchesPattern(text, MARKER);

export async function markersIn(bytes: Uint8Array) {
  return markersMatching(bytes, MARKER);
}

type ReadBack = {
  annotationCount: number;
  destinations: unknown;
  fieldNames: string[];
  namedDestination: unknown;
  ocgOrder: unknown;
  outlineTitles: string[];
  pageCount: number;
  structTreeAlts: string[];
};

export async function readBack(
  bytes: Uint8Array,
  step: string,
  namedDestination: string,
): Promise<ReadBack> {
  const read = async <T>(
    name: string,
    run: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      return assert.fail(
        `${step}: ${name} could not read the written bytes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const pdfLibDoc = await read("pdf-lib load", () => loadTestPdf(bytes));
  const fieldNames = await read("pdf-lib getForm", () =>
    pdfLibDoc
      .getForm()
      .getFields()
      .map((field) => field.getName())
      .sort(),
  );

  // isEvalSupported is inert on PDF.js 6 and absent from its types; hoisted so an
  // inline literal does not trip excess-property checking.
  const options = {
    data: bytes.slice(),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  };
  const loadingTask = getDocument(options);
  try {
    const pdfJsDoc = await read("pdf.js load", () => loadingTask.promise);
    let annotationCount = 0;
    const alts: string[] = [];
    for (let number = 1; number <= pdfJsDoc.numPages; number += 1) {
      const page = await read("pdf.js getPage", () => pdfJsDoc.getPage(number));
      annotationCount += (
        await read("pdf.js getAnnotations", () => page.getAnnotations())
      ).length;
      alts.push(
        ...structTreeAlts(
          await read("pdf.js getStructTree", () => page.getStructTree()),
        ),
      );
    }
    return {
      annotationCount,
      destinations: await read("pdf.js getDestinations", () =>
        pdfJsDoc.getDestinations(),
      ),
      fieldNames,
      namedDestination: await read("pdf.js getDestination", () =>
        pdfJsDoc.getDestination(namedDestination),
      ),
      ocgOrder: (
        await read("pdf.js getOptionalContentConfig", () =>
          pdfJsDoc.getOptionalContentConfig(),
        )
      ).getOrder(),
      outlineTitles: (
        (await read("pdf.js getOutline", () => pdfJsDoc.getOutline())) ?? []
      ).map((entry) => entry.title),
      pageCount: pdfLibDoc.getPageCount(),
      structTreeAlts: alts,
    };
  } finally {
    await loadingTask.destroy();
  }
}

function structTreeAlts(node: unknown): string[] {
  if (!node || typeof node !== "object") {
    return [];
  }
  const { alt, children } = node as { alt?: unknown; children?: unknown };
  return [
    ...(typeof alt === "string" ? [alt] : []),
    ...(Array.isArray(children) ? children.flatMap(structTreeAlts) : []),
  ];
}

// Every pointer the document still reaches that resolves to nothing, split by
// container: a list of objects cannot hold a member that resolves to nothing,
// while a coordinate holds a name or string beside the reference and a reference
// to a non-existent object is null.
export async function danglingPointers(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const { context } = pdfDoc;
  const seen = new Set<string>();
  const inLists: string[] = [];
  const coordinates: string[] = [];

  const walk = (
    object: PDFObject | undefined,
    path: string,
    memberOfList: boolean,
    depth: number,
  ) => {
    if (depth > 40 || object === undefined) {
      return;
    }
    if (object instanceof PDFRef) {
      const target = context.lookup(object);
      if (target === undefined) {
        (memberOfList ? inLists : coordinates).push(path);
        return;
      }
      if (seen.has(object.toString())) {
        return;
      }
      seen.add(object.toString());
      walk(target, path, false, depth + 1);
      return;
    }
    if (object instanceof PDFStream) {
      walk(object.dict, path, false, depth + 1);
      return;
    }
    if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        walk(value, `${path}${key.toString()}`, false, depth + 1);
      }
      return;
    }
    if (object instanceof PDFArray) {
      const entries = object.asArray();
      const isList =
        entries.length > 0 &&
        entries.every(
          (entry) => entry instanceof PDFRef || entry instanceof PDFDict,
        );
      entries.forEach((value, index) =>
        walk(value, `${path}[${index}]`, isList, depth + 1),
      );
    }
  };

  walk(pdfDoc.catalog, "/Root", false, 0);
  return { coordinates, inLists };
}

export function fieldNamed(pdfDoc: PDFDocument, name: string) {
  const fields = pdfDoc.catalog
    .lookup(PDFName.of("AcroForm"), PDFDict)
    .lookup(PDFName.of("Fields"), PDFArray);
  for (let index = 0; index < fields.size(); index += 1) {
    const field = fields.lookupMaybe(index, PDFDict);
    if (field?.lookupMaybe(PDFName.of("T"), PDFString)?.decodeText() === name) {
      return field;
    }
  }
  return undefined;
}

// Names no key: for each entry an element turns out to have it collects every
// marker under it, so a carrier the strip does not know about is visible here
// under its own name. It stops by type - a page is not walked, so `/Pg` drags no
// content in, and another element is not, so `/P` cannot climb back out.
export async function structureTexts(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const { context } = pdfDoc;
  const found = new Set<string>();
  const visited = new Set<PDFDict>();
  const pending = [
    asStructureDict(context, pdfDoc.catalog.get(PDFName.of("StructTreeRoot"))),
  ];

  while (pending.length > 0) {
    const element = pending.pop();
    if (!element || visited.has(element)) {
      continue;
    }
    visited.add(element);

    for (const [key, value] of element.entries()) {
      if (key === PDFName.of("K")) {
        for (const child of structureKids(context, value)) {
          pending.push(child);
        }
        continue;
      }
      for (const marker of [
        ...matches(key.toString()),
        ...markersUnder(context, value),
      ]) {
        found.add(`${key.toString()} ${marker}`);
      }
    }
  }
  return [...found].sort();
}

function markersUnder(
  context: PDFContext,
  value: PDFObject | undefined,
  depth = 0,
): string[] {
  if (value === undefined || depth > 24) {
    return [];
  }
  if (value instanceof PDFRef) {
    return markersUnder(context, context.lookup(value), depth + 1);
  }
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return matches(value.decodeText());
  }
  if (value instanceof PDFName || value instanceof PDFNumber) {
    return matches(value.toString());
  }
  if (value instanceof PDFArray) {
    return value
      .asArray()
      .flatMap((entry) => markersUnder(context, entry, depth + 1));
  }
  const dict = value instanceof PDFStream ? value.dict : value;
  if (!(dict instanceof PDFDict) || stopsTheRead(dict)) {
    return [];
  }
  return [
    ...(value instanceof PDFStream ? matches(streamText(value)) : []),
    ...dict
      .entries()
      .flatMap(([key, entry]) => [
        ...matches(key.toString()),
        ...markersUnder(context, entry, depth + 1),
      ]),
  ];
}

function stopsTheRead(dict: PDFDict) {
  const type = dict.get(PDFName.of("Type"));
  return (
    type === PDFName.of("Page") ||
    type === PDFName.of("Pages") ||
    type === PDFName.of("StructElem") ||
    type === PDFName.of("StructTreeRoot")
  );
}

function structureKids(context: PDFContext, value: PDFObject | undefined) {
  const kids = context.lookup(value);
  const entries = kids instanceof PDFArray ? kids.asArray() : [kids];
  return entries.map((entry) => asStructureDict(context, entry));
}

function asStructureDict(context: PDFContext, value: PDFObject | undefined) {
  const resolved = context.lookup(value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

export async function structTreeOfKeptPage(
  bytes: Uint8Array,
  pageNumber: number,
) {
  const options = {
    data: bytes.slice(),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  };
  const loadingTask = getDocument(options);
  try {
    const pdfJsDoc = await loadingTask.promise;
    const page = await pdfJsDoc.getPage(pageNumber);
    return JSON.stringify(await page.getStructTree());
  } finally {
    await loadingTask.destroy();
  }
}

// The keys each node holds and the /Limits of every node, because an identifier
// is repeated in the limits above its key.
export async function structureIdentifiers(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const root = pdfDoc.catalog.lookupMaybe(
    PDFName.of("StructTreeRoot"),
    PDFDict,
  );
  const found: string[] = [];
  const walk = (node: PDFDict | undefined, path: string, depth: number) => {
    if (!node || depth > 8) {
      return;
    }
    const limits = node
      .lookupMaybe(PDFName.of("Limits"), PDFArray)
      ?.asArray()
      .map((entry) => (entry as PDFString).decodeText());
    found.push(`${path} limits ${limits ? limits.join("..") : "none"}`);
    const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    for (let index = 0; index < (names?.size() ?? 0); index += 2) {
      const key = names?.lookupMaybe(index, PDFString, PDFHexString);
      const target = names?.lookupMaybe(index + 1, PDFDict);
      found.push(
        `${path} ${key?.decodeText()} -> ${target ? "an element" : "nothing"}`,
      );
    }
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    for (let index = 0; index < (kids?.size() ?? 0); index += 1) {
      walk(kids?.lookupMaybe(index, PDFDict), `${path}/${index}`, depth + 1);
    }
  };
  walk(root?.lookupMaybe(PDFName.of("IDTree"), PDFDict), "", 0);
  return found;
}

export function widgetExports(pdfDoc: PDFDocument) {
  const field = fieldNamed(pdfDoc, "group") ?? fieldNamed(pdfDoc, "radio");
  const terminal =
    field?.lookupMaybe(PDFName.of("T"), PDFString)?.decodeText() === "group"
      ? field.lookup(PDFName.of("Kids"), PDFArray).lookup(0, PDFDict)
      : field;
  const kids = terminal?.lookupMaybe(PDFName.of("Kids"), PDFArray);
  const options =
    terminal?.lookupMaybe(PDFName.of("Opt"), PDFArray) ??
    field?.lookupMaybe(PDFName.of("Opt"), PDFArray);
  const values: string[] = [];
  for (let index = 0; index < (kids?.size() ?? 0); index += 1) {
    const state = kids
      ?.lookupMaybe(index, PDFDict)
      ?.lookupMaybe(PDFName.of("AS"), PDFName)
      ?.decodeText();
    const exported = options?.lookupMaybe(index, PDFString)?.decodeText();
    values.push(`${state ?? "a kid that resolves to nothing"} = ${exported}`);
  }
  return values;
}

export async function pdfJsFieldNames(bytes: Uint8Array) {
  const options = {
    data: bytes.slice(),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  };
  const loadingTask = getDocument(options);
  try {
    const pdfJsDoc = await loadingTask.promise;
    return Object.keys((await pdfJsDoc.getFieldObjects()) ?? {}).sort();
  } finally {
    await loadingTask.destroy();
  }
}
