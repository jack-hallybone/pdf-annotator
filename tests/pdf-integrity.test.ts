import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import {
  detectReadOnlyReason,
  pdfLooksPdfA,
  pdfLooksSignedOrCertified,
  pdfLooksEncrypted,
} from "../src/pdfdocumenteditor/pdfProtection";
import {
  UnsupportedAnnotationTextError,
  writeAnnotatedPdf,
  writePdfAnnotations,
} from "../src/pdfdocumenteditor/pdfWriter";
import {
  addBlankPageAt,
  addLinedPageAt,
  mergePdfAfterPage,
  removePage,
  rotatePageClockwise,
} from "../src/pdfdocumenteditor/pdfPageOperations";
import {
  MAX_PDF_COORDINATE_MAGNITUDE,
  clampPdfCoordinateMagnitude,
} from "../src/pdfdocumenteditor/annotationSourceKey";
import type { PdfAnnotation } from "../src/pdfdocumenteditor/types";
import {
  annotationContentsByName,
  annotationSubtypeCountsByPage,
  annotationSummary,
  loadTestPdf,
  readFixture,
} from "./pdfTestUtils";

// The protection check reads pdf.js's page list, and PDF.js's browser entry touches these globals while the module is evaluated.
installPdfJsGlobals();
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

test("protected fixture PDFs are detected before editing is enabled", async () => {
  const cases = [
    {
      file: "test-password-123456.pdf",
      passwordProtected: true,
      reason: "password protected",
    },
    {
      file: "test-pdfa.pdf",
      passwordProtected: false,
      reason: "PDF/A compliant",
    },
    {
      file: "test-signed.pdf",
      passwordProtected: false,
      reason: "signed/certified",
    },
  ] as const;

  for (const item of cases) {
    const bytes = await readFixture(item.file);
    const reason = await detectReadOnlyReason(
      bytes,
      null,
      item.passwordProtected,
    );
    assert.equal(reason, item.reason, item.file);
  }
});

// Every file is checked as it opens, so the check runs on the way to page 1: its structural checks, the page-list comparison among them, share one pdf-lib parse rather than loading the file again for each.
test("an ordinary file is parsed once while checking it for protection", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const loadingTask = getDocument({ data: bytes.slice() });
  const shown = await loadingTask.promise;
  const load = mock.method(PDFDocument, "load");
  try {
    assert.equal(await detectReadOnlyReason(bytes, shown, false), null);
    assert.equal(load.mock.callCount(), 1);
  } finally {
    load.mock.restore();
    await loadingTask.destroy();
  }
});

test("pdf-lib encryption detection identifies only the password fixture", async () => {
  const encrypted = await withoutConsoleWarnings(() =>
    readFixture("test-password-123456.pdf").then(pdfLooksEncrypted),
  );
  const unencrypted = await Promise.all(
    ["test-annotated.pdf", "test-pdfa.pdf", "test-signed.pdf"].map(
      async (name) => pdfLooksEncrypted(await readFixture(name)),
    ),
  );

  assert.equal(encrypted, true);
  assert.deepEqual(unencrypted, [false, false, false]);
});

// The scans jump from one native search for a marker's first byte to the next, so a match has to survive the other case of that byte coming first, sitting in the file's last bytes, and a stream it must skip.
test("marker scans find a claim in either case or behind an escape, up to the last byte, and never inside a stream", async () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  assert.equal(
    await pdfLooksPdfA(encode(`${"p".repeat(64)}PDFAID:PART`)),
    true,
  );
  assert.equal(
    await pdfLooksPdfA(encode(`${"P".repeat(64)}pdfaid:conformance`)),
    true,
  );
  // The scan decodes a #xx escape wherever it sits, so a claim can open with one.
  assert.equal(await pdfLooksPdfA(encode("/S /#47TS_PDFA1")), true);
  assert.equal(await pdfLooksPdfA(encode("/S /#67ts_pdfa1")), true);
  assert.equal(pdfLooksSignedOrCertified(encode("%ends /SigFlags")), true);
  assert.equal(
    pdfLooksSignedOrCertified(
      encode("1 0 obj << /Length 9 >> stream\n/SigFlags\nendstream endobj"),
    ),
    false,
  );
  assert.equal(
    pdfLooksSignedOrCertified(
      encode("1 0 obj << >> stream\nxx\nendstream endobj /ByteRange"),
    ),
    true,
  );
});

