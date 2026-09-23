import assert from "node:assert/strict";
import test from "node:test";
import { pdfFileNameFromStem, safePdfFileName } from "../src/fileNames";

test("PDF filenames are sanitized and keep a PDF extension", () => {
  assert.equal(safePdfFileName("quarterly/report"), "quarterly_report.pdf");
  assert.equal(safePdfFileName("invoice"), "invoice.pdf");
  assert.equal(safePdfFileName("already.PDF"), "already.PDF");
  assert.equal(safePdfFileName("name. "), "name.pdf");
});

test("PDF filenames avoid Windows reserved device names", () => {
  assert.equal(safePdfFileName("CON.pdf"), "_CON.pdf");
  assert.equal(safePdfFileName("CON .pdf"), "_CON .pdf");
  assert.equal(safePdfFileName("lpt1"), "_lpt1.pdf");
});

test("PDF filenames fall back safely", () => {
  assert.equal(safePdfFileName(" /// ", "fallback"), "fallback.pdf");
  assert.equal(safePdfFileName(" /// ", "NUL.pdf"), "_NUL.pdf");
});

// The named cases from the finding: the rules used to enumerate the ASCII
// controls and left every bidi override standing, and the derived class is swept
// against Unicode by `hidden-characters.test.ts`.
test("PDF filenames lose the characters that make a name read backwards", () => {
  assert.equal(
    safePdfFileName("report\u202Efdp.exe.pdf"),
    "report_fdp.exe.pdf",
  );
  assert.equal(safePdfFileName("a\u061Cb.pdf"), "a_b.pdf");
  assert.equal(safePdfFileName("a\u200Eb.pdf"), "a_b.pdf");
  assert.equal(safePdfFileName("a\u200Fb.pdf"), "a_b.pdf");
  assert.equal(safePdfFileName("a\u200Bb.pdf"), "a_b.pdf");
  assert.equal(safePdfFileName("a\uFEFFb.pdf"), "a_b.pdf");
  assert.equal(pdfFileNameFromStem("tab\u202Etitle"), "tab title.pdf");
  assert.equal(pdfFileNameFromStem("\u061C"), null);
});
