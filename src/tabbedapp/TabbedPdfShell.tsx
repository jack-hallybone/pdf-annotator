import {
  Fragment,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  ChangeEvent as ReactChangeEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  RefCallback
} from 'react';
import {
  ChevronsRight,
  Copy,
  Download,
  File,
  FileText,
  FolderOpen,
  Home,
  Layers,
  Pencil,
  Plus,
  Printer,
  Save,
  SaveAll,
  X
} from 'lucide-react';
import type { PdfHostAdapter, PdfHostDocument } from './fileHost';
import {
  attachPdfSourceId,
  PdfWorkspace
} from '../annotator';
import type {
  PdfAnnotation,
  PdfWorkspaceHandle,
  PdfWorkspaceProps,
  SensitivePdfWorkspaceSession,
  PdfWorkspaceSourceInput,
  PdfWorkspaceSource
} from '../annotator';
import {
  CORNELL_CONTENT_BOUNDS,
  createPdfTemplate
} from '../pdfTemplates';
import type { PdfTemplateKind } from '../pdfTemplates';
import { warmPdfRuntimeCaches } from '../pdfRuntime';
import { appThemeStyle } from '../theme';
import type { AppTheme } from '../theme';

export type TabbedPdfTemplateAction = {
  kind: PdfTemplateKind;
  label: string;
  renderIcon: (size: number) => ReactNode;
};

export type TabbedPdfMenuAction = {
  label: string;
  onSelect: () => Promise<void> | void;
  renderIcon: (size: number) => ReactNode;
};

const TEMPLATE_ACTIONS: TabbedPdfTemplateAction[] = [
  {
    kind: 'a4Blank',
    label: 'New Blank A4',
    renderIcon: (size) => <File size={size} />
  },
  {
    kind: 'a4Lined',
    label: 'New Lined A4',
    renderIcon: (size) => <FileText size={size} />
  },
  {
    kind: 'a4Cornell',
    label: 'New A4 Cornell',
    renderIcon: (size) => <CornellTemplateIcon size={size} />
  }
];

type TabbedPdfDocument = {
  fileKey?: string;
  hasUnsavedChanges: boolean;
  id: string;
  readOnly?: boolean;
  readOnlyMessage?: string;
  session: SensitivePdfWorkspaceSession | null;
  source: PdfWorkspaceSource;
  title: string;
};

export type TabbedPdfDocumentSummary = {
  active: boolean;
  fileKey?: string;
  hasUnsavedChanges: boolean;
  id: string;
  title: string;
};

export type TabbedPdfCloseDocumentsRequest = {
  canSaveChanges: boolean;
  dirtyCount: number;
  documents: TabbedPdfDocumentSummary[];
};

type CloseDocumentsDecision = 'cancel' | 'discard' | 'save';

type SessionUpdate = {
  documentId: string;
  session: SensitivePdfWorkspaceSession;
};

type TabContextMenuState = {
  documentId: string;
  x: number;
  y: number;
};

type TabDragState = {
  draggedId: string;
  placement: 'before' | 'after';
  targetId: string;
};

type MenuPosition = {
  x: number;
  y: number;
};

type CloseConfirmationState = TabbedPdfCloseDocumentsRequest & {
  requestId: number;
};

type RenameDialogState = {
  documentId: string;
  value: string;
};

export type TabbedPdfWorkspaceOptions = Pick<
  PdfWorkspaceProps,
  | 'allowEditing'
  | 'allowImageAnnotations'
  | 'confirmDiscardChanges'
  | 'onOpenExternalLink'
  | 'pickImageFile'
  | 'pickMergePdfFile'
  | 'printTarget'
>;

export type TabbedPdfHomeRenderProps = {
  createTemplateDocument: (kind: PdfTemplateKind) => Promise<void>;
  dragActive: boolean;
  openPdfDocuments: () => Promise<void>;
  templateActions: TabbedPdfTemplateAction[];
};

export type TabbedPdfShellHandle = {
  closeAllDocuments: () => Promise<boolean>;
  confirmWindowClose: () => Promise<boolean>;
  focusHome: () => void;
  getDocuments: () => TabbedPdfDocumentSummary[];
  openDocument: (document: PdfHostDocument) => void;
  openDocuments: (documents: PdfHostDocument[]) => void;
  openSource: (
    source: PdfWorkspaceSourceInput,
    options?: { fileKey?: string; title?: string }
  ) => void;
};

export type TabbedPdfShellProps = {
  className?: string;
  confirmCloseDocuments?: (
    request: TabbedPdfCloseDocumentsRequest
  ) => boolean | Promise<boolean>;
  enableCloseTabShortcut?: boolean;
  fileAdapter: PdfHostAdapter;
  initialDocuments?: PdfHostDocument[];
  newTabMenuActions?: TabbedPdfMenuAction[];
  onDocumentsChange?: (documents: TabbedPdfDocumentSummary[]) => void;
  renderHome?: (props: TabbedPdfHomeRenderProps) => ReactNode;
  theme?: AppTheme;
  workspaceOptions?: TabbedPdfWorkspaceOptions;
};

const DEFAULT_WORKSPACE_OPTIONS: TabbedPdfWorkspaceOptions = {};

export const TabbedPdfShell = forwardRef<
  TabbedPdfShellHandle,
  TabbedPdfShellProps
