import assert from 'node:assert/strict';
import test from 'node:test';
import { browserFileHandleKey } from '../src/browserapp/browserFileIdentity';
import type { LocalPdfFileHandle } from '../src/browserapp/localFileAccess';

test('file handles deduplicate only when they identify the same entry', async () => {
  const first = pdfHandle('entry-a', 'same.pdf');
  const sameEntry = pdfHandle('entry-a', 'same.pdf');
  const differentEntry = pdfHandle('entry-b', 'same.pdf');

  const firstKey = await browserFileHandleKey(first);
  const sameEntryKey = await browserFileHandleKey(sameEntry);
  const differentEntryKey = await browserFileHandleKey(differentEntry);

  assert.equal(firstKey, sameEntryKey);
  assert.notEqual(firstKey, differentEntryKey);
});

test('the same handle object keeps its key when entry comparison is unavailable', async () => {
  const handle = pdfHandle('entry-without-comparison', 'same.pdf');
  delete handle.isSameEntry;

  assert.equal(
    await browserFileHandleKey(handle),
    await browserFileHandleKey(handle)
  );
});

function pdfHandle(entryId: string, name: string) {
  return {
    async createWritable() {
      return {
        async close() {},
        async write() {}
      };
    },
    async getFile() {
      return new File(['%PDF-1.7\n'], name, {
        lastModified: 1234,
        type: 'application/pdf'
      });
    },
    async isSameEntry(other) {
      return (other as LocalPdfFileHandle & { entryId?: string }).entryId === entryId;
    },
    kind: 'file' as const,
    name,
    entryId
  } as LocalPdfFileHandle & { entryId: string };
}
