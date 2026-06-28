import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

export const fixtureUrl = new URL('./fixtures/', import.meta.url);

export async function readFixture(name: string) {
  return new Uint8Array(await readFile(new URL(name, fixtureUrl)));
}

export function loadTestPdf(bytes: Uint8Array) {
  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false
  });
}

export async function annotationSummary(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  const bySubtype: Record<string, number> = {};
  let total = 0;

  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) {
      continue;
    }

    for (let index = 0; index < annots.size(); index += 1) {
      const subtype = annotationSubtype(annots.lookupMaybe(index, PDFDict));
      bySubtype[subtype] = (bySubtype[subtype] ?? 0) + 1;
      total += 1;
    }
  }

  return {
    bySubtype: sortRecord(bySubtype),
    total
  };
}

export async function annotationSubtypeCountsByPage(bytes: Uint8Array) {
  const pdfDoc = await loadTestPdf(bytes);
  return pdfDoc.getPages().map((page) => {
    const bySubtype: Record<string, number> = {};
    const annots = page.node.Annots();
    if (!annots) {
      return bySubtype;
    }

    for (let index = 0; index < annots.size(); index += 1) {
      const subtype = annotationSubtype(annots.lookupMaybe(index, PDFDict));
      bySubtype[subtype] = (bySubtype[subtype] ?? 0) + 1;
    }

    return bySubtype;
  });
}

function annotationSubtype(annotation: PDFDict | undefined) {
  return (
    annotation
      ?.lookupMaybe(PDFName.of('Subtype'), PDFName)
      ?.decodeText() ?? 'Unknown'
  );
}

function sortRecord(record: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}