>(function TabbedPdfShell({
  className,
  confirmCloseDocuments,
  enableCloseTabShortcut = false,
  fileAdapter,
  initialDocuments = [],
  newTabMenuActions = [],
  onDocumentsChange,
  renderHome,
  theme,
  workspaceOptions = DEFAULT_WORKSPACE_OPTIONS
}: TabbedPdfShellProps, ref) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialDocumentsOpenedRef = useRef(false);
  const nextDocumentIdRef = useRef(0);
  const workspaceRefs = useRef(new Map<string, PdfWorkspaceHandle>());
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<TabbedPdfDocument[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [newTabMenuPosition, setNewTabMenuPosition] = useState<MenuPosition>({
    x: 0,
    y: 0
  });
  const [tabDragState, setTabDragState] = useState<TabDragState | null>(null);
  const [tabContextMenu, setTabContextMenu] =
    useState<TabContextMenuState | null>(null);
  const [closeConfirmation, setCloseConfirmation] =
    useState<CloseConfirmationState | null>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(
    null
  );
  const [busyDocumentIds, setBusyDocumentIds] = useState<Set<string>>(
    () => new Set()
  );
  const [shellCommandBusy, setShellCommandBusy] = useState(false);
  const activeDocumentIdRef = useLatestRef(activeDocumentId);
  const activeWorkspaceBusy =
    activeDocumentId !== null && busyDocumentIds.has(activeDocumentId);
  const shellLocked = shellCommandBusy || activeWorkspaceBusy;
  const shellLockedRef = useLatestRef(shellLocked);
  const shellStyle = useMemo(
    () => appThemeStyle(theme) as CSSProperties,
    [theme]
  );
  const closeConfirmationResolverRef = useRef<
    ((decision: CloseDocumentsDecision) => void) | null
  >(null);
  const documentsRef = useLatestRef(documents);
  const nextCloseConfirmationIdRef = useRef(0);
  const pendingHostDocumentsRef = useRef<PdfHostDocument[]>([]);

  function visibleDocumentIds() {
    return activeDocumentIdRef.current ? [activeDocumentIdRef.current] : [];
  }

  function documentSummaries(): TabbedPdfDocumentSummary[] {
    return documentSummariesFor(documentsRef.current);
  }

  function documentSummariesFor(
    sourceDocuments: TabbedPdfDocument[],
    dirtyDocumentIds?: Set<string>
  ): TabbedPdfDocumentSummary[] {
    const activeId = activeDocumentIdRef.current;
    return sourceDocuments.map((document) => ({
      active: document.id === activeId,
      fileKey: document.fileKey,
      hasUnsavedChanges:
        dirtyDocumentIds?.has(document.id) ?? document.hasUnsavedChanges,
      id: document.id,
      title: document.title
    }));
  }

  async function confirmDocumentClose(
    closingDocuments: TabbedPdfDocument[],
    dirtyCount: number,
    dirtyDocumentIds?: Set<string>,
    canSaveChanges = false
  ) {
    if (dirtyCount === 0) {
      return 'discard' as const;
    }

    const request = {
      canSaveChanges,
      dirtyCount,
      documents: documentSummariesFor(closingDocuments, dirtyDocumentIds)
    };

    if (confirmCloseDocuments) {
      try {
        return (await confirmCloseDocuments(request)) ? 'discard' : 'cancel';
      } catch (error) {
        console.error(error);
        return 'cancel' as const;
      }
    }

    return requestCloseConfirmation(request);
  }

  function requestCloseConfirmation(request: TabbedPdfCloseDocumentsRequest) {
    closeConfirmationResolverRef.current?.('cancel');
    return new Promise<CloseDocumentsDecision>((resolve) => {
      closeConfirmationResolverRef.current = resolve;
      nextCloseConfirmationIdRef.current += 1;
      setCloseConfirmation({
        ...request,
        requestId: nextCloseConfirmationIdRef.current
      });
    });
  }

  function resolveCloseConfirmation(decision: CloseDocumentsDecision) {
    closeConfirmationResolverRef.current?.(decision);
    closeConfirmationResolverRef.current = null;
    setCloseConfirmation(null);
  }

  function cancelCloseConfirmation() {
    if (!closeConfirmationResolverRef.current) {
      setCloseConfirmation(null);
      return;
    }

    resolveCloseConfirmation('cancel');
  }

  useImperativeHandle(ref, () => ({
    closeAllDocuments,
    confirmWindowClose,
    focusHome: selectHome,
    getDocuments: documentSummaries,
    openDocument: (document) => openImperativeDocuments([document]),
    openDocuments: openImperativeDocuments,
    openSource: (source, options = {}) =>
      openImperativeDocuments([
        {
          fileKey: options.fileKey,
          source,
          title: options.title
        }
      ])
  }));

  useEffect(() => {
    if (shellLocked || pendingHostDocumentsRef.current.length === 0) {
      return;
    }

    const pendingDocuments = pendingHostDocumentsRef.current.splice(0);
    openHostDocuments(pendingDocuments);
  }, [shellLocked]);

  useEffect(() => {
    if (initialDocumentsOpenedRef.current || initialDocuments.length === 0) {
      return;
    }

    initialDocumentsOpenedRef.current = true;
    openHostDocuments(initialDocuments);
  }, [initialDocuments]);

  useEffect(
    () => () => {
      closeConfirmationResolverRef.current?.('cancel');
      closeConfirmationResolverRef.current = null;
    },
    []
  );

  useEffect(() => {
    onDocumentsChange?.(documentSummaries());
  }, [activeDocumentId, documents, onDocumentsChange]);

  useEffect(() => {
    if (!enableCloseTabShortcut) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 'w'
      ) {
        return;
      }

      const activeDocumentId = activeDocumentIdRef.current;
      if (!activeDocumentId) {
        return;
      }

      event.preventDefault();
      void closeDocument(activeDocumentId);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enableCloseTabShortcut]);

  useEffect(() => {
    document.title = documents.some((document) => document.hasUnsavedChanges)
      ? '*PDF Annotator'
      : 'PDF Annotator';
  }, [documents]);

  useEffect(() => {
    if (
      tabContextMenu &&
      !documents.some((document) => document.id === tabContextMenu.documentId)
    ) {
      setTabContextMenu(null);
    }
  }, [documents, tabContextMenu]);

  useEffect(() => {
    if (
      renameDialog &&
      !documents.some((document) => document.id === renameDialog.documentId)
    ) {
      setRenameDialog(null);
    }
  }, [documents, renameDialog]);

  useEffect(() => {
    if (!tabContextMenu) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('.tabbedapp-tab-context-menu')
      ) {
        return;
      }

      setTabContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setTabContextMenu(null);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeTabContextMenu);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeTabContextMenu);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    if (!newTabMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('.tabbedapp-tabbar-actions')
      ) {
        return;
      }

      setNewTabMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setNewTabMenuOpen(false);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeNewTabMenu);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeNewTabMenu);
    };
  }, [newTabMenuOpen]);

  const updateDocumentDirtyState = useCallback(
    (documentId: string, hasUnsavedChanges: boolean) => {
      setDocuments((current) =>
        current.map((document) =>
          document.id === documentId
            ? { ...document, hasUnsavedChanges }
            : document
        )
      );
    },
    []
  );

  const updateDocumentTitle = useCallback((documentId: string, title: string) => {
    const cleanedTitle = cleanWorkspaceTitle(title);
    if (!cleanedTitle || cleanedTitle === 'PDF Annotator') {
      return;
    }

    setDocuments((current) =>
      current.map((document) =>
        document.id === documentId
          ? { ...document, title: cleanedTitle }
          : document
      )
    );
  }, []);

  const registerWorkspaceRef = useCallback(
    (documentId: string): RefCallback<PdfWorkspaceHandle> =>
      (handle) => {
        if (handle) {
          workspaceRefs.current.set(documentId, handle);
        } else {
          workspaceRefs.current.delete(documentId);
        }
      },
    []
  );

  const handleWorkspaceBusyChange = useCallback(
    (documentId: string, busy: boolean) => {
      setBusyDocumentIds((current) => {
        const isCurrentlyBusy = current.has(documentId);
        if (isCurrentlyBusy === busy) {
          return current;
        }

        const next = new Set(current);
        if (busy) {
          next.add(documentId);
        } else {
          next.delete(documentId);
        }
        return next;
      });
    },
    []
  );

  async function runShellLockedTask<T>(task: () => Promise<T>) {
    if (shellLockedRef.current) {
      return null;
    }

    setShellCommandBusy(true);
    try {
      return await task();
    } finally {
      setShellCommandBusy(false);
    }
  }

  function captureMountedSessions(documentIds = visibleDocumentIds()) {
    const updates: SessionUpdate[] = [];
    for (const documentId of new Set(documentIds)) {
      const session =
        workspaceRefs.current.get(documentId)?.captureSessionForTabCache();
      if (session) {
        updates.push({ documentId, session });
      }
    }

    if (updates.length > 0) {
      const updatesByDocumentId = new Map(
        updates.map((update) => [update.documentId, update.session])
      );
      setDocuments((current) =>
        current.map((document) => {
          const session = updatesByDocumentId.get(document.id);
          return session && session.sourceId === document.source.sourceId
            ? applySessionToDocument(document, session)
            : document;
        })
      );
    }

    return updates;
  }

  function releaseDocumentsLeavingView(nextVisibleIds: string[]) {
    const nextVisibleIdSet = new Set(nextVisibleIds);
    const currentVisibleId = activeDocumentIdRef.current;
    if (currentVisibleId && !nextVisibleIdSet.has(currentVisibleId)) {
      releaseWorkspaceResources(currentVisibleId);
    }
  }

  function releaseWorkspaceResources(documentId: string) {
    const handle = workspaceRefs.current.get(documentId);
    if (!handle) {
      return;
    }

    workspaceRefs.current.delete(documentId);
    handleWorkspaceBusyChange(documentId, false);
    window.setTimeout(() => {
      void handle.releaseRenderResources().catch(console.error);
    }, 0);
  }

  function handleFileInputChange(event: ReactChangeEvent<HTMLInputElement>) {
    if (shellLockedRef.current) {
      event.target.value = '';
      return;
    }

    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    openHostDocuments(fileAdapter.pdfDocumentsFromFileInput?.(files) ?? []);
  }

  function openTabbedDocuments(openedDocuments: TabbedPdfDocument[]) {
    if (shellLockedRef.current) {
      return;
    }

    const firstOpenedId = openedDocuments[0]?.id ?? null;
    if (!firstOpenedId) {
      return;
    }

    captureMountedSessions();
    releaseDocumentsLeavingView([firstOpenedId]);
    setDocuments((current) => [...current, ...openedDocuments]);
    setActiveDocumentId(firstOpenedId);
  }

  function openGeneratedDocument(sourceInput: PdfWorkspaceSourceInput) {
    const id = nextDocumentId(sourceInput.name, nextDocumentIdRef);
    const sourceWithHostTargets = {
      ...sourceInput,
      downloadTarget:
        sourceInput.downloadTarget ?? fileAdapter.downloadTarget ?? null,
      fileKey: sourceInput.fileKey,
      saveAsTarget: sourceInput.saveAsTarget ?? fileAdapter.saveAsTarget ?? null
    };
    openTabbedDocuments([
      {
        hasUnsavedChanges: Boolean(
          sourceWithHostTargets.markDirty ||
            sourceWithHostTargets.initialAnnotations?.length
        ),
        id,
        session: null,
        source: attachPdfSourceId(sourceWithHostTargets, id),
        title: sourceWithHostTargets.name
      }
    ]);
  }

  function openImperativeDocuments(hostDocuments: PdfHostDocument[]) {
    if (shellLockedRef.current) {
      pendingHostDocumentsRef.current.push(...hostDocuments);
      return;
    }

    openHostDocuments(hostDocuments);
  }

  function openHostDocuments(hostDocuments: PdfHostDocument[]) {
    if (shellLockedRef.current) {
      return;
    }

    warmPdfRuntimeCaches();

    if (hostDocuments.length === 0) {
      return;
    }

    const existingDocumentsByFileKey = new Map(
      documentsRef.current
        .filter((document) => document.fileKey)
        .map((document) => [document.fileKey, document])
    );
    const newDocuments: PdfHostDocument[] = [];
    const seenNewFileKeys = new Set<string>();
    let firstDuplicateDocumentId: string | null = null;
    for (const document of hostDocuments) {
      const fileKey = document.fileKey;
      if (!fileKey) {
        newDocuments.push(document);
        continue;
      }

      const duplicateDocument = existingDocumentsByFileKey.get(fileKey);
      if (duplicateDocument) {
        firstDuplicateDocumentId ??= duplicateDocument.id;
        continue;
      }

      if (!seenNewFileKeys.has(fileKey)) {
        seenNewFileKeys.add(fileKey);
        newDocuments.push(document);
      }
    }

    if (newDocuments.length === 0) {
      if (firstDuplicateDocumentId) {
        selectDocument(firstDuplicateDocumentId);
      }
      return;
    }

    const openedDocuments = newDocuments.map(
      ({ fileKey, readOnly, readOnlyMessage, source, title }) => {
        const id = nextDocumentId(source.name, nextDocumentIdRef);
        const sourceWithHostTargets = {
          ...source,
          downloadTarget:
            source.downloadTarget ?? fileAdapter.downloadTarget ?? null,
          fileKey: source.fileKey ?? fileKey,
          saveAsTarget: source.saveAsTarget ?? fileAdapter.saveAsTarget ?? null
        };
        return {
          fileKey,
          hasUnsavedChanges: Boolean(
            sourceWithHostTargets.markDirty ||
              sourceWithHostTargets.initialAnnotations?.length
          ),
          id,
          readOnly,
          readOnlyMessage,
          session: null,
          source: attachPdfSourceId(sourceWithHostTargets, id),
          title: title ?? sourceWithHostTargets.name
        };
      }
    );

    openTabbedDocuments(openedDocuments);
  }

  function selectHome() {
    if (shellLockedRef.current || activeDocumentIdRef.current === null) {
      return;
    }

    captureMountedSessions();
    releaseDocumentsLeavingView([]);
    setActiveDocumentId(null);
  }

  function selectDocument(documentId: string) {
    if (shellLockedRef.current || activeDocumentIdRef.current === documentId) {
      return;
    }

    captureMountedSessions();
    releaseDocumentsLeavingView([documentId]);
    setActiveDocumentId(documentId);
  }

  async function closeDocument(
    documentId: string,
    { skipConfirm = false }: { skipConfirm?: boolean } = {}
  ) {
    if (shellLockedRef.current) {
      return false;
    }

    const session =
      workspaceRefs.current.get(documentId)?.captureSessionForTabCache();
    const currentDocuments = documentsRef.current;
    const documentIndex = currentDocuments.findIndex(
      (item) => item.id === documentId
    );
    const document = currentDocuments[documentIndex];
    if (!document) {
      return true;
    }
    const hasUnsavedChanges =
      session?.hasUnsavedChanges ?? document?.hasUnsavedChanges ?? false;

    if (hasUnsavedChanges && !skipConfirm) {
      const decision = await confirmDocumentClose(
        [document],
        1,
        new Set([document.id]),
        canSaveClosingDocuments([document], 1)
      );
      if (decision === 'cancel') {
        return false;
      }
      if (
        decision === 'save' &&
        !(await saveDocumentBeforeClose(document.id))
      ) {
        return false;
      }
    }

    const latestDocuments = documentsRef.current;
    const latestDocumentIndex = latestDocuments.findIndex(
      (item) => item.id === documentId
    );
    if (latestDocumentIndex < 0) {
      return true;
    }

    const remainingDocuments = latestDocuments.filter(
      (item) => item.id !== documentId
    );
    const activeId = activeDocumentIdRef.current;
    const nextActiveId =
      activeId === documentId
        ? remainingDocuments[
            Math.min(
              Math.max(latestDocumentIndex, 0),
              remainingDocuments.length - 1
            )
          ]?.id ?? null
        : activeId;

    setDocuments(remainingDocuments);
    setActiveDocumentId(nextActiveId);
    releaseWorkspaceResources(documentId);
    return true;
  }

  async function closeDocumentGroup(
    documentIds: string[],
    focusFallbackId: string
  ) {
    if (shellLockedRef.current) {
      return false;
    }

    const uniqueDocumentIds = new Set(documentIds);
    if (uniqueDocumentIds.size === 0) {
      return true;
    }

    const mountedSessionUpdates = captureMountedSessions();
    const sessionsByDocumentId = new Map(
      mountedSessionUpdates.map((update) => [update.documentId, update.session])
    );
    const currentDocuments = documentsRef.current;
    const closingDocuments = currentDocuments.filter((document) =>
      uniqueDocumentIds.has(document.id)
    );

    if (closingDocuments.length === 0) {
      return true;
    }

    const dirtyClosingDocumentIds = new Set<string>();
    const dirtyClosingCount = closingDocuments.filter((document) => {
      const session = sessionsByDocumentId.get(document.id);
      const hasUnsavedChanges =
        session?.hasUnsavedChanges ?? document.hasUnsavedChanges;
      if (hasUnsavedChanges) {
        dirtyClosingDocumentIds.add(document.id);
      }
      return hasUnsavedChanges;
    }).length;

    if (dirtyClosingCount > 0) {
      const decision = await confirmDocumentClose(
        closingDocuments,
        dirtyClosingCount,
        dirtyClosingDocumentIds,
        canSaveClosingDocuments(closingDocuments, dirtyClosingCount)
      );
      if (decision === 'cancel') {
        return false;
      }
      if (
        decision === 'save' &&
        !(await saveDocumentBeforeClose(closingDocuments[0].id))
      ) {
        return false;
      }
    }

    const latestDocuments = documentsRef.current;
    const remainingDocuments = latestDocuments
      .filter((document) => !uniqueDocumentIds.has(document.id))
      .map((document) => {
        const session = sessionsByDocumentId.get(document.id);
        return session && session.sourceId === document.source.sourceId
          ? applySessionToDocument(document, session)
          : document;
      });
    const activeId = activeDocumentIdRef.current;
    const nextActiveId =
      activeId && !uniqueDocumentIds.has(activeId)
        ? activeId
        : remainingDocuments.some((document) => document.id === focusFallbackId)
          ? focusFallbackId
          : remainingDocuments[0]?.id ?? null;

    setDocuments(remainingDocuments);
    setActiveDocumentId(nextActiveId);

    for (const documentId of uniqueDocumentIds) {
      releaseWorkspaceResources(documentId);
    }

    return true;
  }

  function canSaveClosingDocuments(
    closingDocuments: TabbedPdfDocument[],
    dirtyCount: number
  ) {
    if (closingDocuments.length !== 1 || dirtyCount !== 1) {
      return false;
    }

    const documentId = closingDocuments[0].id;
    return (
      activeDocumentIdRef.current === documentId &&
      Boolean(workspaceRefs.current.get(documentId))
    );
  }

  async function saveDocumentBeforeClose(documentId: string) {
    const handle = workspaceRefs.current.get(documentId);
    if (!handle) {
      return false;
    }

    return (await runShellLockedTask(() => handle.save())) === true;
  }

  async function closeAllDocuments() {
    const documentIds = documentsRef.current.map((document) => document.id);
    if (documentIds.length === 0) {
      return true;
    }

    return closeDocumentGroup(
      documentIds,
      activeDocumentIdRef.current ?? documentIds[0]
    );
  }

  async function confirmWindowClose() {
    if (shellLockedRef.current) {
      return false;
    }

    const currentDocuments = documentsRef.current;
    const dirtyDocuments = currentDocuments.filter(
      (document) => document.hasUnsavedChanges
    );
    if (dirtyDocuments.length === 0) {
      return true;
    }

    const dirtyDocumentIds = new Set(
      dirtyDocuments.map((document) => document.id)
    );
    const decision = await confirmDocumentClose(
      dirtyDocuments,
      dirtyDocuments.length,
      dirtyDocumentIds,
      canSaveClosingDocuments(dirtyDocuments, dirtyDocuments.length)
    );

    if (decision === 'cancel') {
      return false;
    }
    if (decision === 'save') {
      return saveDocumentBeforeClose(dirtyDocuments[0].id);
    }

    return true;
  }

  function openTabContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    documentId: string
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    const position = clampContextMenuPosition(event.clientX, event.clientY);
    setTabContextMenu({
      documentId,
      x: position.x,
      y: position.y
    });
  }

  function closeTabContextMenu() {
    setTabContextMenu(null);
  }

  function closeNewTabMenu() {
    setNewTabMenuOpen(false);
  }

  function toggleNewTabMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    if (newTabMenuOpen) {
      setNewTabMenuOpen(false);
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    setNewTabMenuPosition(
      clampMenuPosition(bounds.left, bounds.bottom + 4, 220, 150)
    );
    setNewTabMenuOpen(true);
  }

  async function copyTabFilename(documentId: string) {
    const document = documentsRef.current.find((item) => item.id === documentId);
    if (!document) {
      return;
    }

    const stem = filenameStem(document.title);
    try {
      await navigator.clipboard.writeText(stem);
    } catch (error) {
      console.error(error);
    } finally {
      closeTabContextMenu();
    }
  }

  function openRenameDialog(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    const document = documentsRef.current.find((item) => item.id === documentId);
    if (!document) {
      return;
    }

    closeTabContextMenu();
    setRenameDialog({
      documentId,
      value: filenameStem(document.title)
    });
  }

  async function submitRenameDialog() {
    if (!renameDialog || shellLockedRef.current) {
      return;
    }

    const workspace = workspaceRefs.current.get(renameDialog.documentId);
    if (!workspace) {
      setRenameDialog(null);
      return;
    }

    const nextName = pdfFileNameFromStem(renameDialog.value);
    if (!nextName) {
      return;
    }

    const saved = await runShellLockedTask(() => workspace.saveAs(nextName));
    if (saved) {
      setRenameDialog(null);
    }
  }

  async function runWorkspaceCommand(
    documentId: string,
    command: 'downloadCopy' | 'print' | 'save' | 'saveAs'
  ) {
    const workspace = workspaceRefs.current.get(documentId);
    closeTabContextMenu();
    if (!workspace || shellLockedRef.current) {
      return;
    }

    await runShellLockedTask(async () => {
      await workspace[command]();
    });
  }

  async function createTemplateDocument(kind: PdfTemplateKind) {
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    try {
      const { bytes } = await createPdfTemplate(kind);
      openGeneratedDocument({
        bytes,
        markDirty: true,
        name: 'Untitled.pdf'
      });
    } catch (error) {
      console.error(error);
    }
  }

  async function createCornellNoteForDocument(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    const document = documentsRef.current.find((item) => item.id === documentId);
    if (!document) {
      return;
    }

    try {
      const noteTitle = cornellNoteStem(filenameStem(document.title));
      const { bytes } = await createPdfTemplate('a4Cornell');
      openGeneratedDocument({
        bytes,
        initialAnnotations: [cornellTitleAnnotation(noteTitle)],
        markDirty: true,
        name: `${noteTitle}.pdf`
      });
    } catch (error) {
      console.error(error);
    }
  }

  function closeOtherTabs(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    void closeDocumentGroup(
      documentsRef.current
        .filter((document) => document.id !== documentId)
        .map((document) => document.id),
      documentId
    );
  }

  function closeCurrentTab(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    void closeDocument(documentId);
  }

  function closeEveryTab() {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    void closeAllDocuments();
  }

  function closeTabsToRight(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    const documentIndex = documentsRef.current.findIndex(
      (document) => document.id === documentId
    );
    if (documentIndex < 0) {
      return;
    }

    void closeDocumentGroup(
      documentsRef.current
        .slice(documentIndex + 1)
        .map((document) => document.id),
      documentId
    );
  }

  function closeTabOnMiddleClick(
    event: ReactMouseEvent<HTMLElement>,
    documentId: string
  ) {
    if (event.button !== 1) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    closeNewTabMenu();
    void closeDocument(documentId);
  }

  function suppressMiddleClickAutoscroll(event: ReactMouseEvent<HTMLElement>) {
    if (event.button === 1) {
      event.preventDefault();
    }
  }

  function startTabDrag(
    event: ReactDragEvent<HTMLElement>,
    documentId: string
  ) {
    if (shellLockedRef.current) {
      event.preventDefault();
      return;
    }

    if (
      event.target instanceof Element &&
      event.target.closest('.tabbedapp-tab-close')
    ) {
      event.preventDefault();
      return;
    }

    closeTabContextMenu();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', documentId);
    setTabDragState({
      draggedId: documentId,
      placement: 'after',
      targetId: documentId
    });
  }

  function updateTabDragTarget(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    updateTabDragPosition(event.clientX);
  }

  function updateTabDragPosition(clientX: number) {
    if (!tabDragState) {
      return;
    }

    const tabElements = Array.from(
      document.querySelectorAll<HTMLElement>('[data-tabbedapp-tab-id]')
    );
    let targetId = tabDragState.targetId;
    let placement = tabDragState.placement;

    for (const tabElement of tabElements) {
      const tabId = tabElement.dataset.tabbedappTabId;
      if (!tabId) {
        continue;
      }

      const bounds = tabElement.getBoundingClientRect();
      if (clientX < bounds.left) {
        targetId = tabId;
        placement = 'before';
        break;
      }

      if (clientX <= bounds.right) {
        targetId = tabId;
        placement =
          clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
        break;
      }

      targetId = tabId;
      placement = 'after';
    }

    if (
      tabDragState.targetId !== targetId ||
      tabDragState.placement !== placement
    ) {
      setTabDragState({
        draggedId: tabDragState.draggedId,
        placement,
        targetId
      });
    }
  }

  function dropTab(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    reorderDocuments(
      tabDragState.draggedId,
      tabDragState.targetId,
      tabDragState.placement
    );
    setTabDragState(null);
  }

  function handleTabbarDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateTabDragPosition(event.clientX);
  }

  function handleTabbarDrop(event: ReactDragEvent<HTMLElement>) {
    if (!tabDragState) {
      return;
    }

    event.preventDefault();
    setTabDragState(null);
  }

  function finishTabDrag() {
    setTabDragState(null);
  }

  function reorderDocuments(
    draggedId: string,
    targetId: string,
    placement: 'before' | 'after'
  ) {
    if (draggedId === targetId) {
      return;
    }

    setDocuments((current) => {
      const fromIndex = current.findIndex(
        (document) => document.id === draggedId
      );
      const targetIndex = current.findIndex(
        (document) => document.id === targetId
      );
      if (fromIndex < 0 || targetIndex < 0) {
        return current;
      }

      const nextDocuments = [...current];
      const [draggedDocument] = nextDocuments.splice(fromIndex, 1);
      let insertIndex = targetIndex + (placement === 'after' ? 1 : 0);
      if (fromIndex < insertIndex) {
        insertIndex -= 1;
      }

      nextDocuments.splice(insertIndex, 0, draggedDocument);
      return nextDocuments;
    });
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (shellLockedRef.current) {
      return;
    }

    if (!canOpenDroppedFiles(fileAdapter) || !isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setDragActive(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    if (shellLockedRef.current) {
      return;
    }

    if (!canOpenDroppedFiles(fileAdapter) || !isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }

    setDragActive(false);
  }

  async function handleDrop(event: ReactDragEvent<HTMLElement>) {
    if (shellLockedRef.current) {
      return;
    }

    if (!canOpenDroppedFiles(fileAdapter) || !isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setDragActive(false);

    try {
      const documents =
        (await fileAdapter.pdfDocumentsFromDrop?.(event.dataTransfer)) ??
        fileAdapter.pdfDocumentsFromFileInput?.(
          Array.from(event.dataTransfer.files)
        ) ??
        [];
      if (documents.length > 0) {
        cancelCloseConfirmation();
        openHostDocuments(documents);
        return;
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function handleOpenPdfRequest() {
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    warmPdfRuntimeCaches({ immediate: true });

    try {
      const result = await fileAdapter.pickPdfDocuments();
      if (result.documents.length > 0) {
        openHostDocuments(result.documents);
        return;
      }

      if (result.useFileInputFallback && fileAdapter.fileInput) {
        fileInputRef.current?.click();
      }
    } catch (error) {
      console.error(error);
      if (fileAdapter.fileInput) {
        fileInputRef.current?.click();
      }
    }
  }

  async function runNewTabMenuAction(action: TabbedPdfMenuAction) {
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    try {
      await action.onSelect();
    } catch (error) {
      console.error(error);
    }
  }

  const activeDocument = documents.find(
    (document) => document.id === activeDocumentId
  );
  const tabContextMenuDocument = tabContextMenu
    ? documents.find((document) => document.id === tabContextMenu.documentId)
    : null;
  const tabContextMenuIndex = tabContextMenuDocument
    ? documents.findIndex((document) => document.id === tabContextMenuDocument.id)
    : -1;
  const tabContextMenuWorkspaceAvailable = Boolean(
    tabContextMenuDocument &&
      tabContextMenuDocument.id === activeDocumentId &&
      workspaceRefs.current.has(tabContextMenuDocument.id)
  );
  const currentPrintTarget =
    workspaceOptions.printTarget ?? fileAdapter.printTarget ?? null;
  const currentMergePdfPicker =
    workspaceOptions.pickMergePdfFile ??
    fileAdapter.pickMergePdfFile ??
    undefined;
  const tabContextMenuCanSave = tabContextMenuDocument
    ? documentCanSave(tabContextMenuDocument)
    : false;
  const tabContextMenuCanSaveAs = tabContextMenuDocument
    ? documentCanSaveAs(tabContextMenuDocument)
    : false;
  const tabContextMenuCanDownload = tabContextMenuDocument
    ? documentCanDownload(tabContextMenuDocument)
    : false;
  const tabContextMenuCanPrint = Boolean(currentPrintTarget);
  const tabSeparatorClass = (
    leftId: 'home' | string,
    rightId: string | null
  ) => {
    const isDropTarget =
      tabDragState?.placement === 'before'
        ? rightId === tabDragState.targetId
        : leftId === tabDragState?.targetId;
    const isBesideActiveTab =
      (leftId === 'home'
        ? activeDocumentId === null
        : activeDocumentId === leftId) ||
      (rightId !== null && activeDocumentId === rightId);

    return [
      'tabbedapp-tab-separator',
      !isDropTarget && (rightId === null || isBesideActiveTab)
        ? 'tabbedapp-tab-separator-hidden'
        : '',
      isDropTarget ? 'tabbedapp-tab-separator-drop' : ''
    ]
      .filter(Boolean)
      .join(' ');
  };
  const homeProps = {
    createTemplateDocument,
    dragActive,
    openPdfDocuments: handleOpenPdfRequest,
    templateActions: TEMPLATE_ACTIONS
  };
  const showDropPanel = dragActive && Boolean(activeDocument);

  return (
    <main
      className={['tabbedapp-shell', className].filter(Boolean).join(' ')}
      data-busy={shellLocked ? 'true' : 'false'}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(event) => void handleDrop(event)}
      style={shellStyle}
    >
      {fileAdapter.fileInput &&
      fileAdapter.pdfDocumentsFromFileInput ? (
        <input
          accept={fileAdapter.fileInput.accept}
          className="tabbedapp-hidden-input"
          multiple={fileAdapter.fileInput.multiple ?? true}
          onChange={handleFileInputChange}
          ref={fileInputRef}
          type="file"
        />
      ) : null}

      <header
        className={`tabbedapp-tabbar ${
          tabDragState ? 'tabbedapp-tabbar-dragging' : ''
        }`}
        onDragOver={handleTabbarDragOver}
        onDrop={handleTabbarDrop}
      >
        <button
          aria-label="Home"
          aria-pressed={activeDocumentId === null}
          className={`tabbedapp-home-tab tabbedapp-tab-button ${
            activeDocumentId === null ? 'tabbedapp-tab-button-active' : ''
          }`}
          disabled={shellLocked}
          onClick={selectHome}
          title="Home"
          type="button"
        >
          <Home size={18} />
        </button>
        <nav aria-label="Open PDFs" className="tabbedapp-tabs">
          {documents.map((document, index) => (
            <Fragment key={document.id}>
              <span
                aria-hidden="true"
                className={tabSeparatorClass(
                  index === 0 ? 'home' : documents[index - 1].id,
                  document.id
                )}
              />
              <div
                className={`tabbedapp-document-tab ${
                  activeDocumentId === document.id
                    ? 'tabbedapp-tab-button-active'
                    : ''
                } ${
                  tabDragState?.draggedId === document.id
                    ? 'tabbedapp-document-tab-dragging'
                    : ''
                }`}
                data-tabbedapp-tab-id={document.id}
                draggable={!shellLocked}
                onAuxClick={(event) =>
                  closeTabOnMiddleClick(event, document.id)
                }
                onContextMenu={(event) =>
                  openTabContextMenu(event, document.id)
                }
                onDragEnd={finishTabDrag}
                onDragOver={updateTabDragTarget}
                onDragStart={(event) => startTabDrag(event, document.id)}
                onDrop={dropTab}
                onMouseDown={suppressMiddleClickAutoscroll}
              >
                <button
                  className="tabbedapp-tab-main"
                  disabled={shellLocked}
                  onClick={() => selectDocument(document.id)}
                  title={document.title}
                  type="button"
                >
                  <span className="tabbedapp-tab-title">{document.title}</span>
                </button>
                <button
                  aria-label={`Close ${document.title}`}
                  className={`tabbedapp-tab-close ${
                    document.hasUnsavedChanges
                      ? 'tabbedapp-tab-close-dirty'
                      : ''
                  }`}
                  disabled={shellLocked}
                  onClick={() => void closeDocument(document.id)}
                  type="button"
                >
                  <span className="tabbedapp-tab-dirty-dot" />
                  <X className="tabbedapp-tab-close-icon" size={14} />
                </button>
              </div>
            </Fragment>
          ))}
          {documents.length > 0 ? (
            <span
              aria-hidden="true"
              className={tabSeparatorClass(
                documents[documents.length - 1].id,
                null
              )}
            />
          ) : null}
        </nav>
        <div className="tabbedapp-tabbar-actions">
          <button
            aria-expanded={newTabMenuOpen}
            aria-label="New tab"
            className="tabbedapp-new-tab tabbedapp-tab-button"
            disabled={shellLocked}
            onClick={toggleNewTabMenu}
            title="New tab"
            type="button"
          >
            <Plus size={17} />
          </button>
          {newTabMenuOpen ? (
            <div
              className="tabbedapp-tab-context-menu tabbedapp-new-tab-menu"
              role="menu"
              style={{ left: newTabMenuPosition.x, top: newTabMenuPosition.y }}
            >
              <button
                disabled={shellLocked}
                onClick={() => void handleOpenPdfRequest()}
                role="menuitem"
                type="button"
              >
                <FolderOpen size={15} />
                <span>Open PDFs</span>
              </button>
              {TEMPLATE_ACTIONS.map(({ kind, label, renderIcon }) => (
                <button
                  key={kind}
                  disabled={shellLocked}
                  onClick={() => void createTemplateDocument(kind)}
                  role="menuitem"
                  type="button"
                >
                  {renderIcon(15)}
                  <span>{label}</span>
                </button>
              ))}
              {newTabMenuActions.length > 0 ? (
                <span className="tabbedapp-context-menu-separator" />
              ) : null}
              {newTabMenuActions.map((action) => (
                <button
                  key={action.label}
                  disabled={shellLocked}
                  onClick={() => void runNewTabMenuAction(action)}
                  role="menuitem"
                  type="button"
                >
                  {action.renderIcon(15)}
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <section className="tabbedapp-content">
        {activeDocument ? (
          <DocumentTabContent
            document={activeDocument}
            key={activeDocument.id}
            onCloseDocument={closeDocument}
            onBusyChange={handleWorkspaceBusyChange}
            onDirtyChange={updateDocumentDirtyState}
            onRegisterWorkspaceRef={registerWorkspaceRef}
            onTitleChange={updateDocumentTitle}
            workspaceOptions={{
              ...workspaceOptions,
              pickImageFile:
                workspaceOptions.pickImageFile ?? fileAdapter.pickImageFile,
              pickMergePdfFile: currentMergePdfPicker,
              printTarget: currentPrintTarget
            }}
          />
        ) : (
          renderHome?.(homeProps) ?? null
        )}
      </section>

      {tabContextMenu && tabContextMenuDocument ? (
        <div
          className="tabbedapp-tab-context-menu"
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
        >
          <button
            disabled={shellLocked}
            onClick={() => void copyTabFilename(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <Copy size={15} />
            <span>Copy filename</span>
          </button>
          <button
            disabled={shellLocked || !tabContextMenuWorkspaceAvailable}
            onClick={() => openRenameDialog(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <Pencil size={15} />
            <span>Rename file...</span>
          </button>
          <button
            disabled={shellLocked}
            onClick={() =>
              void createCornellNoteForDocument(tabContextMenuDocument.id)
            }
            role="menuitem"
            type="button"
          >
            <CornellTemplateIcon size={15} />
            <span>Create A4 Cornell note for file</span>
          </button>
          <span className="tabbedapp-context-menu-separator" />
          {tabContextMenuCanSave ? (
            <button
              disabled={shellLocked || !tabContextMenuWorkspaceAvailable}
              onClick={() =>
                void runWorkspaceCommand(tabContextMenuDocument.id, 'save')
              }
              role="menuitem"
              type="button"
            >
              <Save size={15} />
              <span>Save</span>
            </button>
          ) : null}
          {tabContextMenuCanSaveAs ? (
            <button
              disabled={shellLocked || !tabContextMenuWorkspaceAvailable}
              onClick={() =>
                void runWorkspaceCommand(tabContextMenuDocument.id, 'saveAs')
              }
              role="menuitem"
              type="button"
            >
              <SaveAll size={15} />
              <span>Save As...</span>
            </button>
          ) : null}
          {tabContextMenuCanDownload ? (
            <button
              disabled={shellLocked || !tabContextMenuWorkspaceAvailable}
              onClick={() =>
                void runWorkspaceCommand(
                  tabContextMenuDocument.id,
                  'downloadCopy'
                )
              }
              role="menuitem"
              type="button"
            >
              <Download size={15} />
              <span>Download a copy</span>
            </button>
          ) : null}
          {tabContextMenuCanPrint ? (
            <button
              disabled={shellLocked || !tabContextMenuWorkspaceAvailable}
              onClick={() =>
                void runWorkspaceCommand(tabContextMenuDocument.id, 'print')
              }
              role="menuitem"
              type="button"
            >
              <Printer size={15} />
              <span>Print</span>
            </button>
          ) : null}
          <span className="tabbedapp-context-menu-separator" />
          <button
            disabled={shellLocked}
            onClick={() => closeCurrentTab(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <X size={15} />
            <span>Close tab</span>
          </button>
          <button
            disabled={shellLocked || documents.length <= 1}
            onClick={() => closeOtherTabs(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <Layers size={15} />
            <span>Close other tabs</span>
          </button>
          <button
            disabled={shellLocked || tabContextMenuIndex >= documents.length - 1}
            onClick={() => closeTabsToRight(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <ChevronsRight size={15} />
            <span>Close tabs to the right</span>
          </button>
          <button
            disabled={shellLocked || documents.length === 0}
            onClick={closeEveryTab}
            role="menuitem"
            type="button"
          >
            <Layers size={15} />
            <span>Close all tabs</span>
          </button>
        </div>
      ) : null}

      {closeConfirmation ? (
        <div
          className="tabbedapp-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && closeConfirmation) {
              resolveCloseConfirmation('cancel');
            }
          }}
        >
          <CloseDocumentsDialog
            key={closeConfirmation.requestId}
            request={closeConfirmation}
            onCancel={() => resolveCloseConfirmation('cancel')}
            onDiscard={() => resolveCloseConfirmation('discard')}
            onSave={() => resolveCloseConfirmation('save')}
          />
        </div>
      ) : null}

      {renameDialog ? (
        <div
          className="tabbedapp-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setRenameDialog(null);
            }
          }}
        >
          <form
            className="tabbedapp-modal-surface tabbedapp-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRenameDialog();
            }}
          >
            <h2>Rename file</h2>
            <label>
              <span>Filename</span>
              <input
                autoFocus
                value={renameDialog.value}
                onChange={(event) =>
                  setRenameDialog((current) =>
                    current
                      ? { ...current, value: event.target.value }
                      : current
                  )
                }
              />
            </label>
            <div className="tabbedapp-close-dialog-actions">
              <button type="button" onClick={() => setRenameDialog(null)}>
                Cancel
              </button>
              <button className="tabbedapp-close-dialog-primary" type="submit">
                Save
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {showDropPanel ? (
        <div className="tabbedapp-modal-backdrop tabbedapp-drop-backdrop">
          <div className="tabbedapp-modal-surface tabbedapp-drop-card">
            <FolderOpen size={22} />
            <span>Drop PDFs to open</span>
          </div>
        </div>
      ) : null}
    </main>
  );
});

function CornellTemplateIcon({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      className="tabbedapp-cornell-template-icon"
      style={{ height: size, width: size }}
    >
      <File size={size} />
      <span className="tabbedapp-cornell-template-rule" />
    </span>
  );
}

function CloseDocumentsDialog({
  onCancel,
  onDiscard,
  onSave,
  request
}: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  request: TabbedPdfCloseDocumentsRequest;
}) {
  const titleId = useId();
  const dirtyDocuments = request.documents.filter(
    (document) => document.hasUnsavedChanges
  );
  const hiddenDirtyCount = Math.max(0, dirtyDocuments.length - 4);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCancel();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <section
      aria-labelledby={titleId}
      aria-modal="true"
      className="tabbedapp-modal-surface tabbedapp-close-dialog"
      role="dialog"
    >
      <h2 id={titleId}>There are unsaved changes</h2>
      <p>The following file(s) have unsaved changes:</p>
      {dirtyDocuments.length > 0 ? (
        <ul aria-label="Unsaved PDFs">
          {dirtyDocuments.slice(0, 4).map((document) => (
            <li key={document.id}>{document.title}</li>
          ))}
          {hiddenDirtyCount > 0 ? (
            <li>
              {hiddenDirtyCount} more PDF
              {hiddenDirtyCount === 1 ? '' : 's'}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="tabbedapp-close-dialog-actions">
        {request.canSaveChanges ? (
          <button
            className="tabbedapp-close-dialog-primary"
            onClick={onSave}
            type="button"
          >
            Save changes
          </button>
        ) : null}
        <button
          className="tabbedapp-close-dialog-danger"
          onClick={onDiscard}
          type="button"
        >
          Discard changes
        </button>
        <button autoFocus onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </section>
  );
}

function DocumentTabContent({
  document,
  onBusyChange,
  onCloseDocument,
  onDirtyChange,
  onRegisterWorkspaceRef,
  onTitleChange,
  workspaceOptions
}: {
  document: TabbedPdfDocument;
  onBusyChange: (documentId: string, busy: boolean) => void;
  onCloseDocument: (
    documentId: string,
    options?: { skipConfirm?: boolean }
  ) => Promise<boolean>;
  onDirtyChange: (documentId: string, hasUnsavedChanges: boolean) => void;
  onRegisterWorkspaceRef: (
    documentId: string
  ) => RefCallback<PdfWorkspaceHandle>;
  onTitleChange: (documentId: string, title: string) => void;
  workspaceOptions: TabbedPdfWorkspaceOptions;
}) {
  const handleDirtyChange = useCallback(
    (hasUnsavedChanges: boolean) =>
      onDirtyChange(document.id, hasUnsavedChanges),
    [document.id, onDirtyChange]
  );
  const handleTitleChange = useCallback(
    (title: string) => onTitleChange(document.id, title),
    [document.id, onTitleChange]
  );
  const handleBusyChange = useCallback(
    (busy: boolean) => onBusyChange(document.id, busy),
    [document.id, onBusyChange]
  );

  return (
    <PdfWorkspace
      className="tabbedapp-workspace"
      enableGlobalShortcuts
      enableWheelZoom
      initialSession={document.session}
      manageDocumentTitle={false}
      confirmDiscardChanges={workspaceOptions.confirmDiscardChanges}
      onClose={() => void onCloseDocument(document.id, { skipConfirm: true })}
      onBusyChange={handleBusyChange}
      onDirtyChange={handleDirtyChange}
      onDocumentTitleChange={handleTitleChange}
      onOpenExternalLink={workspaceOptions.onOpenExternalLink}
      pickImageFile={workspaceOptions.pickImageFile}
      pickMergePdfFile={workspaceOptions.pickMergePdfFile}
      printTarget={workspaceOptions.printTarget}
      readOnlyMessage={document.readOnlyMessage}
      ref={onRegisterWorkspaceRef(document.id)}
      allowEditing={
        (workspaceOptions.allowEditing ?? true) && !document.readOnly
      }
      allowImageAnnotations={workspaceOptions.allowImageAnnotations}
      showCloseButton={false}
      source={document.source}
    />
  );
}

function applySessionToDocument(
  document: TabbedPdfDocument,
  session: SensitivePdfWorkspaceSession
): TabbedPdfDocument {
  return {
    ...document,
    fileKey: session.fileKey ?? document.fileKey,
    hasUnsavedChanges: session.hasUnsavedChanges,
    session,
    source: {
      kind: 'bytes',
      fileKey: session.fileKey ?? document.source.fileKey,
      saveTarget:
        session.readOnlyReason && session.editingEnabled
          ? null
          : session.saveTarget ?? document.source.saveTarget ?? null,
      downloadTarget:
        session.downloadTarget ?? document.source.downloadTarget ?? null,
      saveAsTarget: session.saveAsTarget ?? document.source.saveAsTarget ?? null,
      bytes: session.pdfBytes,
      name: session.fileName,
      sourceId: session.sourceId
    },
    title: session.fileName
  };
}

function documentCanSave(document: TabbedPdfDocument) {
  return documentCanSaveAs(document) || Boolean(documentSaveTarget(document));
}

function documentCanSaveAs(document: TabbedPdfDocument) {
  return Boolean(documentSaveAsTarget(document));
}

function documentCanDownload(document: TabbedPdfDocument) {
  return Boolean(document.session?.downloadTarget ?? document.source.downloadTarget);
}

function documentSaveTarget(document: TabbedPdfDocument) {
  return document.session?.saveTarget ?? document.source.saveTarget ?? null;
}

function documentSaveAsTarget(document: TabbedPdfDocument) {
  return document.session?.saveAsTarget ?? document.source.saveAsTarget ?? null;
}

function nextDocumentId(
  name: string,
  nextDocumentIdRef: { current: number }
) {
  nextDocumentIdRef.current += 1;
  return `web:${nextDocumentIdRef.current}:${name}`;
}

function isFileDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes('Files');
}

function canOpenDroppedFiles(fileAdapter: PdfHostAdapter) {
  return Boolean(
    fileAdapter.pdfDocumentsFromDrop || fileAdapter.pdfDocumentsFromFileInput
  );
}

function cleanWorkspaceTitle(title: string) {
  return title.replace(/^\*/, '');
}

function filenameStem(title: string) {
  const filename = cleanWorkspaceTitle(title).split(/[\\/]/).pop() ?? title;
  const extensionStart = filename.lastIndexOf('.');
  return extensionStart > 0 ? filename.slice(0, extensionStart) : filename;
}

function pdfFileNameFromStem(stem: string) {
  const cleaned = stem
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.pdf$/i, '');

  return cleaned ? `${cleaned}.pdf` : null;
}

function cornellNoteStem(stem: string) {
  return `NOTE - ${stem}`;
}

function cornellTitleAnnotation(text: string): PdfAnnotation {
  const titleLineHeight = 14 * 1.25;
  const titleHeight = titleLineHeight * 3 + 4;

  return {
    id: crypto.randomUUID(),
    kind: 'freeText',
    pageIndex: 0,
    rect: {
      x1: CORNELL_CONTENT_BOUNDS.left,
      y1: CORNELL_CONTENT_BOUNDS.titleTop - titleHeight,
      x2: CORNELL_CONTENT_BOUNDS.right,
      y2: CORNELL_CONTENT_BOUNDS.titleTop
    },
    text,
    fontSize: 14,
    color: [0.09, 0.11, 0.11],
    opacity: 1,
    layoutWidth: CORNELL_CONTENT_BOUNDS.titleWidth
  };
}

function clampContextMenuPosition(x: number, y: number) {
  return clampMenuPosition(x, y, 256, 172);
}

function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number
) {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin))
  };
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
