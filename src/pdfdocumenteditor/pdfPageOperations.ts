import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFPageLeaf,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  ParseSpeeds,
  decodePDFRawStream,
  degrees,
  rgb,
} from "pdf-lib";
import type { PDFContext, PDFObject } from "pdf-lib";
import { canonicalPdfReferenceKey } from "./annotationSourceKey";
import type { PdfAnnotationRenames } from "./pageIdentity";
import { NO_ANNOTATION_RENAMES } from "./pageIdentity";
import {
  resolvedArrayEntry,
  resolvedDictAt,
  resolvedDictEntry,
  resolvedNameEntry,
  resolvedNumberEntry,
} from "./pdfLookup";
import {
  pdfAClaimingMetadataRefs,
  verifyEditedPdfProtectionClaims,
} from "./pdfProtection";

const pdfaOutputIntentSubtypePrefix = "/GTS_PDFA";
// These caps exist only so a malformed cyclic tree cannot spin a walk forever.
const MAX_FIELD_TREE_DEPTH = 256;
const MAX_STRUCTURE_TREE_DEPTH = 256;
const MAX_TREE_NODES = 65536;
const MAX_PAGE_TREE_DEPTH = 256;
// Hitting either content-scan bound is "cannot say", never "not drawn".
const MAX_CONTENT_SCAN_DEPTH = 16;
const MAX_CONTENT_SCAN_BYTES = 32 * 1024 * 1024;
// `/S` is in neither this set nor the carrier set: an element must have one, so
// it is replaced rather than deleted.
const STRUCTURE_NODE_KEYS: ReadonlySet<PDFName> = new Set([
  PDFName.of("K"),
  PDFName.of("P"),
  PDFName.of("Pg"),
  PDFName.of("R"),
  PDFName.of("Type"),
]);

const linedPageLineColor = rgb(0.58, 0.66, 0.7);
const linedPageMarginColor = rgb(0.68, 0.72, 0.74);
const millimetresPerInch = 25.4;
const pdfPointsPerInch = 72;
const linedPageLineSpacing = (8 / millimetresPerInch) * pdfPointsPerInch;
const pdfLoadOptions = {
  parseSpeed: ParseSpeeds.Fastest,
  updateMetadata: false,
};
const pdfSaveOptions = {
  // pdf-lib yields to the event loop every objectsPerTick objects, and Infinity
  // disables that, blocking the main thread for the whole save.
  objectsPerTick: 500,
  updateFieldAppearances: false,
};

export function loadEditablePdf(bytes: Uint8Array) {
  return PDFDocument.load(bytes, pdfLoadOptions);
}

export class PdfProtectionSanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfProtectionSanitizationError";
  }
}

export async function saveEditedPdf(pdfDoc: PDFDocument) {
  stripPdfAConformanceClaims(pdfDoc);
  stripSignatureFields(pdfDoc);
  const output = await pdfDoc.save(pdfSaveOptions);
  const protection = await verifyEditedPdfProtectionClaims(output);
  if (!protection.verified) {
    throw new PdfProtectionSanitizationError(
      "The edited PDF could not be verified after saving. No file was written.",
    );
  }
  if (protection.signed || protection.pdfa) {
    throw new PdfProtectionSanitizationError(
      "The edited PDF still contains a signature or PDF/A conformance claim. Saving was stopped to avoid a misleading file.",
    );
  }
  return output;
}

// Deleting a dict entry only removes the pointer: pdf-lib's save() serialises
// every object it knows about, so the objects go from the context too.
function stripPdfAConformanceClaims(pdfDoc: PDFDocument) {
  try {
    const { context } = pdfDoc;
    // XMP is legal on any object, so every metadata stream is walked; deleting
    // /Metadata wholesale would take the user's own data with it.
    stripPdfAMetadataStreams(context);

    // PDF 2.0 allows OutputIntents on a page, not just the catalog.
    for (const dict of indirectDicts(context)) {
      stripPdfAOutputIntents(dict, context);
    }
  } catch {
    // A malformed structure must not block the save.
  }
}

function stripPdfAOutputIntents(dict: PDFDict, context: PDFContext) {
  const outputIntentsRef = dict.get(PDFName.of("OutputIntents"));
  const outputIntents = resolvedArrayEntry(dict, PDFName.of("OutputIntents"));
  if (!outputIntents) {
    return;
  }

  for (let index = outputIntents.size() - 1; index >= 0; index -= 1) {
    const entryRef = outputIntents.get(index);
    const intent = resolvedDictAt(outputIntents, index);
    const subtype = intent
      ? resolvedNameEntry(intent, PDFName.of("S"))
      : undefined;
    if (!subtype?.asString().startsWith(pdfaOutputIntentSubtypePrefix)) {
      continue;
    }

    if (intent) {
      deleteCatalogRef(intent, context, PDFName.of("DestOutputProfile"));
    }
    if (entryRef instanceof PDFRef) {
      context.delete(entryRef);
    }
    outputIntents.remove(index);
  }

  if (outputIntents.size() === 0) {
    if (outputIntentsRef instanceof PDFRef) {
      context.delete(outputIntentsRef);
    }
    dict.delete(PDFName.of("OutputIntents"));
  }
}

function stripPdfAMetadataStreams(context: PDFContext) {
  // Must stay the same finder pdfLooksPdfA uses, or a save leaves a claim in or
  // aborts on one it cannot remove.
  const claimingRefs = pdfAClaimingMetadataRefs(context);

  if (claimingRefs.size === 0) {
    return;
  }

  const metadataKey = PDFName.of("Metadata");
  for (const dict of indirectDicts(context)) {
    const ref = dict.get(metadataKey);
    if (ref instanceof PDFRef && claimingRefs.has(ref)) {
      dict.delete(metadataKey);
    }
  }

  for (const ref of claimingRefs) {
    context.delete(ref);
  }
}

function indirectDicts(context: PDFContext) {
  const dicts: PDFDict[] = [];
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      dicts.push(object);
    } else if (object instanceof PDFStream) {
      dicts.push(object.dict);
    }
  }
  return dicts;
}

// See CLAUDE.md Learnings on signature stripping.
function stripSignatureFields(pdfDoc: PDFDocument) {
  try {
    const { catalog } = pdfDoc;
    // Collected before anything is unlinked.
    const owned: PDFObject[] = [];
    const removed = new Set<PDFRef>();

    // DocMDP and UR3 signatures hang off /Perms, so pruning fields leaves them.
    stripSignaturePermissions(catalog, owned);

    const acroFormRef = catalog.get(PDFName.of("AcroForm"));
    const acroForm = resolvedDictEntry(catalog, PDFName.of("AcroForm"));
    const fields = acroForm
      ? resolvedArrayEntry(acroForm, PDFName.of("Fields"))
      : undefined;

    if (acroForm && fields) {
      pruneSignatureFields(fields, pdfDoc.context, removed, owned);

      if (removed.size > 0 && fields.size() === 0) {
        if (acroFormRef !== undefined) {
          owned.push(acroFormRef);
        }
        catalog.delete(PDFName.of("AcroForm"));
      } else {
        acroForm.delete(PDFName.of("SigFlags"));
      }
    }

    deleteSignatureObjects(pdfDoc, removed, owned);
  } catch {
    // A malformed AcroForm must not block the save.
  }
}

function deleteSignatureObjects(
  pdfDoc: PDFDocument,
  removed: ReadonlySet<PDFRef>,
  owned: PDFObject[],
) {
  if (removed.size === 0 && owned.length === 0) {
    return;
  }
  const candidates = referencesFrom(pdfDoc.context, owned, {
    ignoredKeys: OWNER_BACK_POINTER_KEYS,
  });
  const stillReachable = referencesFrom(pdfDoc.context, documentRoots(pdfDoc), {
    barrier: removed,
  });
  deleteObjects(pdfDoc, [
    ...removed,
    ...[...candidates].filter((ref) => !stillReachable.has(ref)),
  ]);
}

