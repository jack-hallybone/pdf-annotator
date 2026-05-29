import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderOpen } from 'lucide-react';
import {
  canPickLocalPdfFile,
  localPdfFileFromDrop,
  pickLocalPdfFile,
  savePdfToLocalFile
} from './localFileAccess';
import type { LocalPdfFileHandle } from './localFileAccess';
import {
  createPdfTemplate
} from './pdfTemplates';
import type { PdfTemplateKind } from './pdfTemplates';
import { PdfWorkspace, readPdfFile } from '../annotator';
import type { PdfSaveTarget, PdfWorkspaceSource } from '../annotator';

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
      className="webapp-landing"
      onDragEnter={handlePdfDragEnter}
      onDragLeave={handlePdfDragLeave}
      onDragOver={handlePdfDragOver}
      onDrop={(event) => void handlePdfDrop(event)}
    >
      <input
        accept="application/pdf"
        className="webapp-hidden-input"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />
      <section className="webapp-landing-scroll">
        <div className="webapp-landing-center">
          <div className="webapp-landing-panel">
            <h1 className="webapp-title">
              <img
                alt="PDF Annotator"
                className="webapp-title-image"
                src={`${import.meta.env.BASE_URL}title.svg`}
              />
            </h1>
            <div className="webapp-action-frame">
              {pdfDragActive ? (
                <div
                  aria-live="polite"
                  className="webapp-drop-message"
                >
                  Drop PDF to open
                </div>
              ) : (
                <div className="webapp-action-stack">
                  <button
                    className="webapp-open-button"
                    disabled={busy}
                    onClick={() => void handleOpenPdfRequest()}
                    type="button"
                  >
                    <FolderOpen size={22} />
                    Open
                  </button>
                  <div className="webapp-template-grid">
                    {PDF_TEMPLATES.map(({ kind, label }) => (
                      <button
                        className="webapp-template-button"
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
