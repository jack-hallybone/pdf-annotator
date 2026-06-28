import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectReadOnlyReason,
  pdfLooksEncrypted
} from '../src/annotator/pdfProtection';
import {
  addBlankPageAt,
  mergePdfAfterPage,
  removePage,
  rotatePageClockwise,
  writePdfAnnotations
} from '../src/annotator/pdfWriter';
import type { PdfAnnotation } from '../src/annotator/types';
import {
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

test('print-with-hidden-annotations removes supported annotations from output copy only', async () => {
  const bytes = await readFixture('test-annotated.pdf');
  const before = await annotationSummary(bytes);
  const output = await writePdfAnnotations(bytes, [], {
    removeUnmatchedSupportedAnnotations: true
  });
  const after = await annotationSummary(output);

  assert.equal(after.bySubtype.Highlight ?? 0, 0);
  assert.equal(after.bySubtype.Ink ?? 0, 0);
  assert.equal(after.bySubtype.FreeText ?? 0, 0);
  assert.equal(after.bySubtype.Text ?? 0, 0);
  assert.equal(after.bySubtype.Line, before.bySubtype.Line);
  assert.equal(after.bySubtype.Square, before.bySubtype.Square);
  assert.equal(after.bySubtype.Circle, before.bySubtype.Circle);
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
