import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString
} from 'pdf-lib';
import {
  detectReadOnlyReason,
  pdfLooksSignedOrCertified,
  pdfLooksEncrypted
} from '../src/workspace/pdfProtection';
import {
  UnsupportedAnnotationTextError,
  writePdfAnnotations
} from '../src/workspace/pdfWriter';
import {
  addBlankPageAt,
  mergePdfAfterPage,
  removePage,
  rotatePageClockwise
} from '../src/workspace/pdfPageOperations';
import type { PdfAnnotation } from '../src/workspace/types';
import {
  annotationContentsByName,
  annotationSubtypeCountsByPage,
  annotationSummary,
  loadTestPdf,
  readFixture
} from './pdfTestUtils';

test('protected fixture PDFs are detected before editing is enabled', async () => {
  const cases = [
    {
      file: 'test-password-12356.pdf',
      passwordProtected: true,
      reason: 'password protected'
    },
    {
      file: 'test-pdfa.pdf',
      passwordProtected: false,
      reason: 'PDF/A compliant'
    },
    {
      file: 'test-signed.pdf',
      passwordProtected: false,
      reason: 'signed/certified'
    }
  ] as const;

  for (const item of cases) {
    const bytes = await readFixture(item.file);
    const reason = await detectReadOnlyReason(
      bytes,
      null,
      item.passwordProtected
    );
    assert.equal(reason, item.reason, item.file);
  }
});

test('pdf-lib encryption detection identifies only the password fixture', async () => {
  const encrypted = await withoutConsoleWarnings(() =>
    readFixture('test-password-12356.pdf').then(pdfLooksEncrypted)
  );
  const unencrypted = await Promise.all(
    ['test-annotated.pdf', 'test-pdfa.pdf', 'test-signed.pdf'].map(
      async (name) => pdfLooksEncrypted(await readFixture(name))
    )
  );

  assert.equal(encrypted, true);
  assert.deepEqual(unencrypted, [false, false, false]);
});

test('signature markers are detected across the full capped byte range', () => {
  const bytes = new Uint8Array(10 * 1024 * 1024);
  const marker = new TextEncoder().encode('/ByteRange');
  bytes.set(marker, 5 * 1024 * 1024);

  assert.equal(pdfLooksSignedOrCertified(bytes), true);
});

test('annotation writer preserves third-party annotations on a no-edit round trip', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const before = await annotationSummary(bytes);
  assert.ok(before.total > 0, 'fixture should contain annotations');

  const output = await writePdfAnnotations(bytes, []);
  const after = await annotationSummary(output);

  assert.deepEqual(after.bySubtype, before.bySubtype);
  assert.equal(after.total, before.total);
});

test('adding an app note does not remove existing third-party annotations', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const before = await annotationSummary(bytes);
  const note: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: 'test-added-note',
    kind: 'stickyNote',
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: 'test note'
  };

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0]
  });
  const after = await annotationSummary(output);

  assert.equal(after.total, before.total + 1);
  assert.equal((after.bySubtype.Text ?? 0), (before.bySubtype.Text ?? 0) + 1);
  assertExistingSubtypeCountsPreserved(before.bySubtype, after.bySubtype, [
    'Text'
  ]);
});

test('repeated annotation writes replace app annotations instead of duplicating them', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const before = await annotationSummary(bytes);
  const firstNote: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: 'test-repeat-note-1',
    kind: 'stickyNote',
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: 'first saved note'
  };
  const secondNote: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: 'test-repeat-note-2',
    kind: 'stickyNote',
    pageIndex: 0,
    rect: { x1: 96, x2: 116, y1: 72, y2: 92 },
    text: 'second saved note'
  };

  const firstOutput = await writePdfAnnotations(bytes, [firstNote], {
    replaceAnnotationSourceIds: [firstNote.id],
    replacePageIndexes: [0]
  });
  const secondOutput = await writePdfAnnotations(
    firstOutput,
    [firstNote, secondNote],
    {
      replaceAnnotationSourceIds: [firstNote.id, secondNote.id],
      replacePageIndexes: [0]
    }
  );
  const after = await annotationSummary(secondOutput);

  assert.equal(after.total, before.total + 2);
  assert.equal(
    await annotationContentsByName(secondOutput, firstNote.id),
    firstNote.text
  );
  assert.equal(
    await annotationContentsByName(secondOutput, secondNote.id),
    secondNote.text
  );
});