// /Fields is a tree, not a flat list, and a widget can be a separate kid.
function pruneSignatureFields(
  fields: PDFArray,
  context: PDFContext,
  removed: Set<PDFRef>,
  owned: PDFObject[],
  depth = 0,
  visited = new Set<PDFDict>(),
) {
  if (depth > MAX_FIELD_TREE_DEPTH) {
    throw new Error("Signature field tree is too deep to sanitize safely.");
  }

  for (let index = fields.size() - 1; index >= 0; index -= 1) {
    const fieldRef = fields.get(index);
    const field = resolvedDictAt(fields, index);
    if (!field) {
      continue;
    }
    if (visited.has(field)) {
      continue;
    }
    visited.add(field);

    if (isSignatureField(field)) {
      owned.push(field);
      removeWidgetKids(field, removed, depth);
      if (fieldRef instanceof PDFRef) {
        removed.add(fieldRef);
      }
      fields.remove(index);
      continue;
    }

    const kids = resolvedArrayEntry(field, PDFName.of("Kids"));
    if (!kids) {
      continue;
    }

    pruneSignatureFields(kids, context, removed, owned, depth + 1, visited);
    if (kids.size() === 0) {
      owned.push(field);
      if (fieldRef instanceof PDFRef) {
        removed.add(fieldRef);
      }
      fields.remove(index);
    }
  }
}

// The page's /Annots points at the widget, which may be a separate kid.
function removeWidgetKids(
  field: PDFDict,
  removed: Set<PDFRef>,
  depth: number,
  visited = new Set<PDFDict>(),
) {
  if (depth > MAX_FIELD_TREE_DEPTH) {
    throw new Error("Signature widget tree is too deep to sanitize safely.");
  }

  if (visited.has(field)) {
    return;
  }
  visited.add(field);

  const kids = resolvedArrayEntry(field, PDFName.of("Kids"));
  if (!kids) {
    return;
  }

  for (let index = kids.size() - 1; index >= 0; index -= 1) {
    const kidRef = kids.get(index);
    const kid = resolvedDictAt(kids, index);
    if (kid) {
      removeWidgetKids(kid, removed, depth + 1, visited);
    }
    if (kidRef instanceof PDFRef) {
      removed.add(kidRef);
    }
    kids.remove(index);
  }
}

function stripSignaturePermissions(catalog: PDFDict, owned: PDFObject[]) {
  const permsRef = catalog.get(PDFName.of("Perms"));
  const perms = resolvedDictEntry(catalog, PDFName.of("Perms"));
  if (!perms) {
    return;
  }

  for (const key of [PDFName.of("DocMDP"), PDFName.of("UR3")]) {
    const value = perms.get(key);
    if (value !== undefined) {
      owned.push(value);
    }
    perms.delete(key);
  }

  if (perms.keys().length === 0) {
    if (permsRef !== undefined) {
      owned.push(permsRef);
    }
    catalog.delete(PDFName.of("Perms"));
  }
}

function isSignatureField(field: PDFDict) {
  const fieldType = resolvedNameEntry(field, PDFName.of("FT"));
  if (fieldType?.asString() === "/Sig") {
    return true;
  }

  const value = resolvedDictEntry(field, PDFName.of("V"));
  const valueType = value
    ? resolvedNameEntry(value, PDFName.of("Type"))
    : undefined;
  return valueType?.asString() === "/Sig";
}

// pdf-lib's typed lookupMaybe throws when a present entry has another legal PDF
// type, so resolve first and narrow explicitly.

function deleteCatalogRef(dict: PDFDict, context: PDFContext, key: PDFName) {
  const ref = dict.get(key);
  if (ref instanceof PDFRef) {
    context.delete(ref);
  }
  dict.delete(key);
}

export async function addBlankPageAt(
  bytes: Uint8Array,
  pageIndex: number,
  templatePageIndex: number,
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourcePage = pdfDoc.getPage(templatePageIndex);
  const { width, height } = sourcePage.getSize();
  pdfDoc.insertPage(pageIndex, [width, height]);
  return saveEditedPdf(pdfDoc);
}

export async function addLinedPageAt(
  bytes: Uint8Array,
  pageIndex: number,
  templatePageIndex: number,
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourcePage = pdfDoc.getPage(templatePageIndex);
  const { width, height } = sourcePage.getSize();
  const page = pdfDoc.insertPage(pageIndex, [width, height]);
  drawLinedPage(page, width, height);
  return saveEditedPdf(pdfDoc);
}

// `unproven` means a content stream could not be read, so a description may be
// a deleted page's, or a kept page's already gone.
type PageRemoval = {
  bytes: Uint8Array;
  descriptionsUnproven: boolean;
};

export async function removePage(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<PageRemoval> {
  const pdfDoc = await loadEditablePdf(bytes);
  if (pdfDoc.getPageCount() <= 1) {
    throw new Error("A PDF must keep at least one page.");
  }

  const descriptionsUnproven = dropPages(pdfDoc, pageIndex, 1);
  return { bytes: await saveEditedPdf(pdfDoc), descriptionsUnproven };
}

export async function rotatePageClockwise(
  bytes: Uint8Array,
  pageIndex: number,
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const currentAngle = page.getRotation().angle;
  page.setRotation(degrees((currentAngle + 90) % 360));
  return saveEditedPdf(pdfDoc);
}

// pdf-lib has no reorder primitive, so this inserts before removing, and the
// removal index accounts for the shift the insertion just caused.
export async function movePageBy(
  bytes: Uint8Array,
  pageIndex: number,
  direction: 1 | -1,
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const pageCount = pdfDoc.getPageCount();
  const targetIndex = pageIndex + direction;
  if (
    pageIndex < 0 ||
    pageIndex >= pageCount ||
    targetIndex < 0 ||
    targetIndex >= pageCount
  ) {
    throw new Error("This page cannot be moved further in that direction.");
  }

  // Read before removing it, and not through `dropPages`: the same page object
  // is moved, not copied, and is not leaving the file.
  const movedPage = pdfDoc.getPage(pageIndex);
  pdfDoc.removePage(pageIndex);
  pdfDoc.insertPage(targetIndex, movedPage);
  return saveEditedPdf(pdfDoc);
}

export async function mergePdfAfterPage(
  bytes: Uint8Array,
  mergeBytes: Uint8Array,
  afterPageIndex: number,
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const mergeDoc = await loadEditablePdf(mergeBytes);
  const pageIndexes = mergeDoc.getPageIndices();
  // These pages come from another file, so a colliding object number must not
  // rename a live one.
  const insertAt = Math.min(
    Math.max(afterPageIndex + 1, 0),
    pdfDoc.getPageCount(),
  );
  const { pages: copiedPages } = await copyPagesInto(
    pdfDoc,
    mergeDoc,
    pageIndexes,
    (pages) =>
      pages.forEach((page, index) => {
        pdfDoc.insertPage(insertAt + index, page);
      }),
  );

  return {
    bytes: await saveEditedPdf(pdfDoc),
    insertAt,
    insertedPageCount: copiedPages.length,
    renames: NO_ANNOTATION_RENAMES,
  };
}

export async function rotatePageByDelta(
  bytes: Uint8Array,
  pageIndex: number,
  deltaDegrees: number,
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const currentAngle = page.getRotation().angle;
  const nextAngle = (((currentAngle + deltaDegrees) % 360) + 360) % 360;
  page.setRotation(degrees(nextAngle));
  return saveEditedPdf(pdfDoc);
}

export async function removePagesRange(
  bytes: Uint8Array,
  startIndex: number,
  count: number,
): Promise<PageRemoval> {
  const pdfDoc = await loadEditablePdf(bytes);
  // Same floor as removePage: a zero-page PDF is unopenable.
  if (pdfDoc.getPageCount() - count < 1) {
    throw new Error("A PDF must keep at least one page.");
  }

  const descriptionsUnproven = dropPages(pdfDoc, startIndex, count);
  return { bytes: await saveEditedPdf(pdfDoc), descriptionsUnproven };
}

// The one place a page leaves the document: `movePageBy` re-links rather than
// drops and must not come through here.
function dropPages(pdfDoc: PDFDocument, startIndex: number, count: number) {
  const { context } = pdfDoc;
  const leaving: PDFPage[] = [];
  for (let index = 0; index < count; index += 1) {
    leaving.push(pdfDoc.getPage(startIndex + index));
  }

  // Read before the removal, which leaves the page cache stale.
  const leavingRefs = refsLeavingWith(pdfDoc, startIndex, count);
  const droppedWithThePage = new Set([
    ...leavingRefs.pages,
    ...leavingRefs.annotations,
  ]);
  // From the annotations only: a page's own owner is the page tree, and
  // treating that as a field could take a node the tree still uses.
  for (const ref of fieldsWithNoWidgetLeft(context, leavingRefs.annotations)) {
    droppedWithThePage.add(ref);
  }

  for (let index = 0; index < count; index += 1) {
    pdfDoc.removePage(startIndex);
  }

  const { detached, unproven } = stripDescriptionsOfDroppedPages(
    pdfDoc,
    leavingRefs.pages,
  );

  const owned = referencesFrom(
    context,
    [
      ...leaving.map((page) => page.node),
      ...[...droppedWithThePage]
        .map((ref) => context.lookup(ref))
        .filter((object): object is PDFObject => object !== undefined),
    ],
    { ignoredKeys: OWNER_BACK_POINTER_KEYS },
  );
  for (const ref of droppedWithThePage) {
    owned.add(ref);
  }
  for (const ref of detached) {
    owned.add(ref);
  }

  const stillReachable = referencesFrom(context, documentRoots(pdfDoc), {
    barrier: droppedWithThePage,
  });
  deleteObjects(
    pdfDoc,
    [...owned].filter((ref) => !stillReachable.has(ref)),
  );
  return unproven;
}

// A button field's `/Opt` is indexed by `/Kids` position, and both `/FT` and
// `/Opt` are inheritable, so both are read up the parent chain.
function deleteObjects(pdfDoc: PDFDocument, refs: Iterable<PDFRef>) {
  const { context } = pdfDoc;
  const ceiling = context.largestObjectNumber;
  const deleted = new Set<PDFRef>();
  for (const ref of refs) {
    if (context.delete(ref)) {
      deleted.add(ref);
    }
  }
  if (deleted.size === 0) {
    return;
  }

  // Before the ceiling pin, so the walk reads the document with the deleted
  // objects absent rather than with an empty dictionary standing in.
  removeDeletedMembers(pdfDoc, deleted);

  const stillReaches = context
    .enumerateIndirectObjects()
    .some(([ref]) => ref.objectNumber >= ceiling);
  if (!stillReaches) {
    context.assign(PDFRef.of(ceiling), context.obj({}));
  }
}

// Containers are told apart by shape, not key name: a list of objects holds
// objects and nothing else, so a dead entry is pruned; a coordinate holds a
// name or string beside the reference and is positional, so it is left alone.
function removeDeletedMembers(
  pdfDoc: PDFDocument,
  deleted: ReadonlySet<PDFRef>,
) {
  const { context } = pdfDoc;
  const visited = new Set<PDFObject>();
  const pending: PDFObject[] = [...documentRoots(pdfDoc)];

  while (pending.length > 0) {
    const object = pending.pop();
    if (!object) {
      continue;
    }

    if (object instanceof PDFRef) {
      const target = context.lookup(object);
      if (target) {
        pending.push(target);
      }
      continue;
    }

    if (visited.has(object)) {
      continue;
    }
    visited.add(object);

    if (object instanceof PDFStream) {
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        const list = resolvedArray(context, value);
        if (list) {
          removeDeletedFromList(object, key, list, deleted);
        }
        pending.push(value);
      }
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) {
        pending.push(value);
      }
    }
  }
}

