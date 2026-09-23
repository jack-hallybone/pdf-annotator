import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintPdfBytes,
  localPdfFilesFromHandles,
  savePdfToLocalFile,
  type LocalPdfFileHandle,
} from "../src/browserapp/localFileAccess";
import { PdfSaveError } from "../src/pdfdocumenteditor/host";

test("local save writes bytes and verifies the saved file", async () => {
  const handle = newMemoryPdfHandle();
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49]);

  await savePdfToLocalFile(handle, bytes);

  assert.deepEqual(await readHandleBytes(handle), bytes);
  assert.equal(handle.abortCount, 0);
});

test("local save rejects when write permission is denied", async () => {
  const handle = newMemoryPdfHandle({ requestPermission: "denied" });

  await assert.rejects(
    () => savePdfToLocalFile(handle, new Uint8Array([1, 2, 3])),
    (error) => isSaveError(error, "permission", false, /Permission to save/),
  );
  assert.equal(handle.writeCount, 0);
});

test("local save aborts an open write stream when writing fails", async () => {
  const handle = newMemoryPdfHandle({ failWrite: true });

  await assert.rejects(
    () => savePdfToLocalFile(handle, new Uint8Array([1, 2, 3])),
    (error) => isSaveError(error, "write", false, /write failed/),
  );
  assert.equal(handle.abortCount, 1);
});

test("local save reports verification failure after a corrupt write", async () => {
  const handle = newMemoryPdfHandle({ corruptAfterClose: true });

  await assert.rejects(
    () => savePdfToLocalFile(handle, new Uint8Array([1, 2, 3])),
    (error) =>
      isSaveError(error, "verify", true, /Saved file verification failed/),
  );
  assert.equal(handle.abortCount, 0);
});

test("local save rejects if the target content changed before overwrite", async () => {
  const original = new Uint8Array([1, 2, 3]);
  const handle = newMemoryPdfHandle({ initialBytes: original });
  const expectedFingerprint = await fingerprintPdfBytes(original);

  handle.replaceBytes(new Uint8Array([1, 9, 3]));

  await assert.rejects(
    () =>
      savePdfToLocalFile(handle, new Uint8Array([4, 5, 6]), {
        expectedCurrentFingerprint: expectedFingerprint,
      }),
    (error) => isSaveError(error, "preflight", false, /changed outside/),
  );
  assert.deepEqual(await readHandleBytes(handle), new Uint8Array([1, 9, 3]));
  assert.equal(handle.writeCount, 0);
});

test("local save treats a rejected close as possibly committed", async () => {
  const handle = newMemoryPdfHandle({ failClose: true });

  await assert.rejects(
    () => savePdfToLocalFile(handle, new Uint8Array([1, 2, 3])),
    (error) => isSaveError(error, "close", true, /close failed/),
  );
  assert.equal(handle.abortCount, 1);
});

test("local overwrite fingerprinting fails closed without SHA-256", async () => {
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {},
  });

  try {
    await assert.rejects(
      () => fingerprintPdfBytes(new Uint8Array([1, 2, 3])),
      /Secure file fingerprinting is unavailable/,
    );
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
});

test("local save-as style write works without SHA-256 preflight", async () => {
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {},
  });

  try {
    const handle = newMemoryPdfHandle();
    const bytes = new Uint8Array([7, 8, 9]);

    await savePdfToLocalFile(handle, bytes);

    assert.deepEqual(await readHandleBytes(handle), bytes);
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
});

test("a PDF MIME type is accepted even when the handle has no .pdf suffix", async () => {
  const handle = newMemoryPdfHandle();
  handle.name = "document";
  handle.getFile = async () =>
    new File(["%PDF-1.7\n"], "document", { type: "application/pdf" });

  const files = await localPdfFilesFromHandles([handle]);

  assert.equal(files.length, 1);
  assert.equal(files[0].file.name, "document");
});

type MemoryPdfHandle = LocalPdfFileHandle & {
  abortCount: number;
  replaceBytes: (nextBytes: Uint8Array) => void;
  writeCount: number;
};

function newMemoryPdfHandle({
  corruptAfterClose = false,
  failClose = false,
  failWrite = false,
  initialBytes = new Uint8Array(),
  requestPermission = "granted",
}: {
  corruptAfterClose?: boolean;
  failClose?: boolean;
  failWrite?: boolean;
  initialBytes?: Uint8Array;
  requestPermission?: PermissionState;
} = {}): MemoryPdfHandle {
  let bytes = initialBytes;
  const handle: MemoryPdfHandle = {
    abortCount: 0,
    async createWritable() {
      return {
        async abort() {
          handle.abortCount += 1;
        },
        async close() {
          if (failClose) {
            throw new Error("close failed");
          }
          if (corruptAfterClose) {
            bytes = new Uint8Array([...bytes, 255]);
          }
        },
        async write(blob) {
          handle.writeCount += 1;
          if (failWrite) {
            throw new Error("write failed");
          }
          bytes = new Uint8Array(await blob.arrayBuffer());
        },
      };
    },
    async getFile() {
      return new File([bytes as BlobPart], "test.pdf", {
        type: "application/pdf",
      });
    },
    kind: "file",
    name: "test.pdf",
    async queryPermission() {
      return "prompt";
    },
    async requestPermission() {
      return requestPermission;
    },
    replaceBytes(nextBytes) {
      bytes = nextBytes;
    },
    writeCount: 0,
  };
  return handle;
}

async function readHandleBytes(handle: LocalPdfFileHandle) {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

function isSaveError(
  error: unknown,
  stage: PdfSaveError["stage"],
  mayHaveCommitted: boolean,
  message: RegExp,
) {
  assert.ok(error instanceof PdfSaveError);
  assert.equal(error.stage, stage);
  assert.equal(error.mayHaveCommitted, mayHaveCommitted);
  assert.match(error.message, message);
  return true;
}
