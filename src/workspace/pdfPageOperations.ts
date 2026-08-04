import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  ParseSpeeds,
  decodePDFRawStream,
  degrees,
  rgb
} from 'pdf-lib';
import type { PDFContext } from 'pdf-lib';
import { bytesContainPdfMarker } from './pdfProtection';

const pdfaOutputIntentSubtypePrefix = '/GTS_PDFA';
// The XMP properties that carry a PDF/A identification. Deliberately the same
// strings pdfProtection.ts's pdfLooksPdfA scans for: if one survives a save,
// reopening our own output flags it read-only as "PDF/A compliant" again.
const pdfaXmpMarkers = ['pdfaid:part', 'pdfaid:conformance'];
// AcroForm field trees are shallow in practice; this only exists so a
// malformed file with a cyclic /Kids can't spin the walk forever.
const MAX_FIELD_TREE_DEPTH = 32;

const linedPageLineColor = rgb(0.58, 0.66, 0.7);
const linedPageMarginColor = rgb(0.68, 0.72, 0.74);
const millimetresPerInch = 25.4;
const pdfPointsPerInch = 72;
const linedPageLineSpacing = (8 / millimetresPerInch) * pdfPointsPerInch;
const pdfLoadOptions = {
  parseSpeed: ParseSpeeds.Fastest,
  updateMetadata: false
};
const pdfSaveOptions = {
  // pdf-lib yields to the event loop every objectsPerTick objects; Infinity
  // disables that entirely; serializing a large document then blocks the
  // main thread (and freezes the UI) for the whole save. A finite value
  // keeps the page responsive during saves on large/many-page documents.
  objectsPerTick: 500,
  updateFieldAppearances: false
};

export function loadEditablePdf(bytes: Uint8Array) {
  return PDFDocument.load(bytes, pdfLoadOptions);
}

export function saveEditedPdf(pdfDoc: PDFDocument) {
  stripPdfAConformanceClaims(pdfDoc);
  stripSignatureFields(pdfDoc);
  return pdfDoc.save(pdfSaveOptions);
}

// This app never attempts to actually maintain PDF/A conformance while
// editing (embedded fonts, colour spaces, transparency etc. aren't
// validated), so an edited document must not keep claiming it via the
// source's XMP metadata or GTS_PDFA output intent - see pdfProtection.ts's
// pdfLooksPdfA for the matching detection this undoes. Deleting a dict entry
// only removes the catalog's pointer to it - pdf-lib's save() serialises
// every indirect object it still knows about regardless of reachability, so
// the underlying stream/dict objects have to be deleted from the context
// too or their bytes (and the PDF/A markers inside them) linger in the
// output, just unreferenced. A no-op for the (common) case where none of
// this is present.
function stripPdfAConformanceClaims(pdfDoc: PDFDocument) {
  try {
    const { context } = pdfDoc;
    // XMP is legal on *any* object (the catalog, pages, embedded font
    // programs, form XObjects), and a claim left on one of those keeps
    // pdfLooksPdfA returning true for our own output. Catalog-only stripping
    // is why an edited copy could still reopen as read-only "PDF/A
    // compliant" - so this walks every metadata stream, catalog included.
    //
    // Deliberately targeted rather than "delete the catalog's /Metadata
    // unconditionally": that also threw away dc:title, dc:creator, rights
    // and dates on every save of an ordinary, non-PDF/A document. Only a
    // conformance claim is invalidated by re-serialising; the rest of the
    // document's XMP is the user's data and is preserved.
    stripPdfAMetadataStreams(context);

    // Same reasoning for the GTS_PDFA output intent: PDF 2.0 allows
    // OutputIntents on a page, not just the catalog.
    for (const dict of indirectDicts(context)) {
      stripPdfAOutputIntents(dict, context);
    }
  } catch {
    // Best-effort: a malformed catalog/OutputIntents structure shouldn't
    // block the save itself.
  }
}