function removeDeletedFromList(
  owner: PDFDict,
  key: PDFName,
  list: PDFArray,
  deleted: ReadonlySet<PDFRef>,
) {
  const entries = list.asArray();
  const holdsObjectsOnly = entries.every(
    (entry) => entry instanceof PDFRef || entry instanceof PDFDict,
  );
  if (
    entries.length === 0 ||
    !holdsObjectsOnly ||
    !entries.some((entry) => entry instanceof PDFRef && deleted.has(entry))
  ) {
    return;
  }

  const pruning = kidPruning(owner, key, entries.length);
  if (!pruning.prune) {
    return;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!(entry instanceof PDFRef) || !deleted.has(entry)) {
      continue;
    }
    list.remove(index);
    pruning.options?.remove(index);
  }
}

// pdf-lib allocates above the highest object number it has seen, so a deletion
// that would lower that ceiling leaves an empty object at it instead.
function kidPruning(
  owner: PDFDict,
  key: PDFName,
  kidCount: number,
): { options?: PDFArray; prune: boolean } {
  if (key !== PDFName.of("Kids") || inheritedFieldType(owner) !== "/Btn") {
    return { prune: true };
  }
  const inherited = inheritedOptions(owner);
  if (!inherited) {
    return { prune: true };
  }
  if (inherited.options.size() !== kidCount) {
    return { prune: false };
  }
  if (inherited.field === owner) {
    return { options: inherited.options, prune: true };
  }

  const own = owner.context.obj([...inherited.options.asArray()]);
  owner.set(PDFName.of("Opt"), own);
  return { options: own instanceof PDFArray ? own : undefined, prune: true };
}

function inheritedFieldType(field: PDFDict) {
  return inheritedEntry(field, (current) =>
    resolvedNameEntry(current, PDFName.of("FT"))?.asString(),
  );
}

function inheritedOptions(field: PDFDict) {
  return inheritedEntry(field, (current) => {
    const options = resolvedArrayEntry(current, PDFName.of("Opt"));
    return options ? { field: current, options } : undefined;
  });
}

function inheritedEntry<T>(
  field: PDFDict,
  read: (current: PDFDict) => T | undefined,
) {
  let current: PDFDict | undefined = field;
  for (let depth = 0; current && depth < MAX_FIELD_TREE_DEPTH; depth += 1) {
    const answer = read(current);
    if (answer !== undefined) {
      return answer;
    }
    current = resolvedDictEntry(current, PDFName.of("Parent"));
  }
  return undefined;
}

function resolvedArray(context: PDFContext, value: PDFObject) {
  const resolved = value instanceof PDFRef ? context.lookup(value) : value;
  return resolved instanceof PDFArray ? resolved : undefined;
}

// Attributes attach through `/A` and by class through `/C` (ISO 32000-1
// 14.7.5), so both are followed.
function stripDescriptionsOfDroppedPages(
  pdfDoc: PDFDocument,
  droppedPages: ReadonlySet<PDFRef>,
) {
  const { context } = pdfDoc;
  const detached = new Set<PDFRef>();
  const nothingToPlace = { detached, unproven: false };
  if (droppedPages.size === 0) {
    return nothingToPlace;
  }
  const root = resolvedDictEntry(pdfDoc.catalog, PDFName.of("StructTreeRoot"));
  if (!root) {
    return nothingToPlace;
  }

  const placement = placementByParentTree(pdfDoc, root, droppedPages);
  const walk: StructureWalk = {
    identifiers: new Set<string>(),
    named: placement.named,
    placedOnDropped: placement.onDropped,
    placedOnKept: placement.onKept,
    reachedEverything: true,
    removed: [] as PDFObject[],
    usedClasses: new Set<PDFName>(),
    visited: new Set<PDFDict>(),
  };
  for (const child of structureChildren(context, root)) {
    clearDescriptionsBelow(context, child, undefined, 1, droppedPages, walk);
  }
  removeStructureIdentifiers(context, root, walk.identifiers, walk.removed);
  removeUnusedClasses(root, walk);

  for (const ref of referencesFrom(context, walk.removed, {
    ignoredKeys: OWNER_BACK_POINTER_KEYS,
  })) {
    detached.add(ref);
  }
  return { detached, unproven: placement.unproven };
}

type StructureWalk = {
  identifiers: Set<string>;
  named: Set<PDFDict>;
  placedOnDropped: ReadonlySet<PDFDict>;
  placedOnKept: ReadonlySet<PDFDict>;
  reachedEverything: boolean;
  removed: PDFObject[];
  usedClasses: Set<PDFName>;
  visited: Set<PDFDict>;
};