test("signature markers are detected across the full capped byte range", () => {
  const bytes = new Uint8Array(10 * 1024 * 1024);
  const marker = new TextEncoder().encode("/ByteRange");
  bytes.set(marker, 5 * 1024 * 1024);

  assert.equal(pdfLooksSignedOrCertified(bytes), true);
});

test("annotation writer preserves third-party annotations on a no-edit round trip", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const before = await annotationSummary(bytes);
  assert.ok(before.total > 0, "fixture should contain annotations");

  const output = await writePdfAnnotations(bytes, []);
  const after = await annotationSummary(output);

  assert.deepEqual(after.bySubtype, before.bySubtype);
  assert.equal(after.total, before.total);
});

test("adding an app note does not remove existing third-party annotations", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const before = await annotationSummary(bytes);
  const note: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: "test-added-note",
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: "test note",
  };

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0],
  });
  const after = await annotationSummary(output);

  assert.equal(after.total, before.total + 1);
  assert.equal(after.bySubtype.Text ?? 0, (before.bySubtype.Text ?? 0) + 1);
  assertExistingSubtypeCountsPreserved(before.bySubtype, after.bySubtype, [
    "Text",
  ]);
});

test("repeated annotation writes replace app annotations instead of duplicating them", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const before = await annotationSummary(bytes);
  const firstNote: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: "test-repeat-note-1",
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: "first saved note",
  };
  const secondNote: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: "test-repeat-note-2",
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 96, x2: 116, y1: 72, y2: 92 },
    text: "second saved note",
  };

  const firstOutput = await writePdfAnnotations(bytes, [firstNote], {
    replaceAnnotationSourceIds: [firstNote.id],
    replacePageIndexes: [0],
  });
  const secondOutput = await writePdfAnnotations(
    firstOutput,
    [firstNote, secondNote],
    {
      replaceAnnotationSourceIds: [firstNote.id, secondNote.id],
      replacePageIndexes: [0],
    },
  );
  const after = await annotationSummary(secondOutput);

  assert.equal(after.total, before.total + 2);
  assert.equal(
    await annotationContentsByName(secondOutput, firstNote.id),
    firstNote.text,
  );
  assert.equal(
    await annotationContentsByName(secondOutput, secondNote.id),
    secondNote.text,
  );
});

test("text annotations refuse unsupported characters before writing output", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const text: PdfAnnotation = {
    color: [0.263, 0.58, 0.827],
    fontSize: 12,
    id: "test-unicode-text",
    kind: "freeText",
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 220, y1: 720, y2: 750 },
    text: "Unsupported snowman \u2603\ufe0e",
  };

  await assert.rejects(
    async () =>
      writePdfAnnotations(bytes, [text], {
        replaceAnnotationSourceIds: [text.id],
        replacePageIndexes: [0],
      }),
    (error) =>
      error instanceof UnsupportedAnnotationTextError &&
      error.annotationId === text.id &&
      error.pageIndex === 0 &&
      error.characters.length === 1 &&
      error.characters.includes("\u2603\ufe0e") &&
      error.message.includes("unsupported character"),
  );
});

test("a text box keeps a tab, a joiner and a selector in its text, and draws what Helvetica has", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const text: PdfAnnotation = {
    color: [0.263, 0.58, 0.827],
    fontSize: 12,
    id: "test-kept-text",
    kind: "freeText",
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 280, y1: 720, y2: 750 },
    text: "Qty\t5 \u00a9\ufe0f a\u200db",
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [text.id],
    replacePageIndexes: [0],
  });

  assert.equal(await annotationContentsByName(output, text.id), text.text);
  // "Qty 5 © ab" in WinAnsi: the tab drawn as a space, the selector and the joiner not at all.
  assert.match(
    await freeTextAppearanceContent(output, 0, text.id),
    /<517479203520A9206162> Tj/i,
  );
});

