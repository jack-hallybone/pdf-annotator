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
  };

type LocalOpenFilePickerOptions = {
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  types?: Array<{
    accept: Record<string, string[]>;
    description?: string;
  }>;
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

export function canPickLocalPdfFile() {
  return typeof localWindow().showOpenFilePicker === 'function';
}

export async function pickLocalPdfFiles() {
  const picker = localWindow().showOpenFilePicker;
  if (!picker) {
    return [];
  }

  try {
    const handles = await picker(pdfPickerOptions);
    return localPdfFilesFromHandles(handles);
  } catch (error) {
    if (isPickerAbort(error)) {
      return [];
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
  bytes: Uint8Array
) {
  await requestReadWritePermission(handle);

  const writable = await createWritable(handle);
  let closed = false;
  try {
    await writable.write(pdfBlob(bytes));
    await writable.close();
    closed = true;
  } catch (error) {
    if (!closed) {
      await abortWritable(writable);
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

async function localPdfFilesFromHandles(handles: LocalPdfFileHandle[]) {
  const files = await Promise.all(
    handles.map(async (handle) => ({
      file: await handle.getFile(),
      handle
    }))
  );
  return files.filter(({ file }) => isPdfFile(file));
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

function pdfBlob(bytes: Uint8Array) {
  return new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' });
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function isPickerAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function localWindow() {
  return window as LocalWindow;
}