// An element naming no page of its own is placed by what is below it.
function clearDescriptionsBelow(
  context: PDFContext,
  element: PDFDict,
  inheritedPage: PDFRef | undefined,
  depth: number,
  droppedPages: ReadonlySet<PDFRef>,
  walk: StructureWalk,
): { keeps: boolean; placed: boolean } {
  if (depth > MAX_STRUCTURE_TREE_DEPTH || walk.visited.has(element)) {
    // An element this walk cannot finish reading keeps everything.
    walk.reachedEverything = false;
    return { keeps: true, placed: false };
  }
  walk.visited.add(element);
  for (const target of referencedElements(context, element)) {
    walk.named.add(target);
  }

  const own = element.get(PDFName.of("Pg"));
  const page = own instanceof PDFRef ? own : inheritedPage;
  const onKeptPage =
    (page !== undefined && !droppedPages.has(page)) ||
    walk.placedOnKept.has(element);
  let keeps = onKeptPage;
  let placed =
    onKeptPage || page !== undefined || walk.placedOnDropped.has(element);

  for (const child of structureChildren(context, element)) {
    // Every child, not just until one answers: the whole subtree must be seen.
    const below = clearDescriptionsBelow(
      context,
      child,
      page,
      depth + 1,
      droppedPages,
      walk,
    );
    keeps = below.keeps || keeps;
    placed = below.placed || placed;
  }

  if (placed && !keeps && isStructureElement(element)) {
    clearDescription(context, element, walk);
    return { keeps, placed };
  }
  for (const name of classNames(context, element)) {
    walk.usedClasses.add(name);
  }
  return { keeps, placed };
}

// `/Type` is optional and `/S` required, so a dictionary with neither is a
// coordinate into the content rather than an element.
function isStructureElement(dict: PDFDict) {
  const type = dict.get(PDFName.of("Type"));
  if (type instanceof PDFName) {
    return type === PDFName.of("StructElem");
  }
  return dict.has(PDFName.of("S"));
}

// Placement is `/StructParents` into the `/ParentTree`, indexed by `/MCID` (ISO
// 32000-1 14.7.4.4), not the optional `/Pg`; see CLAUDE.md Learnings.
function placementByParentTree(
  pdfDoc: PDFDocument,
  root: PDFDict,
  droppedPages: ReadonlySet<PDFRef>,
) {
  const { context } = pdfDoc;
  const nothing = {
    named: new Set<PDFDict>(),
    onDropped: new Set<PDFDict>() as ReadonlySet<PDFDict>,
    onKept: new Set<PDFDict>() as ReadonlySet<PDFDict>,
    unproven: false,
  };
  const parentTree = resolvedDictEntry(root, PDFName.of("ParentTree"));
  if (!parentTree) {
    return nothing;
  }
  const entries = new Map<number, PDFObject>();
  collectNumberTree(context, parentTree, entries, { nodes: 0 }, 0);
  if (entries.size === 0) {
    return nothing;
  }

  const droppedNodes: PDFDict[] = [];
  for (const ref of droppedPages) {
    const node = asDict(context.lookup(ref));
    if (node) {
      droppedNodes.push(node);
    }
  }
  const keptNodes = pageNodesOf(pdfDoc);
  const dropped = structureParentKeys(context, droppedNodes);
  const kept = structureParentKeys(context, keptNodes);
  const droppedListed = listedAnnotations(droppedNodes);
  const keptListed = listedAnnotations(keptNodes);

  let droppedSide = claimsWithoutContent(dropped, droppedListed);
  let keptSide = claimsWithoutContent(kept, keptListed);
  const unsettled = keysTheContentMustDecide(
    entries,
    droppedSide,
    keptSide,
    new Set([...droppedNodes, ...keptNodes]),
  );
  const scan: ContentScan = {
    budget: MAX_CONTENT_SCAN_BYTES,
    complete: true,
  };
  if (unsettled.size > 0) {
    droppedSide = claimsWithContent(
      context,
      dropped,
      droppedListed,
      droppedNodes,
      scan,
    );
    keptSide = claimsWithContent(context, kept, keptListed, keptNodes, scan);
  }

  const onDropped = elementsAt(
    context,
    entries,
    exclusiveKeys(droppedSide, keptSide),
  );
  const onKept = elementsAt(
    context,
    entries,
    exclusiveKeys(keptSide, droppedSide),
  );
  // Ambiguous keys included: an undecidable element is still one the walk saw.
  const named = elementsAt(
    context,
    entries,
    new Set([...droppedSide.holders.keys(), ...keptSide.holders.keys()]),
  );
  return {
    named,
    onDropped,
    onKept,
    // An incomplete scan can answer a key it did read wrongly by the same gap.
    unproven: !scan.complete && unsettled.size > 0,
  };
}

function exclusiveKeys(side: SideClaims, other: SideClaims) {
  const keys = new Set<number>();
  for (const [key, holders] of side.holders) {
    for (const holder of holders) {
      if (side.drawn.has(holder) || side.listed.has(holder)) {
        keys.add(key);
        break;
      }
      if (other.drawn.has(holder)) {
        continue;
      }
      if (!other.owned.has(holder)) {
        keys.add(key);
        break;
      }
    }
  }
  return keys;
}

// The keys references alone cannot be trusted on, and the only ones the scan
// runs for: reaching an XObject is not drawing it.
function keysTheContentMustDecide(
  entries: ReadonlyMap<number, PDFObject>,
  dropped: SideClaims,
  kept: SideClaims,
  pageNodes: ReadonlySet<PDFDict>,
) {
  const exclusiveDropped = exclusiveKeys(dropped, kept);
  const exclusiveKept = exclusiveKeys(kept, dropped);
  const keys = new Set<number>();
  for (const side of [dropped, kept]) {
    for (const [key, holders] of side.holders) {
      const ambiguous = !exclusiveDropped.has(key) && !exclusiveKept.has(key);
      const drawable = [...holders].some(
        (holder) =>
          !pageNodes.has(holder) &&
          resolvedNumberEntry(
            holder,
            PDFName.of("StructParents"),
          )?.asNumber() === key,
      );
      if (ambiguous || drawable) {
        keys.add(key);
      }
    }
  }
  for (const key of entries.keys()) {
    if (!dropped.holders.has(key) && !kept.holders.has(key)) {
      keys.add(key);
    }
  }
  return keys;
}

const NO_DICTS: ReadonlySet<PDFDict> = new Set<PDFDict>();

function claimsWithoutContent(
  claims: ParentKeyClaims,
  listed: ReadonlySet<PDFDict>,
): SideClaims {
  return { ...claims, drawn: NO_DICTS, listed };
}

function claimsWithContent(
  context: PDFContext,
  claims: ParentKeyClaims,
  listed: ReadonlySet<PDFDict>,
  pages: PDFDict[],
  scan: ContentScan,
): SideClaims {
  const drawn = drawnOwners(context, pages, scan);
  const holders = new Map<number, Set<PDFDict>>();
  for (const [key, held] of claims.holders) {
    holders.set(key, new Set(held));
  }
  for (const owner of drawn) {
    for (const key of STRUCTURE_PARENT_KEYS) {
      const value = context.lookup(owner.get(key));
      if (value instanceof PDFNumber) {
        const number = value.asNumber();
        const held = holders.get(number) ?? new Set<PDFDict>();
        held.add(owner);
        holders.set(number, held);
      }
    }
  }
  return { drawn, holders, listed, owned: claims.owned };
}

function listedAnnotations(pages: PDFDict[]) {
  const listed = new Set<PDFDict>();
  for (const page of pages) {
    const annots = resolvedArrayEntry(page, PDFName.of("Annots"));
    if (!annots) {
      continue;
    }
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = resolvedDictAt(annots, index);
      if (annot) {
        listed.add(annot);
      }
    }
  }
  return listed;
}

type ContentScan = {
  budget: number;
  complete: boolean;
};

// An XObject's marked content is on exactly the pages that draw it, so `Do` is
// followed transitively.
function drawnOwners(context: PDFContext, pages: PDFDict[], scan: ContentScan) {
  const drawn = new Set<PDFDict>();
  const walked = new Map<PDFStream, Set<PDFDict | undefined>>();
  for (const page of pages) {
    drawn.add(page);
    followDrawnXObjects(
      context,
      pageContent(context, page, scan),
      inheritedResources(page),
      { drawn, scan, walked },
      1,
    );
  }
  return drawn;
}

type DrawWalk = {
  drawn: Set<PDFDict>;
  scan: ContentScan;
  walked: Map<PDFStream, Set<PDFDict | undefined>>;
};