test("text annotations preserve WinAnsi punctuation and accents", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const text: PdfAnnotation = {
    color: [0.263, 0.58, 0.827],
    fontSize: 12,
    id: "test-winansi-text",
    kind: "freeText",
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 280, y1: 720, y2: 750 },
    text: "Caf\u00e9 \u201cM\u00fcller\u201d \u2014 \u20ac",
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [text.id],
    replacePageIndexes: [0],
  });

  assert.equal(await annotationContentsByName(output, text.id), text.text);
});

test("text annotations normalize decomposed western accents before saving", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const text: PdfAnnotation = {
    color: [0.263, 0.58, 0.827],
    fontSize: 12,
    id: "test-decomposed-text",
    kind: "freeText",
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 280, y1: 720, y2: 750 },
    text: "Cafe\u0301",
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [text.id],
    replacePageIndexes: [0],
  });

  assert.equal(await annotationContentsByName(output, text.id), "Caf\u00e9");
});

test("rotated freeText content is laid out against the local (un-rotated) width, not the on-page footprint", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  // `annotation.rect` always stores the on-page footprint, so a 300x50 local box rotated 90 degrees is stored 50 wide and 300 tall, and a writer measuring layout against the footprint would clamp the requested 280pt to ~50pt.
  const text: PdfAnnotation = {
    color: [0, 0, 0],
    fontSize: 12,
    id: "test-rotated-freetext-layout",
    kind: "freeText",
    layoutWidth: 280,
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 225, x2: 275, y1: 375, y2: 675 },
    rotation: 90,
    text: "a wide rotated label",
  };

  const output = await writePdfAnnotations(bytes, [text], {
    replaceAnnotationSourceIds: [text.id],
    replacePageIndexes: [0],
  });

  const bboxWidth = await freeTextAppearanceBBoxWidth(output, 0, text.id);
  assert.ok(
    bboxWidth > 250,
    `expected BBox width close to the requested 280pt layout, got ${bboxWidth}`,
  );
});

test("sticky notes preserve unicode contents", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const note: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: "test-unicode-note",
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: "Unicode note: snowman \u2603 and \u4e2d",
  };

  const output = await writePdfAnnotations(bytes, [note], {
    replaceAnnotationSourceIds: [note.id],
    replacePageIndexes: [0],
  });

  assert.equal(await annotationContentsByName(output, note.id), note.text);
});

test("sticky note contents with parentheses/backslashes round-trip intact", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  // Ordinary inputs whose unbalanced parens and backslashes used to break the PDF string literal, truncating the text and corrupting the surrounding object.
  const cases = [
    ":)",
    ":(",
    "see item (3) below",
    "closing only)",
    "(opening only",
    "back\\slash and (mix)",
    "nested ((a) b) ok",
  ];

  for (const [index, text] of cases.entries()) {
    const note: PdfAnnotation = {
      color: [1, 0.996, 0.306],
      id: `paren-note-${index}`,
      kind: "stickyNote",
      pageIndex: 0,
      rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
      text,
    };

    const output = await writePdfAnnotations(bytes, [note], {
      replaceAnnotationSourceIds: [note.id],
      replacePageIndexes: [0],
    });

    assert.equal(
      await annotationContentsByName(output, note.id),
      text,
      `sticky note text should round-trip exactly: ${JSON.stringify(text)}`,
    );
  }
});

