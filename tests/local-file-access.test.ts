import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fingerprintPdfBytes,
  savePdfToLocalFile,
  type LocalPdfFileHandle
} from '../src/browserapp/localFileAccess';

test('local save writes bytes and verifies the saved file', async () => {
  const handle = newMemoryPdfHandle();
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49]);

  await savePdfToLocalFile(handle, bytes);

  assert.deepEqual(await readHandleBytes(handle), bytes);
  assert.equal(handle.abortCount, 0);
});

test('local save rejects when write permission is denied', async () => {
  const handle = newMemoryPdfHandle({ requestPermission: 'denied' });

  await assert.rejects(
    () => savePdfToLocalFile(handle, new Uint8Array([1, 2, 3])),
    /Permission to save/
  );
  assert.equal(handle.writeCount, 0);
});

test('local save aborts an open write stream when writing fails', async () => {
  const handle = newMemoryPdfHandle({ failWrite: true });

  await assert.rejects(
    () => savePdfToLocalFile(handle, new Uint8Array([1, 2, 3])),
    /write failed/
  );
  assert.equal(handle.abortCount, 1);
});

test('local save reports verification failure after a corrupt write', async () => {
  const handle = newMemoryPdfHandle({ corruptAfterClose: true });

  await assert.rejects(
    () => savePdfToLocalFile(handle, new Uint8Array([1, 2, 3])),
    /Saved file verification failed/
  );
  assert.equal(handle.abortCount, 0);
});

test('local save rejects if the target content changed before overwrite', async () => {
  const original = new Uint8Array([1, 2, 3]);
  const handle = newMemoryPdfHandle({ initialBytes: original });
  const expectedFingerprint = await fingerprintPdfBytes(original);

  handle.replaceBytes(new Uint8Array([1, 9, 3]));

  await assert.rejects(
    () =>
      savePdfToLocalFile(handle, new Uint8Array([4, 5, 6]), {
        expectedCurrentFingerprint: expectedFingerprint
      }),
    /changed outside/
  );
  assert.deepEqual(await readHandleBytes(handle), new Uint8Array([1, 9, 3]));
  assert.equal(handle.writeCount, 0);
});

type MemoryPdfHandle = LocalPdfFileHandle & {
  abortCount: number;
  replaceBytes: (nextBytes: Uint8Array) => void;
  writeCount: number;
};

function newMemoryPdfHandle({
  corruptAfterClose = false,
  failWrite = false,
  initialBytes = new Uint8Array(),
  requestPermission = 'granted'
}: {
  corruptAfterClose?: boolean;
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
          if (corruptAfterClose) {
            bytes = new Uint8Array([...bytes, 255]);
          }
        },
        async write(blob) {
          handle.writeCount += 1;
          if (failWrite) {
            throw new Error('write failed');
          }
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
      };
    },
    async getFile() {
      return new File([bytes], 'test.pdf', { type: 'application/pdf' });
    },
    kind: 'file',
    name: 'test.pdf',
    async queryPermission() {
      return 'prompt';
    },
    async requestPermission() {
      return requestPermission;
    },
    replaceBytes(nextBytes) {
      bytes = nextBytes;
    },
    writeCount: 0
  };
  return handle;
}

async function readHandleBytes(handle: LocalPdfFileHandle) {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}