function followDrawnXObjects(
  context: PDFContext,
  streams: PDFStream[],
  resources: PDFDict | undefined,
  walk: DrawWalk,
  depth: number,
) {
  if (depth > MAX_CONTENT_SCAN_DEPTH) {
    walk.scan.complete = false;
    return;
  }
  const bytes: Uint8Array[] = [];
  for (const stream of streams) {
    const under = walk.walked.get(stream) ?? new Set<PDFDict | undefined>();
    if (under.has(resources)) {
      continue;
    }
    under.add(resources);
    walk.walked.set(stream, under);

    const decoded = decodedContent(stream);
    if (!decoded) {
      walk.scan.complete = false;
      continue;
    }
    walk.scan.budget -= decoded.length;
    if (walk.scan.budget < 0) {
      walk.scan.complete = false;
      return;
    }
    bytes.push(decoded);
  }
  if (bytes.length === 0) {
    return;
  }

  // A page's `/Contents` array is one stream cut into pieces - a token may
  // straddle the join - so they are read as one.
  const read = xObjectNamesDrawnBy(joinedBytes(bytes));
  if (!read.complete) {
    walk.scan.complete = false;
  }
  const xObjects = resources
    ? resolvedDictEntry(resources, PDFName.of("XObject"))
    : undefined;
  for (const name of read.names) {
    const target = xObjects
      ? context.lookup(xObjects.get(PDFName.of(name)))
      : undefined;
    if (!(target instanceof PDFStream)) {
      continue;
    }
    walk.drawn.add(target.dict);
    if (
      resolvedNameEntry(target.dict, PDFName.of("Subtype")) ===
      PDFName.of("Form")
    ) {
      followDrawnXObjects(
        context,
        [target],
        resolvedDictEntry(target.dict, PDFName.of("Resources")) ?? resources,
        walk,
        depth + 1,
      );
    }
  }
}

// No `/Contents` is an answer; a `/Contents` this cannot read is "cannot say".
function pageContent(context: PDFContext, page: PDFDict, scan: ContentScan) {
  const declared = page.get(PDFName.of("Contents"));
  if (declared === undefined) {
    return [];
  }
  const contents = context.lookup(declared);
  const entries =
    contents instanceof PDFArray ? contents.asArray() : [contents];
  const streams: PDFStream[] = [];
  for (const entry of entries) {
    const stream = context.lookup(entry);
    if (stream instanceof PDFStream) {
      streams.push(stream);
    } else {
      scan.complete = false;
    }
  }
  return streams;
}

/** `/Resources` is inheritable, so a page may hold none of its own. */
function inheritedResources(page: PDFDict) {
  let node: PDFDict | undefined = page;
  for (let depth = 0; node && depth < MAX_PAGE_TREE_DEPTH; depth += 1) {
    const resources = resolvedDictEntry(node, PDFName.of("Resources"));
    if (resources) {
      return resources;
    }
    node = resolvedDictEntry(node, PDFName.of("Parent"));
  }
  return undefined;
}

function decodedContent(stream: PDFStream) {
  if (!(stream instanceof PDFRawStream)) {
    return undefined;
  }
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return undefined;
  }
}

function joinedBytes(pieces: Uint8Array[]) {
  if (pieces.length === 1) {
    return pieces[0];
  }
  const joined = new Uint8Array(
    pieces.reduce((total, piece) => total + piece.length + 1, 0),
  );
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
    joined[offset] = 0x0a;
    offset += 1;
  }
  return joined;
}

const CONTENT_WHITESPACE: ReadonlySet<number> = new Set([
  0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20,
]);
const CONTENT_DELIMITERS: ReadonlySet<number> = new Set([
  0x25, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d,
]);

function isRegularContentByte(byte: number) {
  return !CONTENT_WHITESPACE.has(byte) && !CONTENT_DELIMITERS.has(byte);
}

// Not an interpreter, but it must tell a name from a comment, a string or an
// inline image's bytes: a `(/Fm0 Do)` inside a string is not a draw.
function xObjectNamesDrawnBy(bytes: Uint8Array) {
  const names: string[] = [];
  let complete = true;
  let operand: string | undefined;
  let index = 0;

  while (index < bytes.length) {
    const byte = bytes[index];
    if (CONTENT_WHITESPACE.has(byte)) {
      index += 1;
      continue;
    }
    if (byte === 0x25) {
      while (
        index < bytes.length &&
        bytes[index] !== 0x0a &&
        bytes[index] !== 0x0d
      ) {
        index += 1;
      }
      continue;
    }
    if (byte === 0x28) {
      const end = endOfLiteralString(bytes, index);
      if (end < 0) {
        complete = false;
        break;
      }
      index = end;
      continue;
    }
    if (byte === 0x3c) {
      if (bytes[index + 1] === 0x3c) {
        index += 2;
        continue;
      }
      const end = bytes.indexOf(0x3e, index);
      if (end < 0) {
        complete = false;
        break;
      }
      index = end + 1;
      continue;
    }
    if (byte === 0x3e) {
      index += bytes[index + 1] === 0x3e ? 2 : 1;
      continue;
    }
    if (byte === 0x2f) {
      const start = index + 1;
      index = start;
      while (index < bytes.length && isRegularContentByte(bytes[index])) {
        index += 1;
      }
      // Raw text, so a `#20` here and a `#20` in `/XObject` intern the same.
      operand = latin1(bytes, start, index);
      continue;
    }
    if (!isRegularContentByte(byte)) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < bytes.length && isRegularContentByte(bytes[index])) {
      index += 1;
    }
    const token = latin1(bytes, start, index);
    if (token === "Do" && operand !== undefined) {
      names.push(operand);
    }
    // An operator consumed its operands: the next `Do` needs its own name.
    operand = undefined;
    if (token === "ID") {
      const end = endOfInlineImage(bytes, index);
      if (end < 0) {
        complete = false;
        break;
      }
      index = end;
    }
  }
  return { complete, names };
}

function endOfLiteralString(bytes: Uint8Array, open: number) {
  let depth = 0;
  let index = open;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === 0x5c) {
      index += 2;
      continue;
    }
    if (byte === 0x28) {
      depth += 1;
    } else if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return -1;
}

function endOfInlineImage(bytes: Uint8Array, from: number) {
  for (let index = from + 1; index + 1 < bytes.length; index += 1) {
    if (bytes[index] !== 0x45 || bytes[index + 1] !== 0x49) {
      continue;
    }
    const after = index + 2 < bytes.length ? bytes[index + 2] : 0x20;
    if (
      CONTENT_WHITESPACE.has(bytes[index - 1]) &&
      CONTENT_WHITESPACE.has(after)
    ) {
      return index + 2;
    }
  }
  return -1;
}