test("free text contents with parentheses round-trip intact", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const text = "Action items: fix (a) and (b) :)";
  const annotation: PdfAnnotation = {
    color: [0, 0, 0],
    fontSize: 12,
    id: "paren-free-text",
    kind: "freeText",
    opacity: 1,
    pageIndex: 0,
    rect: { x1: 72, x2: 272, y1: 600, y2: 680 },
    text,
  };

  const output = await writePdfAnnotations(bytes, [annotation], {
    replaceAnnotationSourceIds: [annotation.id],
    replacePageIndexes: [0],
  });

  assert.equal(await annotationContentsByName(output, annotation.id), text);
});

test("highlight copy text does not block PDF output", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const highlight: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    comment: "Highlighted Caf\u00e9 \u2603 \u4e2d",
    id: "test-highlight-unicode-copy-text",
    kind: "textHighlight",
    opacity: 0.5,
    pageIndex: 0,
    quadPoints: [[72, 714, 120, 714, 72, 700, 120, 700]],
    rects: [{ x1: 72, x2: 120, y1: 700, y2: 714 }],
  };

  const output = await writePdfAnnotations(bytes, [highlight], {
    replaceAnnotationSourceIds: [highlight.id],
    replacePageIndexes: [0],
  });

  assert.ok(output.length > 0);
});

test("moved annotations are written on their new page only", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const highlight: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    comment: "moved highlight",
    id: "test-moved-highlight",
    kind: "textHighlight",
    opacity: 0.5,
    pageIndex: 1,
    quadPoints: [[72, 760, 180, 760, 72, 744, 180, 744]],
    rects: [{ x1: 72, x2: 180, y1: 744, y2: 760 }],
  };

  const withPage = await addBlankPageAt(bytes, 1, 0);
  const output = await writePdfAnnotations(withPage, [highlight], {
    replaceAnnotationSourceIds: [highlight.id],
    replacePageIndexes: [1],
  });
  const byPage = await annotationSubtypeCountsByPage(output);

  assert.equal(byPage[1]?.Highlight, 1);
  assert.equal(byPage[0]?.Highlight, 1);
  assert.equal(byPage[2]?.Highlight ?? 0, 0);
});

test("page mutation helpers keep expected page counts and rotations", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const onePage = await loadTestPdf(bytes);
  assert.equal(onePage.getPageCount(), 1);

  const added = await addBlankPageAt(bytes, 1, 0);
  assert.equal((await loadTestPdf(added)).getPageCount(), 2);

  const removed = (await removePage(added, 1)).bytes;
  assert.equal((await loadTestPdf(removed)).getPageCount(), 1);

  const { bytes: merged, insertedPageCount } = await mergePdfAfterPage(
    bytes,
    bytes,
    0,
  );
  assert.equal(insertedPageCount, 1);
  assert.equal((await loadTestPdf(merged)).getPageCount(), 2);

  const rotated = await rotatePageClockwise(bytes, 0);
  assert.equal((await loadTestPdf(rotated)).getPage(0).getRotation().angle, 90);
});

// bakeInheritedPageAttributes lets a new page model a template's size, but modelling on a rotated neighbour must not turn the new blank page too - rotation is that neighbour's own content, not a default for a blank page.
test("a blank or lined page added after a rotated page starts upright, not turned to match it", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const rotated = await rotatePageClockwise(bytes, 0);
  assert.equal((await loadTestPdf(rotated)).getPage(0).getRotation().angle, 90);

  const withBlank = await addBlankPageAt(rotated, 1, 0);
  const blankDoc = await loadTestPdf(withBlank);
  assert.equal(blankDoc.getPage(0).getRotation().angle, 90);
  assert.equal(blankDoc.getPage(1).getRotation().angle, 0);

  const withLined = await addLinedPageAt(rotated, 1, 0);
  const linedDoc = await loadTestPdf(withLined);
  assert.equal(linedDoc.getPage(0).getRotation().angle, 90);
  assert.equal(linedDoc.getPage(1).getRotation().angle, 0);
});

