import assert from "node:assert/strict";
import test from "node:test";
import { prepareImageStampFromFile } from "../src/pdfdocumenteditor/imageImport";
import { readPdfFile } from "../src/pdfdocumenteditor/pdfFile";

// The sizes are literals rather than imported from the modules they guard,
// because a test built from the constant it checks stays green when somebody
// raises the limit.

/** A File of a declared size without allocating it: only `size` is read. */
function pretendSizedFile(name: string, type: string, size: number) {
  const file = new File([new Uint8Array(8)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

test("an empty PDF is refused", async () => {
  const message = await refusal(() =>
    readPdfFile(new File([], "empty.pdf", { type: "application/pdf" })),
  );
  assert.equal(message, "The selected PDF is empty.");
});

test("a PDF over the size limit is refused before it is read", async () => {
  const message = await refusal(() =>
    readPdfFile(
      pretendSizedFile("huge.pdf", "application/pdf", 128 * 1024 * 1024 + 1),
    ),
  );
  assert.match(message ?? "", /safety limit/);
  assert.match(message ?? "", /128\.0 MiB/);
});

test("a file that is not a PDF is refused however it is named", async () => {
  // The realistic case: a saved web page, or an HTML error body a server returned
  // with a .pdf name.
  const message = await refusal(() =>
    readPdfFile(
      new File(["<!doctype html><title>not a pdf</title>"], "invoice.pdf", {
        type: "application/pdf",
      }),
    ),
  );
  assert.equal(message, "The selected file does not look like a PDF.");
});

test("an unsupported image type is refused", async () => {
  const message = await refusal(() =>
    prepareImageStampFromFile(
      new File([new Uint8Array(8)], "diagram.svg", { type: "image/svg+xml" }),
    ),
  );
  assert.equal(message, "Only PNG, JPEG and WebP images are supported.");
});

test("an image over the size limit is refused before it is decoded", async () => {
  const message = await refusal(() =>
    prepareImageStampFromFile(
      pretendSizedFile("huge.png", "image/png", 32 * 1024 * 1024 + 1),
    ),
  );
  assert.equal(message, "Images larger than 32 MiB are not supported.");
});

test("an image whose own header declares impossible dimensions is refused", async () => {
  // A 20000x20000 PNG is 44 bytes on disk and 1.6 GB decoded, so the refusal has
  // to come from the header, before createImageBitmap is handed the blob.
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47], 0);
  header.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  new DataView(header.buffer).setUint32(16, 20_000);
  new DataView(header.buffer).setUint32(20, 20_000);

  const message = await refusal(() =>
    prepareImageStampFromFile(
      new File([header], "bomb.png", { type: "image/png" }),
    ),
  );
  assert.equal(message, "The image dimensions are too large to import safely.");
});

test("an image with no readable header is refused rather than guessed at", async () => {
  const message = await refusal(() =>
    prepareImageStampFromFile(
      new File([new Uint8Array(64)], "truncated.png", { type: "image/png" }),
    ),
  );
  assert.equal(message, "Could not verify the image dimensions safely.");
});