function latin1(bytes: Uint8Array, start: number, end: number) {
  let text = "";
  for (let index = start; index < end; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

// `/StructParents` on a content stream's owner, `/StructParent` on one item.
const STRUCTURE_PARENT_KEYS: readonly PDFName[] = [
  PDFName.of("StructParent"),
  PDFName.of("StructParents"),
];

type ParentKeyClaims = {
  holders: Map<number, Set<PDFDict>>;
  owned: Set<PDFDict>;
};

type SideClaims = ParentKeyClaims & {
  drawn: ReadonlySet<PDFDict>;
  listed: ReadonlySet<PDFDict>;
};

function structureParentKeys(
  context: PDFContext,
  pages: PDFDict[],
): ParentKeyClaims {
  const holders = new Map<number, Set<PDFDict>>();
  const owned = new Set<PDFDict>();
  const own = new Set<PDFDict>(pages);
  const visited = new Set<PDFObject>();
  const pending: PDFObject[] = [...pages];

  while (pending.length > 0) {
    const object = pending.pop();
    if (object === undefined || visited.has(object)) {
      continue;
    }
    visited.add(object);

    if (object instanceof PDFRef) {
      const target = context.lookup(object);
      if (target) {
        pending.push(target);
      }
      continue;
    }
    if (object instanceof PDFArray) {
      for (const entry of object.asArray()) {
        pending.push(entry);
      }
      continue;
    }

    const dict = object instanceof PDFStream ? object.dict : object;
    if (
      !(dict instanceof PDFDict) ||
      (!own.has(dict) && isPageTreeNode(dict))
    ) {
      // A link's `/Dest` names another page, which this page does not own.
      continue;
    }
    owned.add(dict);
    for (const key of STRUCTURE_PARENT_KEYS) {
      const value = context.lookup(dict.get(key));
      if (value instanceof PDFNumber) {
        const number = value.asNumber();
        const held = holders.get(number) ?? new Set<PDFDict>();
        held.add(dict);
        holders.set(number, held);
      }
    }
    for (const [key, value] of dict.entries()) {
      if (!OWNER_BACK_POINTER_KEYS.has(key)) {
        pending.push(value);
      }
    }
  }
  return { holders, owned };
}

function elementsAt(
  context: PDFContext,
  entries: ReadonlyMap<number, PDFObject>,
  keys: ReadonlySet<number>,
) {
  const elements = new Set<PDFDict>();
  for (const key of keys) {
    const value = context.lookup(entries.get(key));
    const list = value instanceof PDFArray ? value.asArray() : [value];
    for (const entry of list) {
      const element = context.lookup(entry);
      if (element instanceof PDFDict) {
        elements.add(element);
      }
    }
  }
  return elements;
}

// A node carries `/Nums`, key and value alternating, or `/Kids`, never both.
function collectNumberTree(
  context: PDFContext,
  node: PDFDict,
  into: Map<number, PDFObject>,
  walk: { nodes: number },
  depth: number,
) {
  walk.nodes += 1;
  if (depth > MAX_STRUCTURE_TREE_DEPTH || walk.nodes > MAX_TREE_NODES) {
    return;
  }

  const nums = resolvedArrayEntry(node, PDFName.of("Nums"));
  for (let index = 0; index + 1 < (nums?.size() ?? 0); index += 2) {
    const key = context.lookup(nums?.get(index));
    const value = nums?.get(index + 1);
    if (key instanceof PDFNumber && value !== undefined) {
      into.set(key.asNumber(), value);
    }
  }

  const kids = resolvedArrayEntry(node, PDFName.of("Kids"));
  for (let index = 0; index < (kids?.size() ?? 0); index += 1) {
    const kid = kids ? resolvedDictAt(kids, index) : undefined;
    if (kid) {
      collectNumberTree(context, kid, into, walk, depth + 1);
    }
  }
}

// From the page tree, not pdf-lib's page cache, which `removePage` leaves stale.
function pageNodesOf(pdfDoc: PDFDocument) {
  const pages: PDFDict[] = [];
  const visited = new Set<PDFDict>();
  const pending = [resolvedDictEntry(pdfDoc.catalog, PDFName.of("Pages"))];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || visited.has(node) || visited.size >= MAX_TREE_NODES) {
      continue;
    }
    visited.add(node);
    const kids = resolvedArrayEntry(node, PDFName.of("Kids"));
    if (!kids) {
      pages.push(node);
      continue;
    }
    for (let index = 0; index < kids.size(); index += 1) {
      const kid = resolvedDictAt(kids, index);
      if (kid) {
        pending.push(kid);
      }
    }
  }
  return pages;
}

function referencedElements(context: PDFContext, element: PDFDict) {
  const value = context.lookup(element.get(PDFName.of("Ref")));
  const elements: PDFDict[] = [];
  if (!(value instanceof PDFArray)) {
    return elements;
  }
  for (const entry of value.asArray()) {
    const target = context.lookup(entry);
    if (target instanceof PDFDict) {
      elements.push(target);
    }
  }
  return elements;
}

// `/C` allows one name, or an array of names with revision numbers among them.
function classNames(context: PDFContext, element: PDFDict) {
  const value = context.lookup(element.get(PDFName.of("C")));
  const entries = value instanceof PDFArray ? value.asArray() : [value];
  const names: PDFName[] = [];
  for (const entry of entries) {
    const name = context.lookup(entry);
    if (name instanceof PDFName) {
      names.push(name);
    }
  }
  return names;
}

// Only when the walk reached every element the tree names: taking a class still
// in use loses a kept element its attributes.
function removeUnusedClasses(root: PDFDict, walk: StructureWalk) {
  const classMap = resolvedDictEntry(root, PDFName.of("ClassMap"));
  if (!classMap || !reachedEveryElement(walk)) {
    return;
  }
  for (const [key, value] of classMap.entries()) {
    if (walk.usedClasses.has(key)) {
      continue;
    }
    walk.removed.push(value);
    classMap.delete(key);
  }
  if (classMap.keys().length > 0) {
    return;
  }
  const classMapRef = root.get(PDFName.of("ClassMap"));
  if (classMapRef !== undefined) {
    walk.removed.push(classMapRef);
  }
  root.delete(PDFName.of("ClassMap"));
}

function reachedEveryElement(walk: StructureWalk) {
  if (!walk.reachedEverything) {
    return false;
  }
  for (const element of walk.named) {
    if (!walk.visited.has(element)) {
      return false;
    }
  }
  return true;
}

// `/S` is the exception the complement rule cannot cover: an element must have
// a structure type, so it becomes `/NonStruct` and `/NS` goes with it.
function clearDescription(
  context: PDFContext,
  element: PDFDict,
  walk: StructureWalk,
) {
  // An `/ID` may be an object of its own, and a reference is not text.
  const identifier = textOf(context.lookup(element.get(PDFName.of("ID"))));
  if (identifier !== undefined) {
    walk.identifiers.add(identifier);
  }
  for (const [key, value] of element.entries()) {
    if (STRUCTURE_NODE_KEYS.has(key)) {
      continue;
    }
    walk.removed.push(value);
    element.delete(key);
  }
  element.set(PDFName.of("S"), PDFName.of("NonStruct"));
}

// The `/IDTree` is keyed by the identifier and every node's `/Limits` copies
// keys below it, so the pairs go and each `/Limits` is rewritten bottom up.
function removeStructureIdentifiers(
  context: PDFContext,
  root: PDFDict,
  identifiers: ReadonlySet<string>,
  removed: PDFObject[],
) {
  const idTreeRef = root.get(PDFName.of("IDTree"));
  const idTree = resolvedDictEntry(root, PDFName.of("IDTree"));
  if (!idTree || identifiers.size === 0) {
    return;
  }
  const walk = { nodes: 0, removed };
  if (!pruneNameTree(context, idTree, identifiers, walk, 0)) {
    if (idTreeRef !== undefined) {
      removed.push(idTreeRef);
    }
    root.delete(PDFName.of("IDTree"));
    return;
  }
  // The root node is the one node a name tree does not limit.
  replaceLimits(idTree, undefined, walk);
}

// The array a rewritten `/Limits` replaces must not be left orphaned.
function replaceLimits(
  node: PDFDict,
  limits: PDFObject | undefined,
  walk: { removed: PDFObject[] },
) {
  const previous = node.get(PDFName.of("Limits"));
  if (previous !== undefined) {
    walk.removed.push(previous);
  }
  if (limits) {
    node.set(PDFName.of("Limits"), limits);
  } else {
    node.delete(PDFName.of("Limits"));
  }
}

function pruneNameTree(
  context: PDFContext,
  node: PDFDict,
  identifiers: ReadonlySet<string>,
  walk: { nodes: number; removed: PDFObject[] },
  depth: number,
): [PDFObject, PDFObject] | undefined {
  walk.nodes += 1;
  if (depth > MAX_STRUCTURE_TREE_DEPTH || walk.nodes > MAX_TREE_NODES) {
    // A node this walk cannot finish reading keeps everything below it.
    return keyBounds(resolvedArrayEntry(node, PDFName.of("Limits")), 1);
  }

  const names = resolvedArrayEntry(node, PDFName.of("Names"));
  for (let index = (names?.size() ?? 0) - 2; index >= 0; index -= 2) {
    const entry = names?.get(index);
    const key = textOf(context.lookup(entry));
    if (key !== undefined && identifiers.has(key)) {
      // A key written as its own object would otherwise be left orphaned.
      if (entry !== undefined) {
        walk.removed.push(entry);
      }
      names?.remove(index + 1);
      names?.remove(index);
    }
  }

  const kids = resolvedArrayEntry(node, PDFName.of("Kids"));
  for (let index = (kids?.size() ?? 0) - 1; index >= 0; index -= 1) {
    const kid = kids ? resolvedDictAt(kids, index) : undefined;
    if (kid && pruneNameTree(context, kid, identifiers, walk, depth + 1)) {
      continue;
    }
    const kidRef = kids?.get(index);
    if (kidRef !== undefined) {
      walk.removed.push(kidRef);
    }
    kids?.remove(index);
  }

  // A node holds names or kids, never both, so whichever it has answers.
  const bounds = keyBounds(names, 2) ?? boundsOfKids(kids);
  replaceLimits(
    node,
    bounds ? context.obj([bounds[0], bounds[1]]) : undefined,
    walk,
  );
  return bounds;
}

function keyBounds(
  entries: PDFArray | undefined,
  stride: number,
): [PDFObject, PDFObject] | undefined {
  const size = entries?.size() ?? 0;
  const least = size >= stride ? entries?.get(0) : undefined;
  const greatest = size >= stride ? entries?.get(size - stride) : undefined;
  return least !== undefined && greatest !== undefined
    ? [least, greatest]
    : undefined;
}

