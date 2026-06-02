import {
  Fragment,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import type {
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  RefCallback
} from 'react';
import {
  File,
  FileText,
  FolderOpen,
  Home,
  Plus,
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
  PdfWorkspaceSession,
  PdfWorkspaceSourceInput,
  PdfWorkspaceSource
} from '../annotator';
import {
  CORNELL_CONTENT_BOUNDS,
  createPdfTemplate
} from '../pdfTemplates';
import type { PdfTemplateKind } from '../pdfTemplates';
import { warmPdfRuntimeCaches } from '../pdfRuntime';

export type TabbedPdfTemplateAction = {
  kind: PdfTemplateKind;
  label: string;
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
  session: PdfWorkspaceSession | null;
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
  dirtyCount: number;
  documents: TabbedPdfDocumentSummary[];
};

type SessionUpdate = {
  documentId: string;
  session: PdfWorkspaceSession;
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

export type TabbedPdfWorkspaceOptions = Pick<
  PdfWorkspaceProps,
  | 'confirmDiscardChanges'
  | 'onOpenExternalLink'
>;

export type TabbedPdfHomeRenderProps = {
  createTemplateDocument: (kind: PdfTemplateKind) => Promise<void>;
  dragActive: boolean;
  openPdfDocuments: () => Promise<void>;
  templateActions: TabbedPdfTemplateAction[];
};

export type TabbedPdfShellHandle = {
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
  fileAdapter: PdfHostAdapter;
  initialDocuments?: PdfHostDocument[];
  onDocumentsChange?: (documents: TabbedPdfDocumentSummary[]) => void;
  renderHome?: (props: TabbedPdfHomeRenderProps) => ReactNode;
  workspaceOptions?: TabbedPdfWorkspaceOptions;
};

const DEFAULT_WORKSPACE_OPTIONS: TabbedPdfWorkspaceOptions = {};

export const TabbedPdfShell = forwardRef<
  TabbedPdfShellHandle,
  TabbedPdfShellProps
>(function TabbedPdfShell({
  className,
  confirmCloseDocuments,
  fileAdapter,
  initialDocuments = [],
  onDocumentsChange,
  renderHome,
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
  const activeDocumentIdRef = useLatestRef(activeDocumentId);
  const documentsRef = useLatestRef(documents);

  function visibleDocumentIds() {
    return activeDocumentIdRef.current ? [activeDocumentIdRef.current] : [];
  }

  function documentSummaries(): TabbedPdfDocumentSummary[] {
    return documentSummariesFor(documentsRef.current);
  }

  function documentSummariesFor(
    sourceDocuments: TabbedPdfDocument[]
  ): TabbedPdfDocumentSummary[] {
    const activeId = activeDocumentIdRef.current;
    return sourceDocuments.map((document) => ({
      active: document.id === activeId,
      fileKey: document.fileKey,
      hasUnsavedChanges: document.hasUnsavedChanges,
      id: document.id,
      title: document.title
    }));
  }

  async function confirmDocumentClose(
    closingDocuments: TabbedPdfDocument[],
    dirtyCount: number,
    fallbackMessage: string
  ) {
    if (dirtyCount === 0) {
      return true;
    }

    if (confirmCloseDocuments) {
      try {
        return await confirmCloseDocuments({
          dirtyCount,
          documents: documentSummariesFor(closingDocuments)
        });
      } catch (error) {
        console.error(error);
        return false;
      }
    }

    return window.confirm(fallbackMessage);
  }

  useImperativeHandle(ref, () => ({
    focusHome: selectHome,
    getDocuments: documentSummaries,
    openDocument: (document) => openHostDocuments([document]),
    openDocuments: openHostDocuments,
    openSource: (source, options = {}) =>
      openHostDocuments([
        {
          fileKey: options.fileKey,
          source,
          title: options.title
        }
      ])
  }));

  useEffect(() => {
    if (initialDocumentsOpenedRef.current || initialDocuments.length === 0) {
      return;
    }

    initialDocumentsOpenedRef.current = true;
    openHostDocuments(initialDocuments);
  }, [initialDocuments]);

  useEffect(() => {
    onDocumentsChange?.(documentSummaries());
  }, [activeDocumentId, documents, onDocumentsChange]);

  useEffect(() => {
    const activeDocument = documents.find(
      (document) => document.id === activeDocumentId
    );
    const dirtyPrefix = documents.some((document) => document.hasUnsavedChanges)
      ? '*'
      : '';
    document.title = activeDocument
      ? `${dirtyPrefix}${activeDocument.title}`
      : `${dirtyPrefix}PDF Annotator`;
  }, [activeDocumentId, documents]);

  useEffect(() => {
    if (!documents.some((document) => document.hasUnsavedChanges)) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
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

  function captureMountedSessions(documentIds = visibleDocumentIds()) {
    const updates: SessionUpdate[] = [];
    for (const documentId of new Set(documentIds)) {
      const session = workspaceRefs.current.get(documentId)?.snapshot();
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
    window.setTimeout(() => {
      void handle.releaseRenderResources().catch(console.error);
    }, 0);
  }

  function handleFileInputChange(event: ReactChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    openHostDocuments(fileAdapter.pdfDocumentsFromFileInput?.(files) ?? []);
  }

  function openTabbedDocuments(openedDocuments: TabbedPdfDocument[]) {
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
    openTabbedDocuments([
      {
        hasUnsavedChanges: Boolean(
          sourceInput.markDirty || sourceInput.initialAnnotations?.length
        ),
        id,
        session: null,
        source: attachPdfSourceId(sourceInput, id),
        title: sourceInput.name
      }
    ]);
  }

  function openHostDocuments(hostDocuments: PdfHostDocument[]) {
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

    const openedDocuments = newDocuments.map(({ fileKey, source, title }) => {
      const id = nextDocumentId(source.name, nextDocumentIdRef);
      return {
        fileKey,
        hasUnsavedChanges: Boolean(
          source.markDirty || source.initialAnnotations?.length
        ),
        id,
        session: null,
        source: attachPdfSourceId(source, id),
        title: title ?? source.name
      };
    });

    openTabbedDocuments(openedDocuments);
  }

  function selectHome() {
    if (activeDocumentIdRef.current === null) {
      return;
    }

    captureMountedSessions();
    releaseDocumentsLeavingView([]);
    setActiveDocumentId(null);
  }

  function selectDocument(documentId: string) {
    if (activeDocumentIdRef.current === documentId) {
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
    const session = workspaceRefs.current.get(documentId)?.snapshot();
    const currentDocuments = documentsRef.current;
    const documentIndex = currentDocuments.findIndex(
      (item) => item.id === documentId
    );
    const document = currentDocuments[documentIndex];
    if (!document) {
      return;
    }
    const hasUnsavedChanges =
      session?.hasUnsavedChanges ?? document?.hasUnsavedChanges ?? false;

    if (
      hasUnsavedChanges &&
      !skipConfirm &&
      !(await confirmDocumentClose(
        [document],
        1,
        'Close this PDF and discard unsaved changes?'
      ))
    ) {
      return;
    }

    const remainingDocuments = currentDocuments.filter(
      (item) => item.id !== documentId
    );
    const nextActiveId =
      activeDocumentIdRef.current === documentId
        ? remainingDocuments[
            Math.min(Math.max(documentIndex, 0), remainingDocuments.length - 1)
          ]?.id ?? null
        : activeDocumentIdRef.current;

    setDocuments(remainingDocuments);
    setActiveDocumentId(nextActiveId);
    releaseWorkspaceResources(documentId);
  }

  async function closeDocumentGroup(
    documentIds: string[],
    focusFallbackId: string
  ) {
    const uniqueDocumentIds = new Set(documentIds);
    if (uniqueDocumentIds.size === 0) {
      return;
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
      return;
    }

    const dirtyClosingCount = closingDocuments.filter((document) => {
      const session = sessionsByDocumentId.get(document.id);
      return session?.hasUnsavedChanges ?? document.hasUnsavedChanges;
    }).length;

    if (
      dirtyClosingCount > 0 &&
      !(await confirmDocumentClose(
        closingDocuments,
        dirtyClosingCount,
        closeTabsConfirmation(closingDocuments.length, dirtyClosingCount)
      ))
    ) {
      return;
    }

    const remainingDocuments = currentDocuments
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
  }

  function openTabContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    documentId: string
  ) {
    event.preventDefault();
    event.stopPropagation();
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

  async function createTemplateDocument(kind: PdfTemplateKind) {
    closeNewTabMenu();
    try {
      const { bytes, name } = await createPdfTemplate(kind);
      openGeneratedDocument({
        bytes,
        markDirty: true,
        name
      });
    } catch (error) {
      console.error(error);
    }
  }

  async function createCornellNoteForDocument(documentId: string) {
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
    closeTabContextMenu();
    void closeDocumentGroup(
      documentsRef.current
        .filter((document) => document.id !== documentId)
        .map((document) => document.id),
      documentId
    );
  }

  function closeTabsToRight(documentId: string) {
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
    if (!canOpenDroppedFiles(fileAdapter) || !isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setDragActive(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
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
        openHostDocuments(documents);
        return;
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function handleOpenPdfRequest() {
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

  const activeDocument = documents.find(
    (document) => document.id === activeDocumentId
  );
  const tabContextMenuDocument = tabContextMenu
    ? documents.find((document) => document.id === tabContextMenu.documentId)
    : null;
  const tabContextMenuIndex = tabContextMenuDocument
    ? documents.findIndex((document) => document.id === tabContextMenuDocument.id)
    : -1;
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

  return (
    <main
      className={['tabbedapp-shell', className].filter(Boolean).join(' ')}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(event) => void handleDrop(event)}
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
                draggable
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
                  onClick={() => selectDocument(document.id)}
                  title={document.title}
                  type="button"
                >
                  {document.hasUnsavedChanges ? '*' : ''}
                  <span className="tabbedapp-tab-title">{document.title}</span>
                </button>
                <button
                  aria-label={`Close ${document.title}`}
                  className="tabbedapp-tab-close"
                  onClick={() => void closeDocument(document.id)}
                  type="button"
                >
                  <X size={14} />
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
                  onClick={() => void createTemplateDocument(kind)}
                  role="menuitem"
                  type="button"
                >
                  {renderIcon(15)}
                  <span>{label}</span>
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
            onDirtyChange={updateDocumentDirtyState}
            onRegisterWorkspaceRef={registerWorkspaceRef}
            onTitleChange={updateDocumentTitle}
            workspaceOptions={workspaceOptions}
          />
        ) : (
          renderHome?.({
            createTemplateDocument,
            dragActive,
            openPdfDocuments: handleOpenPdfRequest,
            templateActions: TEMPLATE_ACTIONS
          }) ?? (
            <DefaultHomePanel />
          )
        )}
      </section>

      {dragActive && (activeDocument || !renderHome) ? (
        <div className="tabbedapp-drop-overlay">
          <div className="tabbedapp-drop-card">
            <FolderOpen size={22} />
            <span>Drop PDFs to open</span>
          </div>
        </div>
      ) : null}

      {tabContextMenu && tabContextMenuDocument ? (
        <div
          className="tabbedapp-tab-context-menu"
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
        >
          <button
            onClick={() => void copyTabFilename(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <span className="tabbedapp-menu-icon-spacer" />
            <span>Copy filename</span>
          </button>
          <button
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
          <button
            disabled={documents.length <= 1}
            onClick={() => closeOtherTabs(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <span className="tabbedapp-menu-icon-spacer" />
            <span>Close other tabs</span>
          </button>
          <button
            disabled={tabContextMenuIndex >= documents.length - 1}
            onClick={() => closeTabsToRight(tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <span className="tabbedapp-menu-icon-spacer" />
            <span>Close tabs to the right</span>
          </button>
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

function DefaultHomePanel() {
  return <div className="tabbedapp-default-home" />;
}

function DocumentTabContent({
  document,
  onCloseDocument,
  onDirtyChange,
  onRegisterWorkspaceRef,
  onTitleChange,
  workspaceOptions
}: {
  document: TabbedPdfDocument;
  onCloseDocument: (
    documentId: string,
    options?: { skipConfirm?: boolean }
  ) => Promise<void>;
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

  return (
    <PdfWorkspace
      className="tabbedapp-workspace"
      enableGlobalShortcuts
      enableWheelZoom
      initialSession={document.session}
      manageDocumentTitle={false}
      confirmDiscardChanges={workspaceOptions.confirmDiscardChanges}
      onClose={() => void onCloseDocument(document.id, { skipConfirm: true })}
      onDirtyChange={handleDirtyChange}
      onDocumentTitleChange={handleTitleChange}
      onOpenExternalLink={workspaceOptions.onOpenExternalLink}
      ref={onRegisterWorkspaceRef(document.id)}
      showCloseButton={false}
      source={document.source}
      warnBeforeUnload={false}
    />
  );
}

function applySessionToDocument(
  document: TabbedPdfDocument,
  session: PdfWorkspaceSession
): TabbedPdfDocument {
  return {
    ...document,
    hasUnsavedChanges: session.hasUnsavedChanges,
    session,
    source: {
      kind: 'bytes',
      saveTarget: document.source.saveTarget ?? null,
      bytes: session.pdfBytes,
      name: session.fileName,
      sourceId: session.sourceId
    },
    title: session.fileName
  };
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

function cornellNoteStem(stem: string) {
  const zoteroLike = /^(.+?)\s+-\s+(\d{4}[a-z]?)\s+-\s+(.+)$/i;
  const match = stem.match(zoteroLike);

  if (!match) {
    return `${stem} - NOTE`;
  }

  const [, author, year, title] = match;
  return `${author} - ${year} - NOTE - ${title}`;
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

function closeTabsConfirmation(tabCount: number, dirtyCount: number) {
  return `Close ${tabCount} tab${tabCount === 1 ? '' : 's'} and discard unsaved changes in ${dirtyCount} PDF${dirtyCount === 1 ? '' : 's'}?`;
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