function stripPdfAOutputIntents(dict: PDFDict, context: PDFContext) {
  const outputIntentsRef = dict.get(PDFName.of('OutputIntents'));
  const outputIntents = dict.lookupMaybe(PDFName.of('OutputIntents'), PDFArray);
  if (!outputIntents) {
    return;
  }

  for (let index = outputIntents.size() - 1; index >= 0; index -= 1) {
    const entryRef = outputIntents.get(index);
    const intent = outputIntents.lookupMaybe(index, PDFDict);
    const subtype = intent?.lookupMaybe(PDFName.of('S'), PDFName);
    if (!subtype?.asString().startsWith(pdfaOutputIntentSubtypePrefix)) {
      continue;
    }

    if (intent) {
      deleteCatalogRef(intent, context, PDFName.of('DestOutputProfile'));
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
    dict.delete(PDFName.of('OutputIntents'));
  }
}

// Drops every XMP packet that still identifies the document as PDF/A,
// wherever it hangs. Only metadata streams carrying a pdfaid marker are
// touched: unrelated XMP (an embedded font's licensing metadata, say) is
// left alone, since re-serialising doesn't invalidate it the way it
// invalidates a conformance claim. Deleting the object from the context as
// well as the pointer to it matters - pdf-lib's save() writes out every
// indirect object it knows about, reachable or not, so an orphaned stream's
// bytes (markers included) would otherwise still land in the output.
function stripPdfAMetadataStreams(context: PDFContext) {
  const claimingRefs = new Set<PDFRef>();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && metadataStreamClaimsPdfA(object)) {
      claimingRefs.add(ref);
    }
  }

  if (claimingRefs.size === 0) {
    return;
  }

  const metadataKey = PDFName.of('Metadata');
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

function metadataStreamClaimsPdfA(stream: PDFRawStream) {
  // Structural gate before touching the bytes: an XMP packet is always
  // /Type /Metadata (or at least /Subtype /XML). Without it this would scan
  // every content and image stream in the document on every save.
  const type = stream.dict.lookupMaybe(PDFName.of('Type'), PDFName)?.asString();
  const subtype = stream.dict
    .lookupMaybe(PDFName.of('Subtype'), PDFName)
    ?.asString();
  if (type !== '/Metadata' && subtype !== '/XML') {
    return false;
  }

  return (
    bytesClaimPdfA(stream.contents) ||
    bytesClaimPdfA(decodedStreamContents(stream))
  );
}

function bytesClaimPdfA(bytes: Uint8Array | null) {
  return (
    bytes !== null &&
    pdfaXmpMarkers.some((marker) =>
      bytesContainPdfMarker(bytes, marker, { caseInsensitive: true })
    )
  );
}

// PDF/A requires the metadata stream to be unfiltered, so the raw scan above
// covers conforming files; this only catches a file that claims PDF/A from a
// compressed packet (already non-conforming, but we still shouldn't pass the
// claim through).
function decodedStreamContents(stream: PDFRawStream) {
  if (!stream.dict.get(PDFName.of('Filter'))) {
    return null;
  }

  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return null;
  }
}

// Every dict pdf-lib will serialise, including stream dicts. Direct dicts
// nested inside these are reached through their owner (an OutputIntents
// array is read via lookupMaybe, which resolves direct entries too).
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

// A pdf-lib resave always breaks a signature's cryptographic validity (the
// file is fully re-serialised, so /ByteRange no longer matches reality) -
// any real verifier will already flag that. But the signature field's
// on-page appearance stream is just ordinary content to a renderer that
// doesn't verify signatures (this app included), so it would otherwise keep
// showing a "signed" stamp on an edited copy that isn't backed by anything
// valid. This drops the signature field (and its widget annotation) from
// wherever it's referenced, rather than only breaking the crypto side.
function stripSignatureFields(pdfDoc: PDFDocument) {
  try {
    const { catalog, context } = pdfDoc;

    // A certification (DocMDP) or usage-rights (UR3) signature hangs off the
    // catalog's /Perms, not off AcroForm at all, so pruning fields alone
    // leaves it behind entirely.
    stripSignaturePermissions(catalog, context);

    const acroFormRef = catalog.get(PDFName.of('AcroForm'));
    const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (!acroForm || !fields) {
      return;
    }

    const removedFieldRefs = new Set<PDFRef>();
    pruneSignatureFields(fields, context, removedFieldRefs);

    if (removedFieldRefs.size === 0) {
      return;
    }

    removePageAnnotationRefs(pdfDoc, removedFieldRefs);

    if (fields.size() === 0) {
      if (acroFormRef instanceof PDFRef) {
        context.delete(acroFormRef);
      }
      catalog.delete(PDFName.of('AcroForm'));
    } else {
      acroForm.delete(PDFName.of('SigFlags'));
    }
  } catch {
    // Best-effort: a malformed AcroForm/annotation structure shouldn't block
    // the save itself.
  }
}