function boundsOfKids(kids: PDFArray | undefined) {
  const first = kids ? resolvedDictAt(kids, 0) : undefined;
  const last = kids ? resolvedDictAt(kids, kids.size() - 1) : undefined;
  const least = first
    ? keyBounds(resolvedArrayEntry(first, PDFName.of("Limits")), 1)?.[0]
    : undefined;
  const greatest = last
    ? keyBounds(resolvedArrayEntry(last, PDFName.of("Limits")), 1)?.[1]
    : undefined;
  return least !== undefined && greatest !== undefined
    ? ([least, greatest] as [PDFObject, PDFObject])
    : undefined;
}

function textOf(object: PDFObject | undefined) {
  return object instanceof PDFString || object instanceof PDFHexString
    ? object.decodeText()
    : undefined;
}

// `/K` allows one child or an array, each a reference or an inline dictionary.
function structureChildren(context: PDFContext, element: PDFDict) {
  const kids = context.lookup(element.get(PDFName.of("K")));
  const entries = kids instanceof PDFArray ? kids.asArray() : [kids];
  const children: PDFDict[] = [];
  for (const entry of entries) {
    const child = asDict(context.lookup(entry));
    if (child) {
      children.push(child);
    }
  }
  return children;
}

function refsLeavingWith(
  pdfDoc: PDFDocument,
  startIndex: number,
  count: number,
) {
  const staying = new Set<PDFRef>();
  const pages = new Set<PDFRef>();
  const annotations = new Set<PDFRef>();
  for (let index = 0; index < pdfDoc.getPageCount(); index += 1) {
    const page = pdfDoc.getPage(index);
    // By slot, not by reference: a page listed twice is leaving one of them.
    if (index >= startIndex && index < startIndex + count) {
      pages.add(page.ref);
      for (const ref of annotationRefs(page)) {
        annotations.add(ref);
      }
      continue;
    }

    staying.add(page.ref);
    for (const ref of annotationRefs(page)) {
      staying.add(ref);
    }
  }

  const going = (refs: Set<PDFRef>) =>
    new Set([...refs].filter((ref) => !staying.has(ref)));
  return { annotations: going(annotations), pages: going(pages) };
}

// A field's value hangs off the field, not the widget, so taking only the
// widget leaves the reader's typed text in the AcroForm.
function fieldsWithNoWidgetLeft(
  context: PDFContext,
  droppedAnnotations: ReadonlySet<PDFRef>,
) {
  const holderless = new Set<PDFRef>();
  const dead = (ref: PDFRef) =>
    droppedAnnotations.has(ref) || holderless.has(ref);

  for (const annotation of droppedAnnotations) {
    let parentRef = parentFieldRef(context, annotation);
    for (let depth = 0; parentRef && depth < MAX_FIELD_TREE_DEPTH; depth += 1) {
      if (holderless.has(parentRef)) {
        break;
      }
      const parent = asDict(context.lookup(parentRef));
      if (!parent || isPageTreeNode(parent)) {
        // A `/Parent` pointing into the page tree does not name a field.
        break;
      }
      const kids = resolvedArrayEntry(parent, PDFName.of("Kids"));
      const entries = kids ? kids.asArray() : [];
      if (
        entries.length === 0 ||
        !entries.every((entry) => entry instanceof PDFRef && dead(entry))
      ) {
        break;
      }
      holderless.add(parentRef);
      parentRef = parentFieldRef(context, parentRef);
    }
  }
  return holderless;
}

function parentFieldRef(context: PDFContext, ref: PDFRef) {
  const parent = asDict(context.lookup(ref))?.get(PDFName.of("Parent"));
  return parent instanceof PDFRef ? parent : undefined;
}

function asDict(object: PDFObject | undefined) {
  if (object instanceof PDFStream) {
    return object.dict;
  }
  return object instanceof PDFDict ? object : undefined;
}

function annotationRefs(page: PDFPage) {
  const annots = pageNodeAnnots(page);
  const refs: PDFRef[] = [];
  for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
    const entry = annots?.get(index);
    if (entry instanceof PDFRef) {
      refs.push(entry);
    }
  }
  return refs;
}

// The trailer's `/Info` is included: nothing in the catalog points at it.
function documentRoots(pdfDoc: PDFDocument): PDFObject[] {
  const { Encrypt, ID, Info, Root } = pdfDoc.context.trailerInfo;
  return [pdfDoc.catalog, Encrypt, ID, Info, Root].filter(
    (object): object is PDFObject => object !== undefined,
  );
}

// Back-pointers: following them walks out of the page into the rest of the file.
const OWNER_BACK_POINTER_KEYS: ReadonlySet<PDFName> = new Set([
  PDFName.of("Parent"),
  PDFName.of("P"),
]);

function referencesFrom(
  context: PDFContext,
  roots: PDFObject[],
  options: {
    barrier?: ReadonlySet<PDFRef>;
    ignoredKeys?: ReadonlySet<PDFName>;
  } = {},
) {
  const reached = new Set<PDFRef>();
  const visited = new Set<PDFObject>();
  const pending = [...roots];

  while (pending.length > 0) {
    const object = pending.pop();
    if (!object) {
      continue;
    }

    if (object instanceof PDFRef) {
      if (reached.has(object) || options.barrier?.has(object)) {
        continue;
      }
      reached.add(object);
      const target = context.lookup(object);
      if (target) {
        pending.push(target);
      }
      continue;
    }

    if (visited.has(object)) {
      continue;
    }
    visited.add(object);

    if (object instanceof PDFStream) {
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        if (!options.ignoredKeys?.has(key)) {
          pending.push(value);
        }
      }
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) {
        pending.push(value);
      }
    }
  }

  return reached;
}

// Keyed by the object in the copy and valued by the one in the source, so two
// copies compose.
type CopiedAnnotationNames = ReadonlyMap<string, string>;

const NO_COPIED_NAMES: CopiedAnnotationNames = new Map();

async function copyPagesInto(
  target: PDFDocument,
  source: PDFDocument,
  pageIndexes: number[],
  place: (pages: PDFPage[]) => void,
) {
  // Every object number from here up is one this copy created.
  const firstCopiedObjectNumber = target.context.largestObjectNumber + 1;
  const pages = await target.copyPages(source, pageIndexes);
  const copiedNames = new Map<string, string>();

  pageIndexes.forEach((sourcePageIndex, position) => {
    const sourceAnnots = pageAnnots(source, sourcePageIndex);
    const copiedPage = pages[position];
    const copiedAnnots = copiedPage ? pageNodeAnnots(copiedPage) : undefined;
    if (!sourceAnnots || !copiedAnnots) {
      return;
    }

    const size = Math.min(sourceAnnots.size(), copiedAnnots.size());
    for (let index = 0; index < size; index += 1) {
      try {
        const sourceEntry = sourceAnnots.get(index);
        const copiedEntry = copiedAnnots.get(index);
        if (
          !(sourceEntry instanceof PDFRef) ||
          !(copiedEntry instanceof PDFRef) ||
          !annotationsLookAlike(
            resolvedDictAt(sourceAnnots, index),
            resolvedDictAt(copiedAnnots, index),
          )
        ) {
          continue;
        }

        copiedNames.set(copiedEntry.toString(), sourceEntry.toString());
      } catch {
        // One unconfirmable entry must not stop the rest of the page pairing.
      }
    }
  });

  restatePageOfCopiedAnnotations(pages);
  place(pages);
  deleteObjectsTheCopyLeftBehind(target, firstCopiedObjectNumber, pages);
  return { copiedNames, pages };
}

// pdf-lib's copier follows `/P` and `/Dest` back out of the page and copies
// those pages too, so `/P` is restated and anything this copy created that the
// finished document does not reach is deleted.
function restatePageOfCopiedAnnotations(pages: PDFPage[]) {
  for (const page of pages) {
    const annots = pageNodeAnnots(page);
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const annotation = annots ? resolvedDictAt(annots, index) : undefined;
      annotation?.set(PDFName.of("P"), page.ref);
    }
  }
}

