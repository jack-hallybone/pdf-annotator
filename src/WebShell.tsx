import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderOpen } from 'lucide-react';
import {
  canPickLocalPdfFile,
  localPdfFileFromDrop,
  pickLocalPdfFile,
  savePdfToLocalFile
} from './localFileAccess';
import type { LocalPdfFileHandle } from './localFileAccess';
import { readPdfFile } from './pdfFile';
import {
  createPdfTemplate
} from './pdfTemplates';
import type { PdfTemplateKind } from './pdfTemplates';
import { PdfWorkspace } from './PdfWorkspace';
import type { PdfSaveTarget, PdfWorkspaceSource } from './PdfWorkspace';

const PDF_TEMPLATES: Array<{ kind: PdfTemplateKind; label: string }> = [
  { kind: 'a4Blank', label: 'A4 blank' },
  { kind: 'a4Lined', label: 'A4 lined' },
  { kind: 'a4Cornell', label: 'A4 Cornell' }
];

export function WebShell() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceIdRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [pdfDragActive, setPdfDragActive] = useState(false);
  const [source, setSource] = useState<PdfWorkspaceSource | null>(null);

  useEffect(() => {
    if (!source) {
      document.title = 'PDF Annotator';
    }
  }, [source]);

  async function handleOpenPdfRequest() {
    if (!canPickLocalPdfFile()) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const picked = await pickLocalPdfFile();
      if (!picked) {
        return;
      }

      await openPdfFile(picked.file, picked.handle);
    } catch (error) {
      console.error(error);
      fileInputRef.current?.click();
    }
  }

  async function openPdfFile(
    file: File,
    fileHandle: LocalPdfFileHandle | null = null
  ) {
    setBusy(true);
    try {
      const bytes = await readPdfFile(file);
      openPdfSource({
        bytes,
        name: file.name,
        saveTarget: fileHandle ? browserFileSaveTarget(fileHandle) : null
      });
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreatePdfTemplate(kind: PdfTemplateKind) {
    setBusy(true);
    try {
      const { bytes, name } = await createPdfTemplate(kind);
      openPdfSource({
        bytes,
        markDirty: true,
        name
      });
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await openPdfFile(file);
    } finally {
      event.target.value = '';
    }
  }

  function handlePdfDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setPdfDragActive(true);
  }

  function handlePdfDragOver(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setPdfDragActive(true);
  }

  function handlePdfDragLeave(event: React.DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }

    setPdfDragActive(false);
  }

  async function handlePdfDrop(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setPdfDragActive(false);

    const file = pdfFileFromList(event.dataTransfer.files);
    if (!file) {
      return;
    }

    try {
      const localFile = await localPdfFileFromDrop(event.dataTransfer);
      if (localFile) {
        await openPdfFile(localFile.file, localFile.handle);
        return;
      }
    } catch (error) {
      console.error(error);
    }

    await openPdfFile(file);
  }

  function openPdfSource({
    bytes,
    markDirty = false,
    name,
    saveTarget = null
  }: {
    bytes: Uint8Array;
    markDirty?: boolean;
    name: string;
    saveTarget?: PdfSaveTarget | null;
  }) {
    sourceIdRef.current += 1;
    setSource({
      bytes,
      markDirty,
      name,
      saveTarget,
      sourceId: `${sourceIdRef.current}:${name}`
    });
  }

  if (source) {
    return (
      <PdfWorkspace
        onClose={() => setSource(null)}
        source={source}
      />
    );
  }

  return (
    <main
      className="relative h-screen min-w-0 overflow-hidden bg-app-bg text-app-ink"
      onDragEnter={handlePdfDragEnter}
      onDragLeave={handlePdfDragLeave}
      onDragOver={handlePdfDragOver}
      onDrop={(event) => void handlePdfDrop(event)}
    >
      <input
        accept="application/pdf"
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />
      <section className="pdf-scroll-root h-full overflow-auto">
        <div className="grid h-full place-items-center px-4">
          <div className="screen-only flex w-[min(92vw,28rem)] flex-col items-center gap-8 text-app-ink">
            <h1 className="w-full">
              <img
                alt="PDF Annotator"
                className="mx-auto h-auto w-[min(80vw,24rem)]"
                src={`${import.meta.env.BASE_URL}title.svg`}
              />
            </h1>
            <div className="ui-frame w-full p-2">
              {pdfDragActive ? (
                <div
                  aria-live="polite"
                  className="grid min-h-36 place-items-center text-sm font-medium text-app-ink"
                >
                  Drop PDF to open
                </div>
              ) : (
                <div className="min-h-36">
                  <button
                    className="ui-button flex w-full items-center justify-center gap-3 px-5 py-4 text-base font-medium disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={busy}
                    onClick={() => void handleOpenPdfRequest()}
                    type="button"
                  >
                    <FolderOpen size={22} />
                    Open
                  </button>
                  <div className="mt-2 grid grid-cols-1 gap-1 border-t border-app-ink/12 pt-2 sm:grid-cols-3">
                    {PDF_TEMPLATES.map(({ kind, label }) => (
                      <button
                        className="ui-button flex min-h-16 flex-col items-center justify-center gap-2 px-3 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
                        disabled={busy}
                        key={kind}
                        onClick={() => void handleCreatePdfTemplate(kind)}
                        type="button"
                      >
                        <FilePlus2 size={18} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function isFileDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes('Files');
}

function pdfFileFromList(files: FileList) {
  return (
    Array.from(files).find(
      (file) =>
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf')
    ) ?? null
  );
}

function browserFileSaveTarget(
  fileHandle: LocalPdfFileHandle
): PdfSaveTarget {
  return {
    save: (bytes) => savePdfToLocalFile(fileHandle, bytes)
  };
}