// A merge source is another file's own content: it keeps its marks, but not a page-open script or a structure index that collides with numbering the target document already uses for its own, unrelated pages.
test("merging in a file drops its page-level /AA and /StructParents, not just leaves them to collide", async () => {
  const target = await PDFDocument.create();
  target.addPage([612, 792]);
  const targetBytes = await target.save({ useObjectStreams: false });

  const source = await PDFDocument.create();
  const sourcePage = source.addPage([612, 792]);
  sourcePage.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
  sourcePage.node.set(
    PDFName.of("AA"),
    source.context.obj({ O: { S: "JavaScript", JS: "app.alert(1)" } }),
  );
  const sourceBytes = await source.save({ useObjectStreams: false });

  const { bytes: merged } = await mergePdfAfterPage(
    targetBytes,
    sourceBytes,
    0,
  );
  const mergedDoc = await loadTestPdf(merged);
  assert.equal(mergedDoc.getPageCount(), 2);
  const mergedPage = mergedDoc.getPage(1).node;
  assert.equal(mergedPage.get(PDFName.of("AA")), undefined);
  assert.equal(mergedPage.get(PDFName.of("StructParents")), undefined);
});

// A Link's /A is ordinarily just a URI or an in-document GoTo, which stays; only a subtype that runs code, leaves the document, or touches form/layer state is stripped, including one reached only through a /Next chain.
test("merging in a file strips a dangerous action from a copied annotation but keeps an ordinary link", async () => {
  const target = await PDFDocument.create();
  target.addPage([612, 792]);
  const targetBytes = await target.save({ useObjectStreams: false });

  const source = await PDFDocument.create();
  const { context } = source;
  const sourcePage = source.addPage([612, 792]);
  const launchLink = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 10, 10],
      A: { S: "Launch", F: { Type: "Filespec", F: "calc.exe" } },
    }),
  );
  const chainedDangerousLink = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 20, 10, 30],
      A: {
        S: "Named",
        N: "NextPage",
        Next: [{ S: "JavaScript", JS: "app.alert(2)" }],
      },
    }),
  );
  const safeLink = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 40, 10, 50],
      A: { S: "URI", URI: "https://example.com" },
    }),
  );
  const scriptedWidget = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Widget",
      Rect: [0, 60, 10, 70],
      FT: "Tx",
      T: "field1",
      AA: { K: { S: "JavaScript", JS: "app.alert(3)" } },
    }),
  );
  sourcePage.node.set(
    PDFName.of("Annots"),
    context.obj([launchLink, chainedDangerousLink, safeLink, scriptedWidget]),
  );
  const sourceBytes = await source.save({ useObjectStreams: false });

  const { bytes: merged } = await mergePdfAfterPage(
    targetBytes,
    sourceBytes,
    0,
  );
  const mergedDoc = await loadTestPdf(merged);
  const annots = mergedDoc.getPage(1).node.Annots();
  assert.equal(annots?.size(), 4);

  const actionSubtypes: (string | undefined)[] = [];
  const aaValues: unknown[] = [];
  for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
    const annotation = annots?.lookupMaybe(index, PDFDict);
    const action = annotation?.lookupMaybe(PDFName.of("A"), PDFDict);
    actionSubtypes.push(
      action?.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText(),
    );
    aaValues.push(annotation?.get(PDFName.of("AA")));
  }

  // launchLink and chainedDangerousLink both lose their /A; safeLink keeps its ordinary URI action; scriptedWidget loses its /AA.
  assert.deepEqual(actionSubtypes, [undefined, undefined, "URI", undefined]);
  assert.deepEqual(aaValues, [undefined, undefined, undefined, undefined]);
});