test('text annotations refuse unsupported characters before writing output', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const text: PdfAnnotation = {
    color: [0.263, 0.58, 0.827],
    fontSize: 12,
    id: 'test-unicode-text',
    kind: 'freeText',
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 220, y1: 720, y2: 750 },
    text: 'Unsupported snowman \u2603\ufe0e'
  };

  await assert.rejects(
    async () =>
      writePdfAnnotations(bytes, [text], {
        replaceAnnotationSourceIds: [text.id],
        replacePageIndexes: [0]
      }),
    (error) =>
      error instanceof UnsupportedAnnotationTextError &&
      error.annotationId === text.id &&
      error.pageIndex === 0 &&
      error.characters.length === 1 &&
      error.characters.includes('\u2603\ufe0e') &&
      error.message.includes('unsupported character')
  );
});

test('text annotations preserve WinAnsi punctuation and accents', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const text: PdfAnnotation = {
    color: [0.263, 0.58, 0.827],
    fontSize: 12,
    id: 'test-winansi-text',
    kind: 'freeText',
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 280, y1: 720, y2: 750 },
    text: 'Caf\u00e9 \u201cM\u00fcller\u201d \u2014 \u20ac'
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [text.id],
    replacePageIndexes: [0]
  });

  assert.equal(await annotationContentsByName(output, text.id), text.text);
});

test('text annotations normalize decomposed western accents before saving', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const text: PdfAnnotation = {
    color: [0.263, 0.58, 0.827],
    fontSize: 12,
    id: 'test-decomposed-text',
    kind: 'freeText',
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 280, y1: 720, y2: 750 },
    text: 'Cafe\u0301'
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [text.id],
    replacePageIndexes: [0]
  });

  assert.equal(await annotationContentsByName(output, text.id), 'Caf\u00e9');
});

test('rotated freeText content is laid out against the local (un-rotated) width, not the on-page footprint', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  // The intended LOCAL (un-rotated) box is wide and short: 300x50, centered
  // at (250, 525). `annotation.rect` always stores the on-page footprint, so
  // for a 90-degree rotation that's the same box with width/height swapped
  // around the same center: 50 wide, 300 tall. If the writer mistakenly
  // measured layout against this on-page footprint instead of the local box,
  // the requested 280pt-wide layout would get clamped down to ~50pt.
  const text: PdfAnnotation = {
    color: [0, 0, 0],
    fontSize: 12,
    id: 'test-rotated-freetext-layout',
    kind: 'freeText',
    layoutWidth: 280,
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 225, x2: 275, y1: 375, y2: 675 },
    rotation: 90,
    text: 'a wide rotated label'
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [text.id],
    replacePageIndexes: [0]
  });

  const bboxWidth = await freeTextAppearanceBBoxWidth(output, 0, text.id);
  assert.ok(
    bboxWidth > 250,
    `expected BBox width close to the requested 280pt layout, got ${bboxWidth}`
  );
});

test('sticky notes preserve unicode contents', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const note: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: 'test-unicode-note',
    kind: 'stickyNote',
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: 'Unicode note: snowman \u2603 and \u4e2d'
  };

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0]
  });

  assert.equal(await annotationContentsByName(output, note.id), note.text);
});

test('highlight copy text does not block PDF output', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const highlight: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    contents: 'Highlighted Caf\u00e9 \u2603 \u4e2d',
    id: 'test-highlight-unicode-copy-text',
    kind: 'textHighlight',
    opacity: 0.5,
    pageIndex: 0,
    quadPoints: [[72, 714, 120, 714, 72, 700, 120, 700]],
    rects: [{ x1: 72, x2: 120, y1: 700, y2: 714 }]
  };

  const output = await writePdfAnnotations(bytes, [highlight], {
    replaceAnnotationSourceIds: [highlight.id],
    replacePageIndexes: [0]
  });

  assert.ok(output.length > 0);
});

test('moved annotations are written on their new page only', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const highlight: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    contents: 'moved highlight',
    id: 'test-moved-highlight',
    kind: 'textHighlight',
    opacity: 0.5,
    pageIndex: 1,
    quadPoints: [[72, 760, 180, 760, 72, 744, 180, 744]],
    rects: [{ x1: 72, x2: 180, y1: 744, y2: 760 }]
  };

  const withPage = await addBlankPageAt(bytes, 1, 0);
  const output = await writePdfAnnotations(withPage, [highlight], {
    replaceAnnotationSourceIds: [highlight.id],
    replacePageIndexes: [1]
  });
  const byPage = await annotationSubtypeCountsByPage(output);

  assert.equal(byPage[1]?.Highlight, 1);
  assert.equal(byPage[0]?.Highlight, 1);
  assert.equal(byPage[2]?.Highlight ?? 0, 0);
});