function deleteObjectsTheCopyLeftBehind(
  target: PDFDocument,
  firstCopiedObjectNumber: number,
  pages: PDFPage[],
) {
  const { context } = target;
  const copiedPageRefs = new Set(pages.map((page) => page.ref));
  const copied = context
    .enumerateIndirectObjects()
    .filter(([ref]) => ref.objectNumber >= firstCopiedObjectNumber);

  deleteObjects(
    target,
    copied
      .filter(
        ([ref, object]) => !copiedPageRefs.has(ref) && isPageDictionary(object),
      )
      .map(([ref]) => ref),
  );

  const reached = referencesFrom(context, documentRoots(target));
  deleteObjects(
    target,
    copied.map(([ref]) => ref).filter((ref) => !reached.has(ref)),
  );
}

function isPageTreeNode(dict: PDFDict) {
  const type = dict.get(PDFName.of("Type"));
  return type === PDFName.of("Page") || type === PDFName.of("Pages");
}

function isPageDictionary(object: PDFObject) {
  if (object instanceof PDFPageLeaf) {
    return true;
  }
  return (
    object instanceof PDFDict &&
    object.get(PDFName.of("Type")) === PDFName.of("Page")
  );
}

function pageAnnots(pdfDoc: PDFDocument, pageIndex: number) {
  return pageNodeAnnots(pdfDoc.getPage(pageIndex));
}

function pageNodeAnnots(page: PDFPage) {
  try {
    return page.node.Annots();
  } catch {
    // A present-but-wrong-typed /Annots: nothing on this page can be paired.
    return undefined;
  }
}

function annotationsLookAlike(left?: PDFDict, right?: PDFDict) {
  if (!left || !right) {
    return false;
  }

  const leftSubtype = resolvedNameEntry(left, PDFName.of("Subtype"));
  const rightSubtype = resolvedNameEntry(right, PDFName.of("Subtype"));
  if (!leftSubtype || leftSubtype.asString() !== rightSubtype?.asString()) {
    return false;
  }

  const leftRect = annotationRectValues(left);
  const rightRect = annotationRectValues(right);
  return (
    leftRect !== null &&
    rightRect !== null &&
    leftRect.every((value, index) => value === rightRect[index])
  );
}

function annotationRectValues(annotation: PDFDict) {
  const rect = resolvedArrayEntry(annotation, PDFName.of("Rect"));
  if (!rect || rect.size() < 4) {
    return null;
  }

  const values: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const value = rect.lookupMaybe(index, PDFNumber)?.asNumber();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    values.push(value);
  }
  return values;
}

function composedRenames(
  insertedNames: CopiedAnnotationNames,
  copiedNames: CopiedAnnotationNames,
): PdfAnnotationRenames {
  const renames = new Map<string, string>();
  for (const [insertedRef, extractedRef] of insertedNames) {
    const sourceRef = copiedNames.get(extractedRef);
    const sourceKey = sourceRef ? canonicalPdfReferenceKey(sourceRef) : null;
    if (sourceKey) {
      renames.set(sourceKey, insertedRef);
    }
  }
  return renames;
}

export async function insertPagesFromBytes(
  bytes: Uint8Array,
  atIndex: number,
  pagesBytes: Uint8Array,
  copiedNames: CopiedAnnotationNames = NO_COPIED_NAMES,
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourceDoc = await loadEditablePdf(pagesBytes);
  const pageIndexes = sourceDoc.getPageIndices();
  const { copiedNames: insertedNames } = await copyPagesInto(
    pdfDoc,
    sourceDoc,
    pageIndexes,
    (pages) =>
      pages.forEach((page, index) => {
        pdfDoc.insertPage(atIndex + index, page);
      }),
  );
  return {
    bytes: await saveEditedPdf(pdfDoc),
    descriptionsUnproven: false,
    renames: composedRenames(insertedNames, copiedNames),
  };
}

export async function extractPagesBytes(
  bytes: Uint8Array,
  startIndex: number,
  count: number,
) {
  const sourceDoc = await loadEditablePdf(bytes);
  const pageIndexes = Array.from(
    { length: count },
    (_, index) => startIndex + index,
  );
  const extractedDoc = await PDFDocument.create();
  const { copiedNames, pages } = await copyPagesInto(
    extractedDoc,
    sourceDoc,
    pageIndexes,
    (copiedPages) => copiedPages.forEach((page) => extractedDoc.addPage(page)),
  );
  return {
    bytes: await saveEditedPdf(extractedDoc),
    // The caller must carry this to the insert, or the pages come back under
    // names nothing holds.
    copiedNames,
    pageCount: pages.length,
  };
}

export type PdfStructuralOperation =
  | { type: "rotatePage"; pageIndex: number; deltaDegrees: number }
  | {
      type: "insertPages";
      atIndex: number;
      pageCount: number;
      pagesBytes: Uint8Array;
      // Required, not optional: an insert cannot relink, so a caller with no
      // answer says so with an empty map.
      copiedNames: CopiedAnnotationNames;
    }
  | { type: "removePages"; startIndex: number; count: number }
  | { type: "movePage"; pageIndex: number; direction: 1 | -1 };

type StructuralOperationResult = {
  bytes: Uint8Array;
  renames: PdfAnnotationRenames;
  // Always false for an operation that removes nothing; see `PageRemoval`.
  descriptionsUnproven: boolean;
};

export async function applyStructuralOperation(
  bytes: Uint8Array,
  operation: PdfStructuralOperation,
): Promise<StructuralOperationResult> {
  switch (operation.type) {
    // None of the three copies a page, so no annotation object is renamed.
    case "rotatePage":
      return relinked(
        await rotatePageByDelta(
          bytes,
          operation.pageIndex,
          operation.deltaDegrees,
        ),
      );
    case "insertPages":
      return insertPagesFromBytes(
        bytes,
        operation.atIndex,
        operation.pagesBytes,
        operation.copiedNames,
      );
    case "removePages": {
      const removed = await removePagesRange(
        bytes,
        operation.startIndex,
        operation.count,
      );
      return { ...relinked(removed.bytes), ...removed };
    }
    case "movePage":
      return relinked(
        await movePageBy(bytes, operation.pageIndex, operation.direction),
      );
  }
}

function relinked(bytes: Uint8Array): StructuralOperationResult {
  return { bytes, descriptionsUnproven: false, renames: NO_ANNOTATION_RENAMES };
}

// removePages -> insertPages is the only inversion that copies, and so the only
// one that renames: the pages are read out now, while their objects have names.
export async function invertStructuralOperation(
  operation: PdfStructuralOperation,
  currentBytes: Uint8Array,
): Promise<PdfStructuralOperation> {
  switch (operation.type) {
    case "rotatePage":
      return {
        type: "rotatePage",
        pageIndex: operation.pageIndex,
        deltaDegrees: -operation.deltaDegrees,
      };
    case "insertPages":
      return {
        type: "removePages",
        startIndex: operation.atIndex,
        count: operation.pageCount,
      };
    case "removePages": {
      const extracted = await extractPagesBytes(
        currentBytes,
        operation.startIndex,
        operation.count,
      );
      return {
        type: "insertPages",
        atIndex: operation.startIndex,
        copiedNames: extracted.copiedNames,
        pageCount: extracted.pageCount,
        pagesBytes: extracted.bytes,
      };
    }
    case "movePage":
      // A swap with a neighbor undoes itself: swap the page back from its
      // new slot (pageIndex + direction) in the opposite direction.
      return {
        type: "movePage",
        pageIndex: operation.pageIndex + operation.direction,
        direction: -operation.direction as 1 | -1,
      };
  }
}

function drawLinedPage(page: PDFPage, width: number, height: number) {
  const marginX = Math.min(36, width * 0.075);
  const top = height - Math.min(60, height * 0.08);
  const bottom = Math.max(
    0,
    Math.min(60, height * 0.08) - linedPageLineSpacing,
  );
  const guideX = marginX + Math.min(24, width * 0.04);

  page.drawLine({
    start: { x: guideX, y: 0 },
    end: { x: guideX, y: height },
    color: linedPageMarginColor,
    opacity: 0.34,
    thickness: 0.6,
  });

  const lineYs: number[] = [];
  for (let y = bottom; y <= top; y += linedPageLineSpacing) {
    lineYs.push(y);
  }
  for (const y of lineYs.reverse()) {
    page.drawLine({
      start: { x: 0, y },
      end: { x: width, y },
      color: linedPageLineColor,
      opacity: 0.58,
      thickness: 0.6,
    });
  }
}