// /Fields is a *tree*, not a flat list: a signature field is routinely a
// child of a non-terminal parent field, and its on-page widget can in turn be
// a separate kid of the signature field. Walking only the top level left the
// whole subtree in place - signature dict, appearance stream and widget - so
// the edited copy still rendered a "signed" stamp backed by nothing. Recurses
// depth-first, removing emptied parents on the way back out.
function pruneSignatureFields(
  fields: PDFArray,
  context: PDFContext,
  removedFieldRefs: Set<PDFRef>,
  depth = 0
) {
  if (depth > MAX_FIELD_TREE_DEPTH) {
    return;
  }

  for (let index = fields.size() - 1; index >= 0; index -= 1) {
    const fieldRef = fields.get(index);
    const field = fields.lookupMaybe(index, PDFDict);
    if (!field) {
      continue;
    }

    if (isSignatureField(field)) {
      deleteCatalogRef(field, context, PDFName.of('AP'));
      deleteCatalogRef(field, context, PDFName.of('V'));
      removeWidgetKids(field, context, removedFieldRefs, depth);
      if (fieldRef instanceof PDFRef) {
        removedFieldRefs.add(fieldRef);
        context.delete(fieldRef);
      }
      fields.remove(index);
      continue;
    }

    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!kids) {
      continue;
    }

    pruneSignatureFields(kids, context, removedFieldRefs, depth + 1);
    // A non-terminal field whose only children were signatures is now an
    // empty shell; leaving it would keep a nameless dead node in the tree.
    if (kids.size() === 0) {
      deleteCatalogRef(field, context, PDFName.of('Kids'));
      if (fieldRef instanceof PDFRef) {
        removedFieldRefs.add(fieldRef);
        context.delete(fieldRef);
      }
      fields.remove(index);
    }
  }
}

// A signature field's widget annotation is merged into the field dict in the
// common case, but may be a separate kid - which is what the page's /Annots
// points at, so it has to be collected for removePageAnnotationRefs.
function removeWidgetKids(
  field: PDFDict,
  context: PDFContext,
  removedFieldRefs: Set<PDFRef>,
  depth: number
) {
  if (depth > MAX_FIELD_TREE_DEPTH) {
    return;
  }

  const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids) {
    return;
  }

  for (let index = kids.size() - 1; index >= 0; index -= 1) {
    const kidRef = kids.get(index);
    const kid = kids.lookupMaybe(index, PDFDict);
    if (kid) {
      deleteCatalogRef(kid, context, PDFName.of('AP'));
      removeWidgetKids(kid, context, removedFieldRefs, depth + 1);
    }
    if (kidRef instanceof PDFRef) {
      removedFieldRefs.add(kidRef);
      context.delete(kidRef);
    }
    kids.remove(index);
  }
}

function stripSignaturePermissions(catalog: PDFDict, context: PDFContext) {
  const permsRef = catalog.get(PDFName.of('Perms'));
  const perms = catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  if (!perms) {
    return;
  }

  deleteCatalogRef(perms, context, PDFName.of('DocMDP'));
  deleteCatalogRef(perms, context, PDFName.of('UR3'));

  if (perms.keys().length === 0) {
    if (permsRef instanceof PDFRef) {
      context.delete(permsRef);
    }
    catalog.delete(PDFName.of('Perms'));
  }
}

function isSignatureField(field: PDFDict) {
  const fieldType = field.lookupMaybe(PDFName.of('FT'), PDFName);
  if (fieldType?.asString() === '/Sig') {
    return true;
  }

  const value = field.lookupMaybe(PDFName.of('V'), PDFDict);
  const valueType = value?.lookupMaybe(PDFName.of('Type'), PDFName);
  return valueType?.asString() === '/Sig';
}