// The classic carrier for an embedded executable: dropped whole on merge rather than carried into a document that never chose to hold it.
test("merging in a file drops its file-attachment annotations rather than carrying an embedded file over", async () => {
  const target = await PDFDocument.create();
  target.addPage([612, 792]);
  const targetBytes = await target.save({ useObjectStreams: false });

  const source = await PDFDocument.create();
  const { context } = source;
  const sourcePage = source.addPage([612, 792]);
  const attachment = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "FileAttachment",
      Rect: [0, 0, 20, 20],
      FS: { Type: "Filespec", F: "payload.exe" },
    }),
  );
  const note = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [0, 40, 20, 60],
      Contents: PDFString.of("a plain note"),
    }),
  );
  sourcePage.node.set(PDFName.of("Annots"), context.obj([attachment, note]));
  const sourceBytes = await source.save({ useObjectStreams: false });

  const { bytes: merged } = await mergePdfAfterPage(
    targetBytes,
    sourceBytes,
    0,
  );
  const mergedDoc = await loadTestPdf(merged);
  const annots = mergedDoc.getPage(1).node.Annots();
  assert.equal(annots?.size(), 1);
  const survivor = annots?.lookupMaybe(0, PDFDict);
  assert.equal(
    survivor?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText(),
    "Text",
  );

  // Not merely detached from /Annots: gone from the saved file entirely.
  const rawBytes = Buffer.from(merged).toString("latin1");
  assert.ok(!rawBytes.includes("payload.exe"));
});

// /PageLabels/Nums is keyed by page index, so a page insert or delete has to carry those keys along or a label meant for one page starts showing on whatever page a later edit left sitting at that same index.
test("page labels shift with pages instead of drifting onto the wrong one", async () => {
  const pdfDoc = await PDFDocument.create();
  for (let index = 0; index < 4; index += 1) {
    pdfDoc.addPage([612, 792]);
  }
  pdfDoc.catalog.set(
    PDFName.of("PageLabels"),
    pdfDoc.context.obj({ Nums: [0, { S: "r" }, 2, { S: "D" }] }),
  );
  const bytes = await pdfDoc.save({ useObjectStreams: false });

  async function pageLabelKeys(pdfBytes: Uint8Array) {
    const doc = await loadTestPdf(pdfBytes);
    const nums = doc.catalog
      .lookup(PDFName.of("PageLabels"), PDFDict)
      .lookup(PDFName.of("Nums"), PDFArray);
    const keys: number[] = [];
    for (let index = 0; index + 1 < nums.size(); index += 2) {
      keys.push(nums.lookup(index, PDFNumber).asNumber());
    }
    return keys;
  }

  assert.deepEqual(await pageLabelKeys(bytes), [0, 2]);

  // Removing the page at index 1 pulls the entry that started at 2 down to 1; the entry at 0 already precedes the removed page and stays put.
  const removed = (await removePage(bytes, 1)).bytes;
  assert.deepEqual(await pageLabelKeys(removed), [0, 1]);

  // Inserting a page at index 1 pushes the entry at 2 up to 3, so the labels that already existed keep describing the same surviving pages.
  const inserted = await addBlankPageAt(bytes, 1, 0);
  assert.deepEqual(await pageLabelKeys(inserted), [0, 3]);
});

test("a malformed pre-existing annotation is skipped (not aborting the save) and reported via the callback", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const pdfDoc = await loadTestPdf(bytes);
  const annots = pdfDoc.getPage(0).node.Annots();
  assert.ok(
    annots && annots.size() > 0,
    "fixture must have at least one annotation",
  );

  const firstRef = annots.get(0);
  assert.ok(firstRef instanceof PDFRef);
  const annotationDict = pdfDoc.context.lookup(firstRef, PDFDict);
  // A /Subtype present but wrong-typed makes pdf-lib's lookupMaybe throw instead of returning undefined.
  annotationDict.set(PDFName.of("Subtype"), PDFString.of("Highlight"));
  const corruptedBytes = await pdfDoc.save();
  const annotationCountBefore = annots.size();

  const malformedCounts: number[] = [];
  const output = await withoutConsoleWarnings(() =>
    writePdfAnnotations(corruptedBytes, [], {
      replaceAnnotationSourceIds: ["does-not-match-anything"],
      replacePageIndexes: [0],
      onMalformedExistingAnnotations: (count) => malformedCounts.push(count),
    }),
  );

  assert.deepEqual(malformedCounts, [1]);

  const outputDoc = await loadTestPdf(output);
  const outputAnnots = outputDoc.getPage(0).node.Annots();
  assert.equal(outputAnnots?.size(), annotationCountBefore);
});

