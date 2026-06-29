import { uint8ArrayToArrayBuffer } from '../bytes';

export type LocalPdfFileHandle = {
  kind: 'file';
  name: string;
  createWritable: (
    options?: LocalCreateWritableOptions
  ) => Promise<LocalWritableFileStream>;
  getFile: () => Promise<File>;
  queryPermission?: (
    descriptor?: LocalFilePermissionDescriptor
  ) => Promise<PermissionState>;
  requestPermission?: (
    descriptor?: LocalFilePermissionDescriptor
  ) => Promise<PermissionState>;
};

type LocalFilePermissionDescriptor = {
  mode?: 'read' | 'readwrite';
};

type LocalWritableFileStream = {
  abort?: () => Promise<void>;
  close: () => Promise<void>;
  write: (data: Blob) => Promise<void>;
};

type LocalCreateWritableOptions = {
  keepExistingData?: boolean;
  mode?: 'exclusive' | 'siloed';
};

type LocalWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (
      options?: LocalOpenFilePickerOptions
    ) => Promise<LocalPdfFileHandle[]>;
    showSaveFilePicker?: (
      options?: LocalSaveFilePickerOptions
    ) => Promise<LocalPdfFileHandle>;
  };

type LocalOpenFilePickerOptions = {
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  types?: Array<{
    accept: Record<string, string[]>;
    description?: string;
  }>;
};

type LocalSaveFilePickerOptions = Omit<LocalOpenFilePickerOptions, 'multiple'> & {
  suggestedName?: string;
};

type DataTransferItemWithFileSystemHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<unknown>;
};

const pdfPickerOptions: LocalOpenFilePickerOptions = {
  excludeAcceptAllOption: false,
  multiple: true,
  types: [
    {
      accept: {
        'application/pdf': ['.pdf']
      },
      description: 'PDF files'
    }
  ]
};

const imagePickerOptions: LocalOpenFilePickerOptions = {
  excludeAcceptAllOption: false,
  multiple: false,
  types: [
    {
      accept: {
        'image/jpeg': ['.jpg', '.jpeg'],
        'image/png': ['.png'],
        'image/webp': ['.webp']
      },
      description: 'Image files'
    }
  ]
};

export function canPickLocalPdfFile() {
  return typeof localWindow().showOpenFilePicker === 'function';
}

export function canSaveLocalPdfFileAs() {
  return typeof localWindow().showSaveFilePicker === 'function';
}

export async function pickLocalPdfFiles({
  multiple = true
}: { multiple?: boolean } = {}) {
  const picker = localWindow().showOpenFilePicker;
  if (!picker) {
    return [];
  }

  try {
    const handles = await picker({ ...pdfPickerOptions, multiple });
    return localPdfFilesFromHandles(handles);
  } catch (error) {
    if (isPickerAbort(error)) {
      return [];
    }
    throw error;
  }
}

export async function pickLocalImageFile() {
  const picker = localWindow().showOpenFilePicker;
  if (!picker) {
    return null;
  }

  try {
    const [handle] = await picker(imagePickerOptions);
    const file = await handle?.getFile();
    return file && isSupportedImageFile(file) ? file : null;
  } catch (error) {
    if (isPickerAbort(error)) {
      return null;
    }
    throw error;
  }
}

export async function localPdfFilesFromDrop(dataTransfer: DataTransfer) {
  const handles = await localPdfHandlesFromItems(
    Array.from(dataTransfer.items ?? [])
  );
  return localPdfFilesFromHandles(handles);
}

export async function savePdfToLocalFile(
  handle: LocalPdfFileHandle,
  bytes: Uint8Array,
  options: { expectedCurrentFingerprint?: string | null } = {}
) {
  await requestReadWritePermission(handle);

  if (options.expectedCurrentFingerprint) {
    const currentFingerprint = await fingerprintPdfFile(await handle.getFile());
    if (currentFingerprint !== options.expectedCurrentFingerprint) {
      throw new Error(
        'The PDF changed outside this window. Use Save As to avoid overwriting newer changes.'
      );
    }
  }

  const writable = await createWritable(handle);
  let closed = false;
  try {
    await writable.write(pdfBlob(bytes));
    await writable.close();
    closed = true;
    await verifySavedPdfBytes(handle, bytes);
  } catch (error) {
    if (!closed) {
      await abortWritable(writable);
    }
    throw error;
  }
}

export async function fingerprintPdfFile(file: File) {
  return fingerprintPdfBytes(new Uint8Array(await file.arrayBuffer()));
}

