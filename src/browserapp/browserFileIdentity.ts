import type { LocalPdfFileHandle } from './localFileAccess';

const MAX_TRACKED_FILE_HANDLES = 256;
const fileHandleKeys = new WeakMap<LocalPdfFileHandle, string>();
const trackedFileHandles: Array<{
  handle: LocalPdfFileHandle;
  key: string;
}> = [];
let nextFileHandleKey = 0;

// De-duplication must use the underlying file entry, not filename/size/mtime:
// two files in different folders can share all three metadata fields. Plain
// File objects do not expose entry identity, so callers intentionally leave
// those unkeyed (opening a duplicate tab is safer than silently focusing the
// wrong document). File System Access handles can compare their actual entries.
export async function browserFileHandleKey(handle: LocalPdfFileHandle) {
  const existingKey = fileHandleKeys.get(handle);
  if (existingKey) {
    return existingKey;
  }

  if (handle.isSameEntry) {
    for (const tracked of trackedFileHandles) {
      try {
        if (await handle.isSameEntry(tracked.handle)) {
          fileHandleKeys.set(handle, tracked.key);
          return tracked.key;
        }
      } catch {
        // A failed identity comparison only disables de-duplication for this
        // handle; it must never prevent the file itself from opening.
      }
    }
  }

  nextFileHandleKey += 1;
  const key = `browser-file:${nextFileHandleKey}`;
  fileHandleKeys.set(handle, key);
  trackedFileHandles.push({ handle, key });
  if (trackedFileHandles.length > MAX_TRACKED_FILE_HANDLES) {
    trackedFileHandles.splice(
      0,
      trackedFileHandles.length - MAX_TRACKED_FILE_HANDLES
    );
  }
  return key;
}