// A page delete elsewhere can outrun an in-flight edit and leave an annotation naming a page this document no longer has. Writing must not silently drop it and let the caller believe everything was saved - it is left out and counted, the same posture the copy path already takes for an annotation it cannot identify.
test("an annotation whose page no longer exists in the file is skipped and counted, not silently dropped", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const validNote: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: "test-valid-note",
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: "valid note",
  };
  const staleNote: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: "test-stale-note",
    kind: "stickyNote",
    pageIndex: 5,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: "orphaned by a page delete elsewhere",
  };

  let reportedCount = -1;
  const { bytes: output } = await writeAnnotatedPdf(
    bytes,
    [validNote, staleNote],
    {
      onUnwritablePageIndex: (count) => {
        reportedCount = count;
      },
    },
  );

  assert.equal(reportedCount, 1);
  assert.equal(await annotationContentsByName(output, staleNote.id), null);
  assert.equal(
    await annotationContentsByName(output, validNote.id),
    validNote.text,
  );
});

test("writing only annotations with valid pages never calls the unwritable-page-index callback", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const validNote: PdfAnnotation = {
    color: [1, 0.996, 0.306],
    id: "test-only-valid-note",
    kind: "stickyNote",
    pageIndex: 0,
    rect: { x1: 72, x2: 92, y1: 72, y2: 92 },
    text: "valid note",
  };

  let called = false;
  await writeAnnotatedPdf(bytes, [validNote], {
    onUnwritablePageIndex: () => {
      called = true;
    },
  });

  assert.equal(called, false);
});

// The scan that looks for an edit's target has to walk every annotation on the page, not just the one it is looking for, so a neighbour's bad /Rect, /NM or /Contents must not throw past the scan and abort the whole save.
test("a malformed neighbouring annotation does not block editing another one on the same page", async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 200]);
  const { context } = pdfDoc;

  const good = context.obj({
    C: [1, 1, 0],
    QuadPoints: [10, 50, 50, 50, 10, 10, 50, 10],
    Rect: [10, 10, 50, 50],
    Subtype: "Highlight",
    Type: "Annot",
  }) as PDFDict;
  // context.obj() turns a JS string into a /Name, not a /NM string value.
  good.set(PDFName.of("NM"), PDFString.of("good-nm"));
  const goodRef = context.register(good);

  // A /Rect pdf-lib cannot resolve as an array: reading this neighbour's geometry throws rather than returning undefined.
  const badNeighbour = context.obj({
    Subtype: "Highlight",
    Type: "Annot",
  }) as PDFDict;
  badNeighbour.set(PDFName.of("NM"), PDFString.of("bad-neighbour"));
  badNeighbour.set(PDFName.of("Rect"), PDFString.of("not-an-array"));
  const badRef = context.register(badNeighbour);

  page.node.set(PDFName.of("Annots"), context.obj([goodRef, badRef]));
  const bytes = await pdfDoc.save({ useObjectStreams: false });

  const edit: PdfAnnotation = {
    color: [1, 0, 0],
    comment: "edited",
    id: "good-nm",
    kind: "textHighlight",
    opacity: 0.5,
    pageIndex: 0,
    quadPoints: [[10, 50, 50, 50, 10, 10, 50, 10]],
    rects: [{ x1: 10, x2: 50, y1: 10, y2: 50 }],
  };

  const output = await writePdfAnnotations(bytes, [edit], {
    replaceAnnotationSourceIds: ["good-nm"],
    replacePageIndexes: [0],
  });

  // The edit landed on the right dictionary, and the malformed neighbour (unreadable, so untouched) is still there rather than having taken the whole save down with it.
  assert.equal(await annotationContentsByName(output, "good-nm"), "edited");
  const outputAnnots = (await loadTestPdf(output)).getPage(0).node.Annots();
  assert.equal(outputAnnots?.size(), 2);
});