export async function fingerprintPdfBytes(bytes: Uint8Array) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', arrayBufferForBytes(bytes));
    return hexBytes(new Uint8Array(digest));
  }

  return fullByteHash(bytes);
}

export async function pickLocalPdfSaveFile(suggestedName: string) {
  const picker = localWindow().showSaveFilePicker;
  if (!picker) {
    return null;
  }

  try {
    return await picker({
      ...pdfPickerOptions,
      suggestedName
    });
  } catch (error) {
    if (isPickerAbort(error)) {
      return null;
    }
    throw error;
  }
}

async function createWritable(handle: LocalPdfFileHandle) {
  try {
    return await handle.createWritable({ mode: 'exclusive' });
  } catch (error) {
    if (error instanceof TypeError) {
      return handle.createWritable();
    }
    throw error;
  }
}

async function verifySavedPdfBytes(
  handle: LocalPdfFileHandle,
  expectedBytes: Uint8Array
) {
  const savedFile = await handle.getFile();
  if (savedFile.size !== expectedBytes.byteLength) {
    throw new Error('Saved file verification failed: byte length mismatch.');
  }

  const reader = savedFile.stream().getReader();
  let offset = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== expectedBytes[offset + index]) {
          throw new Error('Saved file verification failed: byte mismatch.');
        }
      }
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (offset !== expectedBytes.byteLength) {
    throw new Error('Saved file verification failed: incomplete read.');
  }
}

async function localPdfHandlesFromItems(items: DataTransferItem[]) {
  const handles: LocalPdfFileHandle[] = [];
  for (const item of items) {
    const getHandle = (item as DataTransferItemWithFileSystemHandle)
      .getAsFileSystemHandle;
    if (typeof getHandle !== 'function') {
      continue;
    }

    const handle = await getHandle.call(item);
    if (isPdfFileHandle(handle)) {
      handles.push(handle);
    }
  }

  return handles;
}

export async function localPdfFilesFromHandles(
  handles: LocalPdfFileHandle[]
) {
  const files = await Promise.allSettled(
    handles.filter(isPdfFileHandle).map(async (handle) => ({
      file: await handle.getFile(),
      handle
    }))
  );
  const readableFiles = files.flatMap((result) =>
    result.status === 'fulfilled' && isPdfFile(result.value.file)
      ? [result.value]
      : []
  );

  if (readableFiles.length === 0) {
    const failedRead = files.find((result) => result.status === 'rejected');
    if (failedRead?.status === 'rejected') {
      throw failedRead.reason;
    }
  }

  return readableFiles;
}

async function requestReadWritePermission(handle: LocalPdfFileHandle) {
  const descriptor: LocalFilePermissionDescriptor = { mode: 'readwrite' };
  const current = await handle.queryPermission?.(descriptor);
  if (current === 'granted') {
    return;
  }

  const requested = await handle.requestPermission?.(descriptor);
  if (requested && requested !== 'granted') {
    throw new Error('Permission to save to the original file was not granted.');
  }
}

async function abortWritable(writable: LocalWritableFileStream) {
  try {
    await writable.abort?.();
  } catch {
    // The original save error is more useful to report.
  }
}

function isPdfFileHandle(handle: unknown): handle is LocalPdfFileHandle {
  const candidate = handle as Partial<LocalPdfFileHandle> | null;
  return (
    typeof handle === 'object' &&
    handle !== null &&
    candidate?.kind === 'file' &&
    typeof candidate.name === 'string' &&
    typeof candidate.getFile === 'function' &&
    typeof candidate.createWritable === 'function' &&
    candidate.name.toLowerCase().endsWith('.pdf')
  );
}

function isPdfFile(file: File) {
  return (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  );
}

function isSupportedImageFile(file: File) {
  return (
    ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    /\.(jpe?g|png|webp)$/i.test(file.name)
  );
}

function pdfBlob(bytes: Uint8Array) {
  return new Blob([uint8ArrayToArrayBuffer(bytes)], {
    type: 'application/pdf'
  });
}

function arrayBufferForBytes(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }

  return bytes.slice().buffer;
}

function hexBytes(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function fullByteHash(bytes: Uint8Array) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${bytes.byteLength}:${(hash >>> 0).toString(16)}`;
}

function isPickerAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function localWindow() {
  return typeof window === 'undefined'
    ? ({} as LocalWindow)
    : (window as LocalWindow);
}
