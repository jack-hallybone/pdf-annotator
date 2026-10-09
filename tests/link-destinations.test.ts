import assert from "node:assert/strict";
import test from "node:test";
import { destinationTop } from "../src/pdfdocumenteditor/pdfDocumentEditorHelpers";

// A link's destination says where on its page to land, and each kind keeps that in its own slot. Reading the wrong slot, or a null top as 0, landed a link at the foot of its page.

const target = { num: 4, gen: 0 };

test("each kind of destination gives the top it names", () => {
  assert.equal(destinationTop([target, { name: "XYZ" }, 72, 700, null]), 700);
  assert.equal(destinationTop([target, { name: "FitH" }, 650]), 650);
  assert.equal(destinationTop([target, { name: "FitBH" }, 640]), 640);
  assert.equal(
    destinationTop([target, { name: "FitR" }, 72, 100, 300, 500]),
    500,
  );
});

test("a destination that names only its page gives no top", () => {
  for (const destination of [
    [target, { name: "XYZ" }, null, null, null],
    [target, { name: "FitH" }, null],
    [target, { name: "Fit" }],
    [target, { name: "FitB" }],
    [target, { name: "FitV" }, 72],
    [target],
    [target, null, 0, 0],
  ]) {
    assert.equal(
      destinationTop(destination),
      null,
      JSON.stringify(destination),
    );
  }
});
