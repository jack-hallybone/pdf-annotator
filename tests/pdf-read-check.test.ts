import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  readAsTheEditorWould,
  stopStreamsDecodingPastLimit,
} from "../src/pdfdocumenteditor/pdfParseCheck";
import { objectStreamBombPdf } from "./pdfBombs";

// pdf-lib gives up on an object stream that runs out of memory and parses on, so a check that only timed the parse passed a bomb on any machine fast enough to get that far inside the time limit, and the page then inflated the bomb itself. The cap on what one stream may decode refuses it however fast the machine. Installed here as the worker installs it: node runs each test file in a process of its own.
stopStreamsDecodingPastLimit();

// Past the 64 MB cap, yet small enough for pdf-lib to inflate whole where nothing caps it.
const HALF_A_GIGABYTE = 512 * 1024 * 1024;

test("the read check refuses an object-stream bomb", async () => {
  const bytes = await objectStreamBombPdf(HALF_A_GIGABYTE, { nested: true });
  assert.equal(await readAsTheEditorWould(bytes), "refused");
});

test("the read check reads an ordinary PDF", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText("An ordinary page.", { x: 20, y: 100 });
  assert.equal(await readAsTheEditorWould(await doc.save()), "read");
});

// The editor's own parse then fails the same way, having spent no more, and says so in its own words.
test("the read check reads a file pdf-lib cannot parse", async () => {
  assert.equal(
    await readAsTheEditorWould(new TextEncoder().encode("not a PDF")),
    "read",
  );
});
