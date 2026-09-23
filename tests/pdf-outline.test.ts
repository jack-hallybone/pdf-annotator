import assert from "node:assert/strict";
import test from "node:test";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfOutline } from "../src/pdfdocumenteditor/pdfOutline";
import type { PdfOutlineEntry } from "../src/pdfdocumenteditor/pdfOutline";

// An outline is document-controlled data that gets rendered, and nothing in
// pdf.js bounds its depth, its size, its titles or the characters in them.
function fakeDoc(outline: unknown): PDFDocumentProxy {
  return { getOutline: async () => outline } as unknown as PDFDocumentProxy;
}

function countEntries(entries: PdfOutlineEntry[]): number {
  return entries.reduce(
    (total, entry) => total + 1 + countEntries(entry.items),
    0,
  );
}

const CONTROL = String.fromCharCode(7);
const RTL_OVERRIDE = "‮";

// An outline nested a few thousand deep: both the sanitiser and the renderer
// walk it recursively, so it is a blown stack from a file.
test("a deeply nested outline is cut off at a fixed depth", async () => {
  let deepest: unknown = [{ title: "leaf", dest: "d", items: [] }];
  for (let level = 0; level < 400; level += 1) {
    deepest = [{ title: `level ${level}`, dest: "d", items: deepest }];
  }

  const entries = await loadPdfOutline(fakeDoc(deepest));
  let depth = 0;
  let cursor = entries;
  while (cursor.length > 0) {
    depth += 1;
    cursor = cursor[0].items;
  }

  assert.ok(depth > 0, "the outline was dropped entirely");
  assert.ok(depth <= 12, `outline nested ${depth} deep`);
});

test("a huge outline is cut off at a fixed number of entries", async () => {
  const wide = Array.from({ length: 20_000 }, (_, index) => ({
    title: `entry ${index}`,
    dest: "d",
    items: [],
  }));

  const entries = await loadPdfOutline(fakeDoc(wide));
  assert.ok(entries.length > 0);
  assert.ok(
    countEntries(entries) <= 2000,
    `kept ${countEntries(entries)} entries`,
  );
});

test("titles are bounded, stripped and collapsed to one line", async () => {
  const entries = await loadPdfOutline(
    fakeDoc([
      {
        title: `a${CONTROL}b${RTL_OVERRIDE}c\n\nd   e` + "x".repeat(5000),
        dest: "d",
        items: [],
      },
    ]),
  );

  assert.equal(entries.length, 1);
  assert.ok(entries[0].title.length <= 300);
  assert.ok(!entries[0].title.includes(CONTROL));
  assert.ok(!entries[0].title.includes(RTL_OVERRIDE));
  assert.match(entries[0].title, /^abc d e/);
});

test("entries the document made up are dropped rather than rendered", async () => {
  const entries = await loadPdfOutline(
    fakeDoc([
      null,
      "not an object",
      { title: 42, items: [] },
      { title: "", dest: "d", items: [] },
      { title: "kept", dest: { evil: true }, items: [] },
      { title: "also kept", dest: ["1R", "XYZ"], items: [] },
    ]),
  );

  assert.deepEqual(
    entries.map((entry) => entry.title),
    ["kept", "also kept"],
  );
  assert.equal(entries[0].destination, null);
  assert.deepEqual(entries[1].destination, ["1R", "XYZ"]);
});

test("a document with no outline, or a broken one, reports emptiness", async () => {
  assert.deepEqual(await loadPdfOutline(fakeDoc(null)), []);
  assert.deepEqual(
    await loadPdfOutline({
      getOutline: async () => {
        throw new Error("broken");
      },
    } as unknown as PDFDocumentProxy),
    [],
  );
});