// pdfWriter.ts rounds a coordinate to its on-disk precision by dividing by that precision, rounding, then multiplying back; an import-time value this large overflows that division to Infinity unless it was clamped first.
test("an import-time coordinate this large is clamped before it can overflow a later save", () => {
  const huge = 1e308;
  const clamped = clampPdfCoordinateMagnitude(huge);
  assert.equal(clamped, MAX_PDF_COORDINATE_MAGNITUDE);

  const precision = 0.01;
  assert.equal(
    Number.isFinite(Math.round(huge / precision) * precision),
    false,
  );
  assert.equal(
    Number.isFinite(Math.round(clamped / precision) * precision),
    true,
  );
});

test("print-with-hidden-annotations removes all PDF annotations from output copy only", async () => {
  const bytes = await readFixture("test-annotated.pdf");
  const before = await annotationSummary(bytes);
  const output = await writePdfAnnotations(bytes, [], {
    removeAllAnnotations: true,
  });
  const after = await annotationSummary(output);

  assert.ok(before.total > 0);
  assert.equal(after.total, 0);
});

function assertExistingSubtypeCountsPreserved(
  before: Record<string, number>,
  after: Record<string, number>,
  except: string[],
) {
  const exceptions = new Set(except);
  for (const [subtype, count] of Object.entries(before)) {
    if (!exceptions.has(subtype)) {
      assert.equal(after[subtype], count, subtype);
    }
  }
}

function installPdfJsGlobals() {
  class FakeDOMMatrix {}
  class FakeImageData {}
  class FakePath2D {}
  const globals = globalThis as {
    DOMMatrix?: unknown;
    ImageData?: unknown;
    Path2D?: unknown;
  };
  globals.DOMMatrix ??= FakeDOMMatrix;
  globals.ImageData ??= FakeImageData;
  globals.Path2D ??= FakePath2D;
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
  nm: string,
) {
  const formStream = await freeTextAppearanceStream(bytes, pageIndex, nm);
  const bbox = formStream.dict.lookupMaybe(PDFName.of("BBox"), PDFArray);
  if (!bbox || bbox.size() < 4) {
    throw new Error("expected a BBox array");
  }

  const x1 = bbox.lookupMaybe(0, PDFNumber)?.asNumber() ?? 0;
  const x2 = bbox.lookupMaybe(2, PDFNumber)?.asNumber() ?? 0;
  return Math.abs(x2 - x1);
}

async function freeTextAppearanceContent(
  bytes: Uint8Array,
  pageIndex: number,
  nm: string,
) {
  const formStream = await freeTextAppearanceStream(bytes, pageIndex, nm);
  return new TextDecoder("latin1").decode(
    decodePDFRawStream(formStream).decode(),
  );
}

async function freeTextAppearanceStream(
  bytes: Uint8Array,
  pageIndex: number,
  nm: string,
) {
  const pdfDoc = await loadTestPdf(bytes);
  const annots = pdfDoc.getPage(pageIndex).node.Annots();
  if (!annots) {
    throw new Error("no annotations on page");
  }

  for (let index = 0; index < annots.size(); index += 1) {
    const ref = annots.get(index);
    if (!(ref instanceof PDFRef)) {
      continue;
    }

    const dict = pdfDoc.context.lookup(ref, PDFDict);
    const name = dict
      .lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString)
      ?.decodeText();
    if (name !== nm) {
      continue;
    }

    const apDict = dict.lookupMaybe(PDFName.of("AP"), PDFDict);
    const formRef = apDict?.get(PDFName.of("N"));
    const formStream =
      formRef instanceof PDFRef ? pdfDoc.context.lookup(formRef) : formRef;
    if (!(formStream instanceof PDFRawStream)) {
      throw new Error("expected a Form XObject appearance stream");
    }

    return formStream;
  }

  throw new Error(`annotation ${nm} not found`);
}
