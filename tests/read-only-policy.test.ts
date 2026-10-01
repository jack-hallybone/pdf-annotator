import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreateOutputCopy,
  canEditReadOnlyCopy,
} from "../src/pdfdocumenteditor/readOnlyPolicy";

test("only non-encrypted protected PDFs can be edited as a copy", () => {
  assert.equal(canEditReadOnlyCopy("PDF/A compliant"), true);
  assert.equal(canEditReadOnlyCopy("signed/certified"), true);
  assert.equal(canEditReadOnlyCopy("password protected"), false);
  assert.equal(canEditReadOnlyCopy(null), false);
});

test("encrypted PDFs cannot use output-copy routes", () => {
  assert.equal(canCreateOutputCopy("PDF/A compliant"), true);
  assert.equal(canCreateOutputCopy("signed/certified"), true);
  assert.equal(canCreateOutputCopy("password protected"), false);
  assert.equal(canCreateOutputCopy(null), true);
});

// A copy is written by page index just like the original, so its edits would land on the same wrong pages; a copy made without edits is the original's own bytes.
test("a file whose page lists disagree has no copy to edit, only copies of itself", () => {
  assert.equal(canEditReadOnlyCopy("ambiguous page order"), false);
  assert.equal(canCreateOutputCopy("ambiguous page order"), true);
});