test('page mutation helpers keep expected page counts and rotations', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const onePage = await loadTestPdf(bytes);
  assert.equal(onePage.getPageCount(), 1);

  const added = await addBlankPageAt(bytes, 1, 0);
  assert.equal((await loadTestPdf(added)).getPageCount(), 2);

  const removed = await removePage(added, 1);
  assert.equal((await loadTestPdf(removed)).getPageCount(), 1);

  const { bytes: merged, insertedPageCount } = await mergePdfAfterPage(
    bytes,
    bytes,
    0
  );
  assert.equal(insertedPageCount, 1);
  assert.equal((await loadTestPdf(merged)).getPageCount(), 2);

  const rotated = await rotatePageClockwise(bytes, 0);
  assert.equal((await loadTestPdf(rotated)).getPage(0).getRotation().angle, 90);
});

test('a malformed pre-existing annotation is skipped (not aborting the save) and reported via the callback', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const pdfDoc = await loadTestPdf(bytes);
  const annots = pdfDoc.getPage(0).node.Annots();
  assert.ok(annots && annots.size() > 0, 'fixture must have at least one annotation');

  const firstRef = annots.get(0);
  assert.ok(firstRef instanceof PDFRef);
  const annotationDict = pdfDoc.context.lookup(firstRef, PDFDict);
  // A /Subtype present but wrong-typed (a string instead of a name) makes
  // pdf-lib's lookupMaybe throw instead of returning undefined - this is
  // the "malformed pre-existing annotation" case the writer must survive.
  annotationDict.set(PDFName.of('Subtype'), PDFString.of('Highlight'));
  const corruptedBytes = await pdfDoc.save();
  const annotationCountBefore = annots.size();

  const malformedCounts: number[] = [];
  const output = await withoutConsoleWarnings(() =>
    writePdfAnnotations(corruptedBytes, [], {
      replaceAnnotationSourceIds: ['does-not-match-anything'],
      replacePageIndexes: [0],
      onMalformedExistingAnnotations: (count) => malformedCounts.push(count)
    })
  );

  assert.deepEqual(malformedCounts, [1]);

  const outputDoc = await loadTestPdf(output);
  const outputAnnots = outputDoc.getPage(0).node.Annots();
  assert.equal(outputAnnots?.size(), annotationCountBefore);
});

test('print-with-hidden-annotations removes all PDF annotations from output copy only', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const before = await annotationSummary(bytes);
  const output = await writePdfAnnotations(bytes, [], {
    removeAllAnnotations: true
  });
  const after = await annotationSummary(output);

  assert.ok(before.total > 0);
  assert.equal(after.total, 0);
});

function assertExistingSubtypeCountsPreserved(
  before: Record<string, number>,
  after: Record<string, number>,
  except: string[]
) {
  const exceptions = new Set(except);
  for (const [subtype, count] of Object.entries(before)) {
    if (!exceptions.has(subtype)) {
      assert.equal(after[subtype], count, subtype);
    }
  }
}

async function withoutConsoleWarnings<T>(task: () => Promise<T>) {
  const originalError = console.error;
  const originalWarn = console.warn;
  try {
    console.error = () => undefined;
    console.warn = () => undefined;
    return await task();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

async function freeTextAppearanceBBoxWidth(
  bytes: Uint8Array,
  pageIndex: number,
  nm: string
) {
  const pdfDoc = await loadTestPdf(bytes);
  const annots = pdfDoc.getPage(pageIndex).node.Annots();
  if (!annots) {
    throw new Error('no annotations on page');
  }

  for (let index = 0; index < annots.size(); index += 1) {
    const ref = annots.get(index);
    if (!(ref instanceof PDFRef)) {
      continue;
    }

    const dict = pdfDoc.context.lookup(ref, PDFDict);
    const name = dict
      .lookupMaybe(PDFName.of('NM'), PDFString, PDFHexString)
      ?.decodeText();
    if (name !== nm) {
      continue;
    }

    const apDict = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
    const formRef = apDict?.get(PDFName.of('N'));
    const formStream =
      formRef instanceof PDFRef ? pdfDoc.context.lookup(formRef) : formRef;
    if (!(formStream instanceof PDFRawStream)) {
      throw new Error('expected a Form XObject appearance stream');
    }

    const bbox = formStream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
    if (!bbox || bbox.size() < 4) {
      throw new Error('expected a BBox array');
    }

    const x1 = bbox.lookupMaybe(0, PDFNumber)?.asNumber() ?? 0;
    const x2 = bbox.lookupMaybe(2, PDFNumber)?.asNumber() ?? 0;
    return Math.abs(x2 - x1);
  }

  throw new Error(`annotation ${nm} not found`);
}