function removePageAnnotationRefs(pdfDoc: PDFDocument, refs: Set<PDFRef>) {
  for (let index = 0; index < pdfDoc.getPageCount(); index += 1) {
    const annots = pdfDoc.getPage(index).node.Annots();
    if (!annots) {
      continue;
    }

    for (let annotIndex = annots.size() - 1; annotIndex >= 0; annotIndex -= 1) {
      const annotRef = annots.get(annotIndex);
      if (annotRef instanceof PDFRef && refs.has(annotRef)) {
        annots.remove(annotIndex);
      }
    }
  }
}

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
  templatePageIndex: number
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
  templatePageIndex: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourcePage = pdfDoc.getPage(templatePageIndex);
  const { width, height } = sourcePage.getSize();
  const page = pdfDoc.insertPage(pageIndex, [width, height]);
  drawLinedPage(page, width, height);
  return saveEditedPdf(pdfDoc);
}

export async function removePage(bytes: Uint8Array, pageIndex: number) {
  const pdfDoc = await loadEditablePdf(bytes);
  if (pdfDoc.getPageCount() <= 1) {
    throw new Error('A PDF must keep at least one page.');
  }

  pdfDoc.removePage(pageIndex);
  return saveEditedPdf(pdfDoc);
}

export async function rotatePageClockwise(bytes: Uint8Array, pageIndex: number) {
  const pdfDoc = await loadEditablePdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const currentAngle = page.getRotation().angle;
  page.setRotation(degrees((currentAngle + 90) % 360));
  return saveEditedPdf(pdfDoc);
}

// Swaps pageIndex with its neighbor at pageIndex + direction (direction is
// +1 for "move down/after", -1 for "move up/before"). pdf-lib has no direct
// reorder primitive, so this copies the page (copyPages supports copying
// within the same document) to its new slot and removes the original -
// insert-before-remove, so the removal index needs to account for the
// shift the insertion just caused.
export async function movePageBy(
  bytes: Uint8Array,
  pageIndex: number,
  direction: 1 | -1
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
    throw new Error('This page cannot be moved further in that direction.');
  }

  const [copiedPage] = await pdfDoc.copyPages(pdfDoc, [pageIndex]);
  if (direction > 0) {
    pdfDoc.insertPage(pageIndex + 2, copiedPage);
    pdfDoc.removePage(pageIndex);
  } else {
    pdfDoc.insertPage(pageIndex - 1, copiedPage);
    pdfDoc.removePage(pageIndex + 1);
  }
  return saveEditedPdf(pdfDoc);
}

export async function mergePdfAfterPage(
  bytes: Uint8Array,
  mergeBytes: Uint8Array,
  afterPageIndex: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const mergeDoc = await loadEditablePdf(mergeBytes);
  const pageIndexes = mergeDoc.getPageIndices();
  const copiedPages = await pdfDoc.copyPages(mergeDoc, pageIndexes);
  const insertAt = Math.min(
    Math.max(afterPageIndex + 1, 0),
    pdfDoc.getPageCount()
  );

  copiedPages.forEach((page, index) => {
    pdfDoc.insertPage(insertAt + index, page);
  });

  return {
    bytes: await saveEditedPdf(pdfDoc),
    insertAt,
    insertedPageCount: copiedPages.length
  };
}

// The following are used to build small, edit-sized undo/redo history
// entries for structural page operations, instead of retaining a full copy
// of the document's bytes per undo step. They're additive - the functions
// above remain the actual forward-edit path and are untouched.

export async function rotatePageByDelta(
  bytes: Uint8Array,
  pageIndex: number,
  deltaDegrees: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const page = pdfDoc.getPage(pageIndex);
  const currentAngle = page.getRotation().angle;
  const nextAngle = ((currentAngle + deltaDegrees) % 360 + 360) % 360;
  page.setRotation(degrees(nextAngle));
  return saveEditedPdf(pdfDoc);
}

export async function removePagesRange(
  bytes: Uint8Array,
  startIndex: number,
  count: number
) {
  const pdfDoc = await loadEditablePdf(bytes);
  // Same floor as removePage. This is the undo/redo path rather than the
  // forward edit, so it should never be asked to empty a document - but a
  // zero-page PDF is unopenable, and failing the operation is recoverable in
  // a way that writing one out is not.
  if (pdfDoc.getPageCount() - count < 1) {
    throw new Error('A PDF must keep at least one page.');
  }

  for (let i = 0; i < count; i += 1) {
    pdfDoc.removePage(startIndex);
  }
  return saveEditedPdf(pdfDoc);
}

export async function insertPagesFromBytes(
  bytes: Uint8Array,
  atIndex: number,
  pagesBytes: Uint8Array
) {
  const pdfDoc = await loadEditablePdf(bytes);
  const sourceDoc = await loadEditablePdf(pagesBytes);
  const pageIndexes = sourceDoc.getPageIndices();
  const copiedPages = await pdfDoc.copyPages(sourceDoc, pageIndexes);
  copiedPages.forEach((page, index) => {
    pdfDoc.insertPage(atIndex + index, page);
  });
  return saveEditedPdf(pdfDoc);
}

export async function extractPagesBytes(
  bytes: Uint8Array,
  startIndex: number,
  count: number
) {
  const sourceDoc = await loadEditablePdf(bytes);
  const pageIndexes = Array.from({ length: count }, (_, index) => startIndex + index);
  const extractedDoc = await PDFDocument.create();
  const copiedPages = await extractedDoc.copyPages(sourceDoc, pageIndexes);
  copiedPages.forEach((page) => extractedDoc.addPage(page));
  return {
    bytes: await saveEditedPdf(extractedDoc),
    pageCount: copiedPages.length
  };
}

export type PdfStructuralOperation =
  | { type: 'rotatePage'; pageIndex: number; deltaDegrees: number }
  | {
      type: 'insertPages';
      atIndex: number;
      pageCount: number;
      pagesBytes: Uint8Array;
    }
  | { type: 'removePages'; startIndex: number; count: number }
  | { type: 'movePage'; pageIndex: number; direction: 1 | -1 };

export function applyStructuralOperation(
  bytes: Uint8Array,
  operation: PdfStructuralOperation
) {
  switch (operation.type) {
    case 'rotatePage':
      return rotatePageByDelta(bytes, operation.pageIndex, operation.deltaDegrees);
    case 'insertPages':
      return insertPagesFromBytes(bytes, operation.atIndex, operation.pagesBytes);
    case 'removePages':
      return removePagesRange(bytes, operation.startIndex, operation.count);
    case 'movePage':
      return movePageBy(bytes, operation.pageIndex, operation.direction);
  }
}

// Given the operation that reaches one history entry's state from the
// current bytes, produces the operation that reaches the OTHER direction
// (current bytes are needed only to extract page content for the
// removePages -> insertPages case; the other two directions are cheap and
// don't need to read the document at all).
export async function invertStructuralOperation(
  operation: PdfStructuralOperation,
  currentBytes: Uint8Array
): Promise<PdfStructuralOperation> {
  switch (operation.type) {
    case 'rotatePage':
      return {
        type: 'rotatePage',
        pageIndex: operation.pageIndex,
        deltaDegrees: -operation.deltaDegrees
      };
    case 'insertPages':
      return {
        type: 'removePages',
        startIndex: operation.atIndex,
        count: operation.pageCount
      };
    case 'removePages': {
      const extracted = await extractPagesBytes(
        currentBytes,
        operation.startIndex,
        operation.count
      );
      return {
        type: 'insertPages',
        atIndex: operation.startIndex,
        pageCount: extracted.pageCount,
        pagesBytes: extracted.bytes
      };
    }
    case 'movePage':
      // A swap with a neighbor undoes itself: swap the page back from its
      // new slot (pageIndex + direction) in the opposite direction.
      return {
        type: 'movePage',
        pageIndex: operation.pageIndex + operation.direction,
        direction: -operation.direction as 1 | -1
      };
  }
}

function drawLinedPage(page: PDFPage, width: number, height: number) {
  const marginX = Math.min(36, width * 0.075);
  const top = height - Math.min(60, height * 0.08);
  const bottom = Math.max(
    0,
    Math.min(60, height * 0.08) - linedPageLineSpacing
  );
  const guideX = marginX + Math.min(24, width * 0.04);

  page.drawLine({
    start: { x: guideX, y: 0 },
    end: { x: guideX, y: height },
    color: linedPageMarginColor,
    opacity: 0.34,
    thickness: 0.6
  });

  const lineYs: number[] = [];
  for (let y = bottom; y <= top; y += linedPageLineSpacing) {
    lineYs.push(y);
  }
  for (const y of lineYs.reverse()) {
    drawLinedPageRule(page, width, y);
  }
}

function drawLinedPageRule(page: PDFPage, width: number, y: number) {
  page.drawLine({
    start: { x: 0, y },
    end: { x: width, y },
    color: linedPageLineColor,
    opacity: 0.58,
    thickness: 0.6
  });
}
