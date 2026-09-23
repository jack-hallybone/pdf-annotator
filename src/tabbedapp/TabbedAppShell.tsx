// Order matters: the chrome sheet overrides the document editor sheet's tokens.
import "../pdfdocumenteditor/styles.css";
import "./styles.css";
import {
  Fragment,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  Suspense,
} from "react";
import { useEventCallback } from "../useEventCallback";
import type {
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefCallback,
} from "react";
import {
  ChevronsRight,
  Copy,
  Download,
  File,
  FileText,
  FolderOpen,
  Home,
  Layers,
  List,
  PanelsLeftBottom,
  Pencil,
  Plus,
  Printer,
  Save,
  Columns2,
  Rows2,
  SaveAll,
  SavePlus,
  X,
} from "lucide-react";
import type { TabbedAppHostAdapter, TabbedAppHostDocument } from "./fileHost";
import { useTabDragReorder } from "./useTabDragReorder";
import { displayableFileName, pdfFileNameFromStem } from "../fileNames";
import { PRODUCT_NAME } from "../productName";
import { useLatestRef } from "../useLatestRef";
// Never src/pdfdocumenteditor's barrel for a value: it re-exports PdfDocumentEditor, and
// this shell is in the initial chunk.
import { attachPdfSourceId } from "../pdfdocumenteditor/host";
import { useSplitResizer } from "../pdfdocumenteditor/useSplitResizer";
import { TabbedAppNoticeStack } from "./components/TabbedAppNotices";
import {
  useTabbedAppNotices,
  type ShowNoticeOptions,
} from "./useTabbedAppNotices";
import { useFocusTrap } from "./useFocusTrap";

const TabbedAppDocument = lazy(async () => ({
  default: (await import("./TabbedAppDocument")).TabbedAppDocument,
}));
import type {
  TabbedAppDocumentHandle,
  TabbedAppDocumentProps,
  SensitiveTabbedAppDocumentSession,
} from "./TabbedAppDocument";
import type {
  PdfDocumentEditorHostCapabilities,
  PdfSaveWithResult,
  SplitAxis,
} from "../pdfdocumenteditor";
import type {
  PdfAnnotation,
  PdfDocumentEditorSourceInput,
  PdfDocumentEditorSource,
} from "../pdfdocumenteditor";
// Geometry only; createPdfTemplate is imported on demand, to keep out pdf-lib.
import { CORNELL_CONTENT_BOUNDS } from "../pdfTemplateGeometry";
import type { PdfTemplateKind } from "../pdfTemplateGeometry";
import { warmPdfRuntimeCaches } from "../pdfRuntime";

export type TabbedAppTemplateAction = {
  kind: PdfTemplateKind;
  label: string;
  renderIcon: (size: number) => ReactNode;
};

type TabbedAppMenuAction = {
  label: string;
  onSelect: () => Promise<void> | void;
  renderIcon: (size: number) => ReactNode;
};

const TEMPLATE_ACTIONS: TabbedAppTemplateAction[] = [
  {
    kind: "a4Blank",
    label: "New Blank A4",
    renderIcon: (size) => <File size={size} />,
  },
  {
    kind: "a4Lined",
    label: "New Lined A4",
    renderIcon: (size) => <FileText size={size} />,
  },
  {
    kind: "a4Cornell",
    label: "New A4 Cornell",
    renderIcon: (size) => <PanelsLeftBottom size={size} />,
  },
];

type TabbedAppOpenDocument = {
  fileKey?: string;
  hasUnsavedChanges: boolean;
  id: string;
  session: SensitiveTabbedAppDocumentSession | null;
  source: PdfDocumentEditorSource;
  title: string;
};

export type TabbedAppOpenDocumentSummary = {
  active: boolean;
  fileKey?: string;
  hasUnsavedChanges: boolean;
  id: string;
  title: string;
};

export type TabbedAppCloseDocumentsRequest = {
  canSaveChanges: boolean;
  dirtyCount: number;
  documents: TabbedAppOpenDocumentSummary[];
};

type CloseDocumentsDecision = "cancel" | "discard" | "save";

type SessionUpdate = {
  documentId: string;
  session: SensitiveTabbedAppDocumentSession;
};

type TabContextMenuState = {
  documentId: string;
  x: number;
  y: number;
};

type MenuPosition = {
  x: number;
  y: number;
};

type CloseConfirmationState = TabbedAppCloseDocumentsRequest & {
  requestId: number;
};

type SaveDestinationRequest = {
  documentIds: string[];
};

type RenameDialogState = {
  documentId: string;
  value: string;
};

export type TabbedAppDocumentOptions = PdfDocumentEditorHostCapabilities &
  Pick<
    TabbedAppDocumentProps,
    "allowEditing" | "allowImageAnnotations" | "confirmDiscardChanges"
  >;

export type TabbedAppHomeRenderProps = {
  createTemplateDocument: (kind: PdfTemplateKind) => Promise<void>;
  dragActive: boolean;
  openPdfDocuments: () => Promise<void>;
  templateActions: TabbedAppTemplateAction[];
};

type PanelSide = "left" | "right";

export type TabbedAppShellHandle = {
  closeAllDocuments: () => Promise<boolean>;
  saveAllDocuments: () => Promise<void>;
  confirmWindowClose: () => Promise<boolean>;
  focusHome: () => void;
  getDocuments: () => TabbedAppOpenDocumentSummary[];
  openDocument: (document: TabbedAppHostDocument) => void;
  openDocuments: (documents: TabbedAppHostDocument[]) => void;
  openSource: (
    source: PdfDocumentEditorSourceInput,
    options?: { fileKey?: string; title?: string },
  ) => void;
  showNotice: (message: string, options?: ShowNoticeOptions) => void;
};

export type TabbedAppShellProps = {
  className?: string;
  confirmCloseDocuments?: (
    request: TabbedAppCloseDocumentsRequest,
  ) => boolean | Promise<boolean>;
  fileAdapter: TabbedAppHostAdapter;
  initialDocuments?: TabbedAppHostDocument[];
  newTabMenuActions?: TabbedAppMenuAction[];
  onDocumentsChange?: (documents: TabbedAppOpenDocumentSummary[]) => void;
  renderHome?: (props: TabbedAppHomeRenderProps) => ReactNode;
  documentOptions?: TabbedAppDocumentOptions;
};

const DEFAULT_DOCUMENT_OPTIONS: TabbedAppDocumentOptions = {};

export const TabbedAppShell = forwardRef<
  TabbedAppShellHandle,
  TabbedAppShellProps
>(function TabbedAppShell(
  {
    className,
    confirmCloseDocuments,
    fileAdapter,
    initialDocuments = [],
    newTabMenuActions = [],
    onDocumentsChange,
    renderHome,
    documentOptions = DEFAULT_DOCUMENT_OPTIONS,
  }: TabbedAppShellProps,
  ref,
) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tabsNavRef = useRef<HTMLElement>(null);
  const initialDocumentsOpenedRef = useRef(false);
  const nextDocumentIdRef = useRef(0);
  const documentRefs = useRef(new Map<string, TabbedAppDocumentHandle>());
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<TabbedAppOpenDocument[]>([]);
  const [dragActive, setDragActive] = useState(false);
  // `activeDocumentId` is the left panel and the shell's one idea of "the
  // document"; the right must always name one, or the split closes.
  const [splitView, setSplitView] = useState(false);
  const [secondaryDocumentId, setSecondaryDocumentId] = useState<string | null>(
    null,
  );
  const [activePanel, setActivePanel] = useState<PanelSide>("left");
  const [splitDirection, setSplitDirection] = useState<SplitAxis>("row");
  // The primary panel's share of the split; the secondary panel takes the
  // rest, so one number describes both.
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [newTabMenuPosition, setNewTabMenuPosition] = useState<MenuPosition>({
    x: 0,
    y: 0,
  });
  const [tabListMenuOpen, setTabListMenuOpen] = useState(false);
  const [tabListMenuPosition, setTabListMenuPosition] = useState<MenuPosition>({
    x: 0,
    y: 0,
  });
  const [tabContextMenu, setTabContextMenu] =
    useState<TabContextMenuState | null>(null);
  const [closeConfirmation, setCloseConfirmation] =
    useState<CloseConfirmationState | null>(null);
  const [saveDestinationRequest, setSaveDestinationRequest] =
    useState<SaveDestinationRequest | null>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(
    null,
  );
  const [busyDocumentIds, setBusyDocumentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [shellCommandBusy, setShellCommandBusy] = useState(false);
  const {
    notices,
    showNotice,
    dismissNotice,
    pauseNoticeTimers,
    resumeNoticeTimers,
  } = useTabbedAppNotices();
  const renameDialogTitleId = useId();
  const renameDialogRef = useRef<HTMLFormElement | null>(null);
  // Where focus lands when a dialog's trigger closed along with its menu.
  const tabbarRef = useRef<HTMLElement | null>(null);
  const activeDocumentIdRef = useLatestRef(activeDocumentId);
  const secondaryDocumentIdRef = useLatestRef(secondaryDocumentId);
  const splitViewRef = useLatestRef(splitView);
  const activePanelRef = useLatestRef(activePanel);
  useFocusTrap(renameDialogRef, renameDialog !== null, tabbarRef);
  const openHostDocumentsEvent = useEventCallback(openHostDocuments);
  const notifyDocumentsChangeEvent = useEventCallback(() => {
    onDocumentsChange?.(documentSummaries());
  });
  const runDocumentCommandEvent = useEventCallback(runDocumentCommand);
  const saveDocumentsEvent = useEventCallback(() => void saveDocuments());
  const openPdfDocumentsEvent = useEventCallback(
    () => void handleOpenPdfRequest(),
  );
  const activeDocumentBusy = panelDocumentIds(
    activeDocumentId,
    splitView ? secondaryDocumentId : null,
  ).some((documentId) => busyDocumentIds.has(documentId));
  const shellLocked = shellCommandBusy || activeDocumentBusy;
  const shellLockedRef = useLatestRef(shellLocked);
  const splitResizer = useSplitResizer({
    axis: splitDirection,
    disabled: shellLocked,
    ratio: splitRatio,
    setRatio: setSplitRatio,
  });
  const closeConfirmationResolverRef = useRef<
    ((decision: CloseDocumentsDecision) => void) | null
  >(null);
  const documentsRef = useLatestRef(documents);
  const nextCloseConfirmationIdRef = useRef(0);
  const pendingHostDocumentsRef = useRef<TabbedAppHostDocument[]>([]);
  const {
    dropTab,
    finishTabDrag,
    handleTabbarDragOver,
    handleTabbarDrop,
    startTabDrag,
    tabDragState,
    updateTabDragTarget,
  } = useTabDragReorder({
    closeTabContextMenu,
    shellLockedRef,
    setDocuments,
    tabsNavRef,
  });

  // The tab strip grows to fill the bar so a tab can reach its own preferred
  // width (see .tabbedapp-tabs), but "+" stays a fixed sibling outside it so
  // an overflowing, scrolling strip never scrolls it out of reach. Left
  // alone, that growth strands "+" wherever the strip's grown edge lands
  // rather than right after the tabs, so this pins the strip back down to
  // its own content width whenever that's narrower than what it grew to.
  useEffect(() => {
    const nav = tabsNavRef.current;
    if (!nav) {
      return;
    }

    let layoutFrame: number | null = null;
    let scrollFrame: number | null = null;

    // The strip's own edge fade (see .tabbedapp-tabs--overflowing and its
    // --at-start/--at-end siblings) is the reader's only cue that it
    // scrolls now that its scrollbar is hidden by design - only reachable
    // with an extreme number of tabs, since the floor below lets a tab
    // shrink well past where it used to force this.
    function updateScrollEdgeState() {
      if (!nav) {
        return;
      }
      const overflowing = nav.scrollWidth > nav.clientWidth + 1;
      const atStart = nav.scrollLeft <= 0;
      const atEnd = nav.scrollLeft >= nav.scrollWidth - nav.clientWidth - 1;
      nav.classList.toggle("tabbedapp-tabs--overflowing", overflowing);
      nav.classList.toggle("tabbedapp-tabs--at-start", atStart);
      nav.classList.toggle("tabbedapp-tabs--at-end", atEnd);
    }

    function syncTabStripWidth() {
      if (!nav) {
        return;
      }
      // scrollWidth only reports overflow, which there is none of while nav
      // has grown wider than its content - measuring the last child's own
      // edge is what actually says how much of that grown width is real.
      const lastChild = nav.lastElementChild;
      nav.style.flexBasis = "";
      nav.style.flexGrow = "";
      const needed = lastChild
        ? lastChild.getBoundingClientRect().right -
          nav.getBoundingClientRect().left
        : 0;
      const available = nav.clientWidth;
      // flex-basis alone is not a cap: flex-grow still claims leftover space
      // from that starting point, so it has to be zeroed too, or this pins
      // nothing.
      if (needed < available) {
        nav.style.flexBasis = `${needed}px`;
        nav.style.flexGrow = "0";
      }
      updateScrollEdgeState();
    }
    function scheduleLayoutSync() {
      if (layoutFrame !== null) {
        window.cancelAnimationFrame(layoutFrame);
      }
      layoutFrame = window.requestAnimationFrame(syncTabStripWidth);
    }
    function scheduleScrollSync() {
      if (scrollFrame !== null) {
        window.cancelAnimationFrame(scrollFrame);
      }
      scrollFrame = window.requestAnimationFrame(updateScrollEdgeState);
    }

    scheduleLayoutSync();
    const observer = new ResizeObserver(scheduleLayoutSync);
    if (nav.parentElement) {
      observer.observe(nav.parentElement);
    }
    nav.addEventListener("scroll", scheduleScrollSync, { passive: true });
    return () => {
      if (layoutFrame !== null) {
        window.cancelAnimationFrame(layoutFrame);
      }
      if (scrollFrame !== null) {
        window.cancelAnimationFrame(scrollFrame);
      }
      observer.disconnect();
      nav.removeEventListener("scroll", scheduleScrollSync);
    };
  }, [documents.length, splitView, splitDirection, splitRatio]);

  function visibleDocumentIds() {
    return panelDocumentIds(
      activeDocumentIdRef.current,
      splitViewRef.current ? secondaryDocumentIdRef.current : null,
    );
  }

  function documentSummaries(): TabbedAppOpenDocumentSummary[] {
    return documentSummariesFor(documentsRef.current);
  }

  function documentSummariesFor(
    sourceDocuments: TabbedAppOpenDocument[],
    dirtyDocumentIds?: Set<string>,
  ): TabbedAppOpenDocumentSummary[] {
    const activeId = activeDocumentIdRef.current;
    return sourceDocuments.map((document) => ({
      active: document.id === activeId,
      fileKey: document.fileKey,
      hasUnsavedChanges:
        dirtyDocumentIds?.has(document.id) ?? document.hasUnsavedChanges,
      id: document.id,
      title: document.title,
    }));
  }

  async function confirmDocumentClose(
    closingDocuments: TabbedAppOpenDocument[],
    dirtyCount: number,
    dirtyDocumentIds?: Set<string>,
    canSaveChanges = false,
  ) {
    if (dirtyCount === 0) {
      return "discard" as const;
    }

    const request = {
      canSaveChanges,
      dirtyCount,
      documents: documentSummariesFor(closingDocuments, dirtyDocumentIds),
    };

    if (confirmCloseDocuments) {
      try {
        return (await confirmCloseDocuments(request)) ? "discard" : "cancel";
      } catch {
        showNotice("Could not confirm. Nothing was closed.", {
          tone: "danger",
        });
        return "cancel" as const;
      }
    }

    return requestCloseConfirmation(request);
  }

  function requestCloseConfirmation(request: TabbedAppCloseDocumentsRequest) {
    closeConfirmationResolverRef.current?.("cancel");
    return new Promise<CloseDocumentsDecision>((resolve) => {
      closeConfirmationResolverRef.current = resolve;
      nextCloseConfirmationIdRef.current += 1;
      setCloseConfirmation({
        ...request,
        requestId: nextCloseConfirmationIdRef.current,
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

    resolveCloseConfirmation("cancel");
  }

  useImperativeHandle(ref, () => ({
    closeAllDocuments,
    saveAllDocuments: async () => {
      await saveDocuments();
    },
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
          title: options.title,
        },
      ]),
    showNotice,
  }));

  useEffect(() => {
    if (shellLocked || pendingHostDocumentsRef.current.length === 0) {
      return;
    }

    const pendingDocuments = pendingHostDocumentsRef.current.splice(0);
    openHostDocumentsEvent(pendingDocuments);
  }, [openHostDocumentsEvent, shellLocked]);

  // Enforces the split invariant for every route out of a document at once.
  useEffect(() => {
    if (!splitView) {
      return;
    }

    if (activeDocumentId === null) {
      setSplitView(false);
      setSecondaryDocumentId(null);
      setActivePanel("left");
      return;
    }

    if (!documents.some((document) => document.id === secondaryDocumentId)) {
      setSecondaryDocumentId(activeDocumentId);
    }
  }, [activeDocumentId, documents, secondaryDocumentId, splitView]);

  useEffect(() => {
    if (initialDocumentsOpenedRef.current || initialDocuments.length === 0) {
      return;
    }

    initialDocumentsOpenedRef.current = true;
    openHostDocumentsEvent(initialDocuments);
  }, [initialDocuments, openHostDocumentsEvent]);

  useEffect(
    () => () => {
      closeConfirmationResolverRef.current?.("cancel");
      closeConfirmationResolverRef.current = null;
    },
    [],
  );

  useEffect(() => {
    notifyDocumentsChangeEvent();
  }, [activeDocumentId, documents, notifyDocumentsChangeEvent]);

  // Registered for the shell's lifetime, so it precedes a newly opened tab's
  // own handler and stopImmediatePropagation stops that one running twice.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "o") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void openPdfDocumentsEvent();
        return;
      }

      const command =
        key === "p"
          ? "print"
          : key === "s"
            ? event.shiftKey
              ? "saveAll"
              : "save"
            : null;
      if (!command) {
        return;
      }

      // Before the no-document bail: printing the home tab can hang Chromium.
      event.preventDefault();
      event.stopImmediatePropagation();

      // Save All spans tabs, so it needs no active document.
      if (command === "saveAll") {
        void saveDocumentsEvent();
        return;
      }

      const activeDocumentId = activeDocumentIdRef.current;
      if (!activeDocumentId) {
        return;
      }

      void runDocumentCommandEvent(activeDocumentId, command);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeDocumentIdRef,
    openPdfDocumentsEvent,
    runDocumentCommandEvent,
    saveDocumentsEvent,
  ]);

  useEffect(() => {
    document.title = documents.some((document) => document.hasUnsavedChanges)
      ? `*${PRODUCT_NAME}`
      : PRODUCT_NAME;
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
    if (!renameDialog) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRenameDialog(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [renameDialog]);

  useDismissOnOutsidePress(
    Boolean(tabContextMenu),
    ".tabbedapp-tab-context-menu",
    closeTabContextMenu,
  );
  useDismissOnOutsidePress(
    newTabMenuOpen,
    ".tabbedapp-tabbar-actions",
    closeNewTabMenu,
  );
  useDismissOnOutsidePress(
    tabListMenuOpen,
    ".tabbedapp-tab-list-toggle-group",
    closeTabListMenu,
  );

  const updateDocumentDirtyState = useCallback(
    (documentId: string, hasUnsavedChanges: boolean) => {
      setDocuments((current) =>
        current.map((document) =>
          document.id === documentId
            ? { ...document, hasUnsavedChanges }
            : document,
        ),
      );
    },
    [],
  );

  const updateDocumentTitle = useCallback(
    (documentId: string, title: string) => {
      const cleanedTitle = cleanDocumentTitle(title);
      if (!cleanedTitle || cleanedTitle === PRODUCT_NAME) {
        return;
      }

      setDocuments((current) =>
        current.map((document) =>
          document.id === documentId
            ? { ...document, title: cleanedTitle }
            : document,
        ),
      );
    },
    [],
  );

  const registerDocumentRef = useCallback(
    (documentId: string): RefCallback<TabbedAppDocumentHandle> =>
      (handle) => {
        if (handle) {
          documentRefs.current.set(documentId, handle);
        } else {
          documentRefs.current.delete(documentId);
        }
      },
    [],
  );

  const handleDocumentBusyChange = useCallback(
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
    [],
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
      const session = documentRefs.current
        .get(documentId)
        ?.captureSessionForTabCache();
      if (session) {
        updates.push({ documentId, session });
      }
    }

    if (updates.length > 0) {
      const updatesByDocumentId = new Map(
        updates.map((update) => [update.documentId, update.session]),
      );
      setDocuments((current) =>
        current.map((document) => {
          const session = updatesByDocumentId.get(document.id);
          return session && session.sourceId === document.source.sourceId
            ? applySessionToDocument(document, session)
            : document;
        }),
      );
    }

    return updates;
  }

  function releaseDocumentsLeavingView(nextVisibleIds: string[]) {
    const nextVisibleIdSet = new Set(nextVisibleIds);
    for (const currentVisibleId of visibleDocumentIds()) {
      if (!nextVisibleIdSet.has(currentVisibleId)) {
        releaseDocumentResources(currentVisibleId);
      }
    }
  }

  function releaseDocumentResources(documentId: string) {
    const handle = documentRefs.current.get(documentId);
    if (!handle) {
      return;
    }

    documentRefs.current.delete(documentId);
    handleDocumentBusyChange(documentId, false);
    window.setTimeout(() => {
      void handle.releaseRenderResources().catch(() => undefined);
    }, 0);
  }

  function handleFileInputChange(event: ReactChangeEvent<HTMLInputElement>) {
    if (shellLockedRef.current) {
      event.target.value = "";
      return;
    }

    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    openHostDocuments(fileAdapter.pdfDocumentsFromFileInput?.(files) ?? []);
  }

  function openTabbedDocuments(openedDocuments: TabbedAppOpenDocument[]) {
    if (shellLockedRef.current) {
      return;
    }

    const firstOpenedId = openedDocuments[0]?.id ?? null;
    if (!firstOpenedId) {
      return;
    }

    captureMountedSessions();
    releaseDocumentsLeavingView([firstOpenedId]);
    setDocuments((current) => {
      const next = [...current, ...openedDocuments];
      // useLatestRef's effect is too late if this is called again first.
      documentsRef.current = next;
      return next;
    });
    setActiveDocumentId(firstOpenedId);
  }

  /* A source's own targets win, so a file opened in place writes to itself. */
  function withHostWriteTargets(
    source: PdfDocumentEditorSourceInput,
    fileKey?: string,
  ) {
    return {
      ...source,
      downloadTarget:
        source.downloadTarget ?? fileAdapter.downloadTarget ?? null,
      fileKey: source.fileKey ?? fileKey,
      saveAsTarget: source.saveAsTarget ?? fileAdapter.saveAsTarget ?? null,
    };
  }

  function openGeneratedDocument(sourceInput: PdfDocumentEditorSourceInput) {
    const id = nextDocumentId(sourceInput.name, nextDocumentIdRef);
    const sourceWithHostTargets = withHostWriteTargets(sourceInput);
    openTabbedDocuments([
      {
        hasUnsavedChanges: Boolean(
          sourceWithHostTargets.markDirty ||
          sourceWithHostTargets.initialAnnotations?.length,
        ),
        id,
        session: null,
        source: attachPdfSourceId(sourceWithHostTargets, id),
        title: cleanDocumentTitle(sourceWithHostTargets.name),
      },
    ]);
  }

  function openImperativeDocuments(hostDocuments: TabbedAppHostDocument[]) {
    if (shellLockedRef.current) {
      pendingHostDocumentsRef.current.push(...hostDocuments);
      return;
    }

    openHostDocuments(hostDocuments);
  }

  function openHostDocuments(hostDocuments: TabbedAppHostDocument[]) {
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
        .map((document) => [document.fileKey, document]),
    );
    const newDocuments: TabbedAppHostDocument[] = [];
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
      const sourceWithHostTargets = withHostWriteTargets(source, fileKey);
      return {
        fileKey,
        hasUnsavedChanges: Boolean(
          sourceWithHostTargets.markDirty ||
          sourceWithHostTargets.initialAnnotations?.length,
        ),
        id,
        session: null,
        source: attachPdfSourceId(sourceWithHostTargets, id),
        title: cleanDocumentTitle(title ?? sourceWithHostTargets.name),
      };
    });

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
    showDocumentInPanel(
      documentId,
      splitViewRef.current ? activePanelRef.current : "left",
    );
  }

  /**
   * Every route that changes what is on screen goes through here, because a
   * document leaving view must be captured before it unmounts - its
   * annotations and unsaved bytes are in that session alone.
   */
  function showDocumentInPanel(documentId: string, panel: PanelSide) {
    if (shellLockedRef.current) {
      return;
    }

    const split = splitViewRef.current;
    const nextActiveId =
      panel === "left" ? documentId : activeDocumentIdRef.current;
    const nextSecondaryId = !split
      ? null
      : panel === "right"
        ? documentId
        : secondaryDocumentIdRef.current;
    if (
      nextActiveId === activeDocumentIdRef.current &&
      nextSecondaryId === secondaryDocumentIdRef.current
    ) {
      return;
    }

    captureMountedSessions();
    releaseDocumentsLeavingView(
      panelDocumentIds(nextActiveId, nextSecondaryId),
    );
    setActiveDocumentId(nextActiveId);
    if (split) {
      setSecondaryDocumentId(nextSecondaryId);
    }
  }

  function closeSplitView() {
    if (shellLockedRef.current) {
      return;
    }

    captureMountedSessions();
    releaseDocumentsLeavingView(panelDocumentIds(activeDocumentId, null));
    setSplitView(false);
    setSecondaryDocumentId(null);
    setActivePanel("left");
  }

  function openSplit(direction: SplitAxis, targetDocumentId: string) {
    if (shellLockedRef.current || activeDocumentId === null) {
      return;
    }

    // A fresh split always starts even; re-picking one that's already open
    // is a swap, and keeps whatever ratio the reader dragged it to.
    if (!splitView) {
      setSplitRatio(0.5);
    }

    // Re-picking Split Right/Down while already split swaps the secondary
    // document instead of being blocked, so whatever it displaces needs the
    // same capture-then-release a close gives it - otherwise its live scroll
    // and undo state would be silently dropped, not just hidden.
    captureMountedSessions();
    releaseDocumentsLeavingView(
      panelDocumentIds(activeDocumentId, targetDocumentId),
    );
    setSplitDirection(direction);
    setSplitView(true);
    setSecondaryDocumentId(targetDocumentId);
    setActivePanel("right");
    closeTabContextMenu();
  }

  async function closeDocument(
    documentId: string,
    { skipConfirm = false }: { skipConfirm?: boolean } = {},
  ) {
    if (shellLockedRef.current) {
      return false;
    }

    const session = documentRefs.current
      .get(documentId)
      ?.captureSessionForTabCache();
    const currentDocuments = documentsRef.current;
    const documentIndex = currentDocuments.findIndex(
      (item) => item.id === documentId,
    );
    const document = currentDocuments[documentIndex];
    if (!document) {
      return true;
    }
    const hasUnsavedChanges =
      session?.hasUnsavedChanges ?? document.hasUnsavedChanges;

    if (hasUnsavedChanges && !skipConfirm) {
      const decision = await confirmDocumentClose(
        [document],
        1,
        new Set([document.id]),
        canSaveClosingDocuments([document], new Set([document.id])),
      );
      if (decision === "cancel") {
        return false;
      }
      if (
        decision === "save" &&
        !(await saveDocumentBeforeClose([document.id]))
      ) {
        return false;
      }
    }

    const latestDocuments = documentsRef.current;
    const latestDocumentIndex = latestDocuments.findIndex(
      (item) => item.id === documentId,
    );
    if (latestDocumentIndex < 0) {
      return true;
    }

    const remainingDocuments = latestDocuments.filter(
      (item) => item.id !== documentId,
    );
    const activeId = activeDocumentIdRef.current;
    const nextActiveId =
      activeId === documentId
        ? (remainingDocuments[
            Math.min(
              Math.max(latestDocumentIndex, 0),
              remainingDocuments.length - 1,
            )
          ]?.id ?? null)
        : activeId;

    documentsRef.current = remainingDocuments;
    setDocuments(remainingDocuments);
    setActiveDocumentId(nextActiveId);
    releaseDocumentResources(documentId);
    return true;
  }

  async function closeDocumentGroup(
    documentIds: string[],
    focusFallbackId: string,
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
      mountedSessionUpdates.map((update) => [
        update.documentId,
        update.session,
      ]),
    );
    const currentDocuments = documentsRef.current;
    const closingDocuments = currentDocuments.filter((document) =>
      uniqueDocumentIds.has(document.id),
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
        canSaveClosingDocuments(closingDocuments, dirtyClosingDocumentIds),
      );
      if (decision === "cancel") {
        return false;
      }
      if (
        decision === "save" &&
        !(await saveDocumentBeforeClose([...dirtyClosingDocumentIds]))
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
          : (remainingDocuments[0]?.id ?? null);

    documentsRef.current = remainingDocuments;
    setDocuments(remainingDocuments);
    setActiveDocumentId(nextActiveId);

    for (const documentId of uniqueDocumentIds) {
      releaseDocumentResources(documentId);
    }

    return true;
  }

  /**
   * Whether "Save changes" may be offered: only when Save All can reach every
   * dirty document being closed.
   */
  function canSaveClosingDocuments(
    closingDocuments: TabbedAppOpenDocument[],
    dirtyDocumentIds: Set<string>,
  ) {
    const closingDirty = closingDocuments.filter((document) =>
      dirtyDocumentIds.has(document.id),
    );
    return (
      closingDirty.length > 0 &&
      closingDirty.every(
        (document) =>
          Boolean(documentRefs.current.get(document.id)) ||
          Boolean(document.session),
      )
    );
  }

  /**
   * Saves an unmounted tab from its parked session rather than by mounting it.
   * Anything without its own destination is left for the reader to resolve
   * one file at a time, rather than guessed at with one upfront folder pick.
   */
  async function saveDocuments(documentIds?: string[]) {
    if (shellLockedRef.current) {
      return new Set(documentIds ?? []);
    }

    // Park first, or the batch saves the last tab switch's session.
    captureMountedSessions();
    const wanted = documentIds ? new Set(documentIds) : null;
    const dirty = documentsRef.current.filter(
      (document) =>
        document.hasUnsavedChanges && (!wanted || wanted.has(document.id)),
    );
    if (dirty.length === 0) {
      showNotice("No unsaved changes.");
      return new Set<string>();
    }

    const failedIds =
      (await runShellLockedTask(() => saveDocumentBatch(dirty))) ??
      new Set(dirty.map((document) => document.id));

    const unresolved = dirty.filter((document) => failedIds.has(document.id));
    if (unresolved.length > 0) {
      setSaveDestinationRequest({
        documentIds: unresolved.map((document) => document.id),
      });
    }

    return failedIds;
  }

  async function resolveSaveDestinationForDocument(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    const document = documentsRef.current.find(
      (item) => item.id === documentId,
    );
    if (!document) {
      return;
    }

    const documentHandle = documentRefs.current.get(documentId);
    const saved = await runShellLockedTask(() =>
      documentHandle ? documentHandle.saveAs() : saveParkedDocumentAs(document),
    );
    if (!saved) {
      return;
    }

    setSaveDestinationRequest((current) => {
      if (!current) {
        return current;
      }
      const remaining = current.documentIds.filter((id) => id !== documentId);
      return remaining.length > 0 ? { documentIds: remaining } : null;
    });
  }

  async function saveParkedDocumentAs(document: TabbedAppOpenDocument) {
    const saveAsTarget = documentSaveAsTarget(document);
    const session = document.session;
    if (!saveAsTarget || !session) {
      return false;
    }

    try {
      const { documentEditorSessionAfterSave, documentEditorSessionOutput } =
        await import("./saveAllRuntime");
      const output = await documentEditorSessionOutput(session);
      const result = await saveAsTarget(
        async () => output.bytes,
        document.title,
      );
      if (!result) {
        return false;
      }

      const savedSession = documentEditorSessionAfterSave(session, output);
      const nextSession = {
        ...savedSession,
        chrome: session.chrome,
        fileKey: result.fileKey ?? savedSession.fileKey,
        fileName: result.fileName ?? savedSession.fileName,
        saveTarget: result.saveTarget ?? savedSession.saveTarget,
      } as SensitiveTabbedAppDocumentSession;

      setDocuments((current) => {
        const next = current.map((item) =>
          item.id === document.id
            ? applySessionToDocument(item, nextSession)
            : item,
        );
        documentsRef.current = next;
        return next;
      });
      return true;
    } catch {
      return false;
    }
  }

  async function saveDocumentBatch(dirty: TabbedAppOpenDocument[]) {
    const { documentEditorSessionAfterSave, documentEditorSessionOutput } =
      await import("./saveAllRuntime");
    const failures: TabbedAppOpenDocument[] = [];
    const savedSessions = new Map<string, SensitiveTabbedAppDocumentSession>();
    let savedCount = 0;

    for (const document of dirty) {
      const saveTarget = documentSaveTarget(document);
      if (!saveTarget) {
        failures.push(document);
        continue;
      }

      const write = async (
        bytes: Uint8Array,
      ): Promise<PdfSaveWithResult | undefined> =>
        (await saveTarget(bytes)) ?? undefined;

      try {
        const documentHandle = documentRefs.current.get(document.id);
        if (documentHandle) {
          if (await documentHandle.saveWith(write)) {
            savedCount += 1;
          } else {
            failures.push(document);
          }
          continue;
        }

        const session = document.session;
        if (!session) {
          // Never mounted, so its bytes cannot be produced without rendering.
          failures.push(document);
          continue;
        }

        // A parked tab comes back with identities for the file just written.
        const output = await documentEditorSessionOutput(session);
        const result = await write(output.bytes);
        const savedSession = documentEditorSessionAfterSave(session, output);
        savedSessions.set(document.id, {
          ...savedSession,
          chrome: session.chrome,
          fileKey: result?.fileKey ?? savedSession.fileKey,
          saveTarget: result?.saveTarget ?? savedSession.saveTarget,
        } as SensitiveTabbedAppDocumentSession);
        savedCount += 1;
      } catch {
        failures.push(document);
      }
    }

    if (savedSessions.size > 0) {
      setDocuments((current) => {
        const next = current.map((document) => {
          const session = savedSessions.get(document.id);
          return session ? applySessionToDocument(document, session) : document;
        });
        documentsRef.current = next;
        return next;
      });
    }

    reportSaveAllOutcome(savedCount, failures);
    return new Set(failures.map((document) => document.id));
  }

  function reportSaveAllOutcome(
    savedCount: number,
    failures: TabbedAppOpenDocument[],
  ) {
    const saved = `Saved ${savedCount} file${savedCount === 1 ? "" : "s"}.`;
    if (failures.length === 0) {
      showNotice(saved, { tone: "success" });
      return;
    }

    const named = failures
      .slice(0, 4)
      .map((document) => document.title)
      .join(", ");
    const rest = failures.length > 4 ? ` and ${failures.length - 4} more` : "";
    showNotice(
      `${savedCount > 0 ? `${saved} ` : ""}Could not save ${named}${rest}. Those files still have unsaved changes.`,
      { tone: "danger" },
    );
  }

  /**
   * Read from the batch's own result, never documentsRef: onDirtyChange is a
   * state update that has not committed by the time this returns.
   */
  async function saveDocumentBeforeClose(documentIds: string[]) {
    return (await saveDocuments(documentIds)).size === 0;
  }

  async function closeAllDocuments() {
    const documentIds = documentsRef.current.map((document) => document.id);
    if (documentIds.length === 0) {
      return true;
    }

    return closeDocumentGroup(
      documentIds,
      activeDocumentIdRef.current ?? documentIds[0],
    );
  }

  async function confirmWindowClose() {
    if (shellLockedRef.current) {
      return false;
    }

    const currentDocuments = documentsRef.current;
    const dirtyDocuments = currentDocuments.filter(
      (document) => document.hasUnsavedChanges,
    );
    if (dirtyDocuments.length === 0) {
      return true;
    }

    const dirtyDocumentIds = new Set(
      dirtyDocuments.map((document) => document.id),
    );
    const decision = await confirmDocumentClose(
      dirtyDocuments,
      dirtyDocuments.length,
      dirtyDocumentIds,
      canSaveClosingDocuments(dirtyDocuments, dirtyDocumentIds),
    );

    if (decision === "cancel") {
      return false;
    }
    if (decision === "save") {
      return saveDocumentBeforeClose([...dirtyDocumentIds]);
    }

    return true;
  }

  function openTabContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    documentId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    closeTabListMenu();
    const position = clampContextMenuPosition(event.clientX, event.clientY);
    setTabContextMenu({
      documentId,
      x: position.x,
      y: position.y,
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
    closeTabListMenu();
    if (newTabMenuOpen) {
      setNewTabMenuOpen(false);
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    setNewTabMenuPosition(
      clampMenuPosition(bounds.left, bounds.bottom + 4, 220, 150),
    );
    setNewTabMenuOpen(true);
  }

  function closeTabListMenu() {
    setTabListMenuOpen(false);
  }

  function toggleTabListMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    closeNewTabMenu();
    if (tabListMenuOpen) {
      setTabListMenuOpen(false);
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    setTabListMenuPosition(
      clampTabListMenuPosition(bounds.right, bounds.bottom + 4),
    );
    setTabListMenuOpen(true);
  }

  function selectDocumentFromTabList(documentId: string) {
    selectDocument(documentId);
    closeTabListMenu();
  }

  async function copyTabFilename(documentId: string) {
    const document = documentsRef.current.find(
      (item) => item.id === documentId,
    );
    if (!document) {
      return;
    }

    const stem = filenameStem(document.title);
    try {
      await navigator.clipboard.writeText(stem);
    } catch {
      showNotice("Could not copy filename.", { tone: "danger" });
    } finally {
      closeTabContextMenu();
    }
  }

  function openRenameDialog(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    const document = documentsRef.current.find(
      (item) => item.id === documentId,
    );
    if (!document) {
      return;
    }

    closeTabContextMenu();
    setRenameDialog({
      documentId,
      value: filenameStem(document.title),
    });
  }

  async function submitRenameDialog() {
    if (!renameDialog || shellLockedRef.current) {
      return;
    }

    const documentHandle = documentRefs.current.get(renameDialog.documentId);
    if (!documentHandle) {
      setRenameDialog(null);
      return;
    }

    const nextName = pdfFileNameFromStem(renameDialog.value);
    if (!nextName) {
      return;
    }

    const saved = await runShellLockedTask(() =>
      documentHandle.saveAs(nextName),
    );
    if (saved) {
      setRenameDialog(null);
    }
  }

  async function runDocumentCommand(
    documentId: string,
    command: "downloadCopy" | "print" | "save" | "saveAs",
  ) {
    const documentHandle = documentRefs.current.get(documentId);
    closeTabContextMenu();
    if (!documentHandle || shellLockedRef.current) {
      return;
    }

    await runShellLockedTask(async () => {
      await documentHandle[command]();
    });
  }

  async function createTemplateDocument(kind: PdfTemplateKind) {
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    try {
      const { createPdfTemplate } = await import("../pdfTemplates");
      const { bytes } = await createPdfTemplate(kind);
      openGeneratedDocument({
        bytes,
        markDirty: true,
        name: "Untitled.pdf",
      });
    } catch {
      showNotice("Could not create a new document.", { tone: "danger" });
    }
  }

  async function createCornellNoteForDocument(documentId: string) {
    if (shellLockedRef.current) {
      return;
    }

    closeTabContextMenu();
    const document = documentsRef.current.find(
      (item) => item.id === documentId,
    );
    if (!document) {
      return;
    }

    try {
      const noteTitle = cornellNoteStem(filenameStem(document.title));
      const { createPdfTemplate } = await import("../pdfTemplates");
      const { bytes } = await createPdfTemplate("a4Cornell");
      openGeneratedDocument({
        bytes,
        initialAnnotations: [cornellTitleAnnotation(noteTitle)],
        markDirty: true,
        name: `${noteTitle}.pdf`,
      });
    } catch {
      showNotice("Could not create a new document.", { tone: "danger" });
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
      documentId,
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
      (document) => document.id === documentId,
    );
    if (documentIndex < 0) {
      return;
    }

    void closeDocumentGroup(
      documentsRef.current
        .slice(documentIndex + 1)
        .map((document) => document.id),
      documentId,
    );
  }

  function closeTabOnMiddleClick(
    event: ReactMouseEvent<HTMLElement>,
    documentId: string,
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
    event.dataTransfer.dropEffect = "copy";
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

    // Both reads before anything awaits: a drag data store answers only while
    // the drop event is being dispatched.
    const droppedFiles = Array.from(event.dataTransfer.files);
    const droppedDocuments = fileAdapter.pdfDocumentsFromDrop?.(
      event.dataTransfer,
    );

    try {
      const documents =
        (await droppedDocuments) ??
        fileAdapter.pdfDocumentsFromFileInput?.(droppedFiles) ??
        [];
      if (documents.length > 0) {
        cancelCloseConfirmation();
        openHostDocuments(documents);
        return;
      }
    } catch {
      showNotice("Could not open the dropped file(s).", { tone: "danger" });
    }
  }

  async function handleOpenPdfRequest() {
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    warmPdfRuntimeCaches();

    try {
      const result = await fileAdapter.pickPdfDocuments();
      if (result.documents.length > 0) {
        openHostDocuments(result.documents);
        return;
      }

      if (result.useFileInputFallback && fileAdapter.fileInput) {
        fileInputRef.current?.click();
      }
    } catch {
      if (fileAdapter.fileInput) {
        fileInputRef.current?.click();
      }
    }
  }

  async function runNewTabMenuAction(action: TabbedAppMenuAction) {
    if (shellLockedRef.current) {
      return;
    }

    closeNewTabMenu();
    try {
      await action.onSelect();
    } catch {
      showNotice("Could not complete that action.", { tone: "danger" });
    }
  }

  const activeDocument = documents.find(
    (document) => document.id === activeDocumentId,
  );
  const secondaryDocument = splitView
    ? documents.find((document) => document.id === secondaryDocumentId)
    : undefined;
  const isMirroredSplit = Boolean(
    secondaryDocument && secondaryDocument.id === activeDocument?.id,
  );
  const visibleDocumentIdSet = new Set(
    panelDocumentIds(activeDocumentId, secondaryDocument?.id ?? null),
  );
  const tabContextMenuDocument = tabContextMenu
    ? documents.find((document) => document.id === tabContextMenu.documentId)
    : null;
  // Filtered against live state, not just the request's own id list: a save
  // through any other path (a tab's own Save button) drops a document from
  // here too, not only the two resolutions this dialog itself offers.
  const saveDestinationDocuments = saveDestinationRequest
    ? documents.filter(
        (document) =>
          saveDestinationRequest.documentIds.includes(document.id) &&
          document.hasUnsavedChanges,
      )
    : [];
  const tabContextMenuIndex = tabContextMenuDocument
    ? documents.findIndex(
        (document) => document.id === tabContextMenuDocument.id,
      )
    : -1;
  const tabContextMenuDocumentAvailable = Boolean(
    tabContextMenuDocument &&
    tabContextMenuDocument.id === activeDocumentId &&
    documentRefs.current.has(tabContextMenuDocument.id),
  );
  /* Merged once for all of them, so null and undefined cannot be handled
     inconsistently per capability. */
  const capabilities: PdfDocumentEditorHostCapabilities = {
    onOpenExternalLink:
      documentOptions.onOpenExternalLink ?? fileAdapter.onOpenExternalLink,
    pickImageFile: documentOptions.pickImageFile ?? fileAdapter.pickImageFile,
    pickMergePdfFile:
      documentOptions.pickMergePdfFile ?? fileAdapter.pickMergePdfFile,
    printTarget: documentOptions.printTarget ?? fileAdapter.printTarget ?? null,
  };
  const tabContextMenuCanSave = tabContextMenuDocument
    ? documentCanSave(tabContextMenuDocument)
    : false;
  const tabContextMenuCanSaveAs = tabContextMenuDocument
    ? documentCanSaveAs(tabContextMenuDocument)
    : false;
  const tabContextMenuCanDownload = tabContextMenuDocument
    ? documentCanDownload(tabContextMenuDocument)
    : false;
  const tabContextMenuCanPrint = Boolean(capabilities.printTarget);
  const tabSeparatorClass = (
    leftId: "home" | string,
    rightId: string | null,
  ) => {
    const isDropTarget =
      tabDragState?.placement === "before"
        ? rightId === tabDragState.targetId
        : leftId === tabDragState?.targetId;
    const isBesideActiveTab =
      (leftId === "home"
        ? activeDocumentId === null
        : activeDocumentId === leftId) ||
      (rightId !== null && activeDocumentId === rightId);

    return [
      "tabbedapp-tab-separator",
      !isDropTarget && isBesideActiveTab
        ? "tabbedapp-tab-separator-hidden"
        : "",
      isDropTarget ? "tabbedapp-tab-separator-drop" : "",
    ]
      .filter(Boolean)
      .join(" ");
  };
  const homeProps = {
    createTemplateDocument,
    dragActive,
    openPdfDocuments: handleOpenPdfRequest,
    templateActions: TEMPLATE_ACTIONS,
  };
  const showDropPanel = dragActive && Boolean(activeDocument);
  const dirtyDocumentCount = documents.filter(
    (document) => document.hasUnsavedChanges,
  ).length;

  function renderDocumentPanel(
    panelDocument: TabbedAppOpenDocument,
    {
      secondView = false,
      splitDirection: panelSplitDirection,
      splitRatio: panelSplitRatio,
      onSplitRatioChange: panelOnSplitRatioChange,
    }: {
      secondView?: boolean;
      splitDirection?: SplitAxis;
      splitRatio?: number;
      onSplitRatioChange?: Dispatch<SetStateAction<number>>;
    } = {},
  ) {
    return (
      <DocumentTabContent
        document={panelDocument}
        key={panelDocument.id}
        onCloseDocument={closeDocument}
        onBusyChange={handleDocumentBusyChange}
        onDirtyChange={updateDocumentDirtyState}
        onRegisterDocumentRef={registerDocumentRef}
        onTitleChange={updateDocumentTitle}
        secondView={secondView}
        splitDirection={panelSplitDirection}
        splitRatio={panelSplitRatio}
        onSplitRatioChange={panelOnSplitRatioChange}
        documentOptions={{ ...documentOptions, ...capabilities }}
      />
    );
  }

  // Capture phase: the document editor inside handles its own pointer events.
  function renderPanel(
    side: PanelSide,
    panelDocument: TabbedAppOpenDocument,
    flexGrow: number,
  ) {
    return (
      <div
        className={`tabbedapp-panel ${
          activePanel === side ? "tabbedapp-panel-active" : ""
        }`}
        onFocusCapture={() => setActivePanel(side)}
        onPointerDownCapture={() => setActivePanel(side)}
        style={{ flexBasis: 0, flexGrow }}
      >
        {renderDocumentPanel(panelDocument)}
      </div>
    );
  }

  // Named so a reader can tell which document the second panel holds without
  // switching to it - the same reason a background tab keeps its own title.
  function renderSecondHeaderTitle() {
    return (
      <span className="tabbedapp-second-header-title truncate">
        {secondaryDocument?.title}
      </span>
    );
  }

  // Shared by both split directions: beside the tab bar for Split Right,
  // capping the second panel for Split Down - one control either way.
  function renderCloseSplitButton() {
    return (
      <button
        aria-label="Close split view"
        className="tabbedapp-split-toggle tabbedapp-tab-button"
        disabled={shellLocked}
        onClick={closeSplitView}
        title="Close split view"
        type="button"
      >
        <X size={17} />
      </button>
    );
  }

  function renderSplitResizer() {
    return (
      <div
        aria-label="Resize split"
        aria-orientation={splitDirection === "row" ? "vertical" : "horizontal"}
        aria-valuemax={splitResizer.ariaValueMax}
        aria-valuemin={splitResizer.ariaValueMin}
        aria-valuenow={splitResizer.ariaValueNow}
        className="split-resizer tabbedapp-panel-resizer"
        onKeyDown={splitResizer.handleKeyDown}
        onPointerDown={splitResizer.handlePointerDown}
        onPointerMove={splitResizer.handlePointerMove}
        onPointerUp={splitResizer.handlePointerUp}
        role="separator"
        tabIndex={shellLocked ? -1 : 0}
      />
    );
  }

  return (
    <main
      className={["tabbedapp-shell", className].filter(Boolean).join(" ")}
      data-busy={shellLocked ? "true" : "false"}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(event) => void handleDrop(event)}
    >
      <TabbedAppNoticeStack
        notices={notices}
        onDismissNotice={dismissNotice}
        onPauseTimers={pauseNoticeTimers}
        onResumeTimers={resumeNoticeTimers}
      />

      {fileAdapter.fileInput && fileAdapter.pdfDocumentsFromFileInput ? (
        <input
          accept={fileAdapter.fileInput.accept}
          className="tabbedapp-hidden-input"
          multiple={fileAdapter.fileInput.multiple ?? true}
          onChange={handleFileInputChange}
          ref={fileInputRef}
          type="file"
        />
      ) : null}

      <div className="tabbedapp-header-row">
        <div
          className="tabbedapp-header-slot"
          style={
            splitView && splitDirection === "row"
              ? { flexBasis: 0, flexGrow: splitRatio }
              : { flexGrow: 1 }
          }
        >
          <header
            ref={tabbarRef}
            tabIndex={-1}
            className={`tabbedapp-tabbar z-nav row end nowrap ${tabDragState ? "tabbedapp-tabbar-dragging" : ""}`}
            onDragOver={handleTabbarDragOver}
            onDrop={handleTabbarDrop}
          >
            <button
              aria-label="Home"
              aria-pressed={activeDocumentId === null}
              className={`tabbedapp-home-tab tabbedapp-tab-button ${
                activeDocumentId === null ? "tabbedapp-tab-button-active" : ""
              }`}
              disabled={shellLocked}
              onClick={selectHome}
              title="Home"
              type="button"
            >
              <Home size={18} />
            </button>
            <nav
              aria-label="Open PDFs"
              className="tabbedapp-tabs row end nowrap"
              ref={tabsNavRef}
            >
              {documents.map((document, index) => (
                <Fragment key={document.id}>
                  <span
                    aria-hidden="true"
                    className={tabSeparatorClass(
                      index === 0 ? "home" : documents[index - 1].id,
                      document.id,
                    )}
                  />
                  <div
                    className={`tabbedapp-document-tab row nowrap ${
                      visibleDocumentIdSet.has(document.id)
                        ? "tabbedapp-tab-button-active"
                        : ""
                    } ${
                      tabDragState?.draggedId === document.id
                        ? "tabbedapp-document-tab-dragging"
                        : ""
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
                      aria-pressed={visibleDocumentIdSet.has(document.id)}
                      className="tabbedapp-tab-main truncate row nowrap xs grow"
                      disabled={shellLocked}
                      onClick={() => selectDocument(document.id)}
                      title={document.title}
                      type="button"
                    >
                      <span className="tabbedapp-tab-title truncate">
                        {document.title}
                      </span>
                    </button>
                    <button
                      aria-label={`Close ${document.title}`}
                      className={`tabbedapp-tab-close ${
                        document.hasUnsavedChanges
                          ? "tabbedapp-tab-close-dirty"
                          : ""
                      }`}
                      disabled={shellLocked}
                      onClick={() => void closeDocument(document.id)}
                      type="button"
                    >
                      <span className="tabbedapp-tab-dirty-dot dot" />
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
                    null,
                  )}
                />
              ) : null}
            </nav>
            <div className="tabbedapp-tab-list-toggle-group">
              <button
                aria-expanded={tabListMenuOpen}
                aria-haspopup="menu"
                aria-label="List open tabs"
                className="tabbedapp-tab-list-toggle tabbedapp-tab-button"
                disabled={shellLocked || documents.length === 0}
                onClick={toggleTabListMenu}
                title="List open tabs"
                type="button"
              >
                <List size={16} />
              </button>
              {tabListMenuOpen ? (
                <div
                  className="panel floating menu z-menu tabbedapp-tab-context-menu tabbedapp-tab-list-menu"
                  onKeyDown={handleMenuKeyDown}
                  role="menu"
                  style={{
                    // x is a distance from the viewport's right edge, not
                    // the left one - see clampTabListMenuPosition.
                    right: tabListMenuPosition.x,
                    top: tabListMenuPosition.y,
                  }}
                >
                  {documents.map((document) => (
                    <button
                      aria-current={visibleDocumentIdSet.has(document.id)}
                      className="tabbedapp-tab-list-menu-item"
                      disabled={shellLocked}
                      key={document.id}
                      onClick={() => selectDocumentFromTabList(document.id)}
                      role="menuitem"
                      type="button"
                    >
                      <span className="tabbedapp-tab-list-menu-item-title truncate">
                        {document.title}
                      </span>
                      {document.hasUnsavedChanges ? (
                        <span
                          aria-label="Unsaved changes"
                          className="tabbedapp-tab-list-menu-item-dirty-dot"
                        />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="tabbedapp-tabbar-actions row end nowrap xxs">
              {/* Row gets its own second-header slot below; column has no
                  equivalent slot yet, so its close button lives here. */}
              {isMirroredSplit && splitDirection !== "row"
                ? renderCloseSplitButton()
                : null}
              <button
                aria-expanded={newTabMenuOpen}
                aria-haspopup="menu"
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
                  className="panel floating menu z-menu tabbedapp-tab-context-menu tabbedapp-new-tab-menu"
                  onKeyDown={handleMenuKeyDown}
                  role="menu"
                  style={{
                    left: newTabMenuPosition.x,
                    top: newTabMenuPosition.y,
                  }}
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
                    <span className="menu-separator" role="separator" />
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
            <span
              aria-hidden="true"
              className="tabbedapp-tabbar-divider tabbedapp-tabbar-divider-end"
            />
            {/* Kept apart from the tab-management cluster: always present, since
            a reader with unsaved work in a tab they are not looking at is
            exactly who needs to find this, not just who has just used it. */}
            <button
              aria-label={
                dirtyDocumentCount > 0
                  ? `Save all (${dirtyDocumentCount} unsaved)`
                  : "Save all"
              }
              className="tabbedapp-save-all tabbedapp-tab-button"
              disabled={shellLocked || dirtyDocumentCount === 0}
              onClick={() => void saveDocuments()}
              title="Save all (Ctrl+Shift+S)"
              type="button"
            >
              <SaveAll size={17} />
            </button>
          </header>
        </div>
        {splitView && splitDirection === "row" ? (
          <>
            {/* A fixed-width spacer, not a border: the same width as
                renderSplitResizer() below is what keeps this line aligned
                with the page separator regardless of the split ratio. */}
            <div
              aria-hidden="true"
              className="split-resizer tabbedapp-header-divider"
            />
            <div
              className="tabbedapp-header-slot"
              style={{ flexBasis: 0, flexGrow: 1 - splitRatio }}
            >
              <div className="tabbedapp-second-header tabbedapp-second-header--row row nowrap">
                {renderSecondHeaderTitle()}
                {renderCloseSplitButton()}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <section className="tabbedapp-content">
        {activeDocument ? (
          /* One document in both panels must stay one TabbedAppDocument:
             mounting it twice would give each panel its own bytes and undo
             history. */
          secondaryDocument && secondaryDocument.id === activeDocument.id ? (
            // Controlled by the shell's own splitRatio: this is the only
            // resizer rendered for a mirrored split, so without this the
            // header row above it (sized off the same state) never follows.
            renderDocumentPanel(activeDocument, {
              secondView: true,
              splitDirection,
              splitRatio,
              onSplitRatioChange: setSplitRatio,
            })
          ) : secondaryDocument ? (
            <div
              className={`tabbedapp-panels ${
                splitDirection === "column" ? "tabbedapp-panels-column" : ""
              }`}
            >
              {renderPanel("left", activeDocument, splitRatio)}
              {renderSplitResizer()}
              {splitDirection === "column" ? (
                <div className="tabbedapp-second-header tabbedapp-second-header--column row nowrap">
                  {renderSecondHeaderTitle()}
                  {renderCloseSplitButton()}
                </div>
              ) : null}
              {renderPanel("right", secondaryDocument, 1 - splitRatio)}
            </div>
          ) : (
            renderDocumentPanel(activeDocument)
          )
        ) : (
          (renderHome?.(homeProps) ?? null)
        )}
      </section>

      {tabContextMenu && tabContextMenuDocument ? (
        <div
          className="panel floating menu z-menu tabbedapp-tab-context-menu"
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={handleMenuKeyDown}
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
            disabled={shellLocked || !tabContextMenuDocumentAvailable}
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
            <PanelsLeftBottom size={15} />
            <span>Create A4 Cornell note for file</span>
          </button>
          <span className="menu-separator" role="separator" />
          {tabContextMenuCanSave ? (
            <button
              disabled={shellLocked || !tabContextMenuDocumentAvailable}
              onClick={() =>
                void runDocumentCommand(tabContextMenuDocument.id, "save")
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
              disabled={shellLocked || !tabContextMenuDocumentAvailable}
              onClick={() =>
                void runDocumentCommand(tabContextMenuDocument.id, "saveAs")
              }
              role="menuitem"
              type="button"
            >
              <SavePlus size={15} />
              <span>Save As...</span>
            </button>
          ) : null}
          {tabContextMenuCanDownload ? (
            <button
              disabled={shellLocked || !tabContextMenuDocumentAvailable}
              onClick={() =>
                void runDocumentCommand(
                  tabContextMenuDocument.id,
                  "downloadCopy",
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
              disabled={shellLocked || !tabContextMenuDocumentAvailable}
              onClick={() =>
                void runDocumentCommand(tabContextMenuDocument.id, "print")
              }
              role="menuitem"
              type="button"
            >
              <Printer size={15} />
              <span>Print</span>
            </button>
          ) : null}
          <span className="menu-separator" role="separator" />
          <button
            disabled={shellLocked}
            onClick={() => openSplit("row", tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <Columns2 size={15} />
            <span>Split Right</span>
          </button>
          <button
            disabled={shellLocked}
            onClick={() => openSplit("column", tabContextMenuDocument.id)}
            role="menuitem"
            type="button"
          >
            <Rows2 size={15} />
            <span>Split Down</span>
          </button>
          <span className="menu-separator" role="separator" />
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
            disabled={
              shellLocked || tabContextMenuIndex >= documents.length - 1
            }
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
          className="backdrop z-modal tabbedapp-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && closeConfirmation) {
              resolveCloseConfirmation("cancel");
            }
          }}
        >
          <CloseDocumentsDialog
            key={closeConfirmation.requestId}
            focusFallbackRef={tabbarRef}
            request={closeConfirmation}
            onCancel={() => resolveCloseConfirmation("cancel")}
            onDiscard={() => resolveCloseConfirmation("discard")}
            onSave={() => resolveCloseConfirmation("save")}
          />
        </div>
      ) : null}

      {saveDestinationDocuments.length > 0 ? (
        <div
          className="backdrop z-modal tabbedapp-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSaveDestinationRequest(null);
            }
          }}
        >
          <SaveDestinationDialog
            documents={saveDestinationDocuments}
            focusFallbackRef={tabbarRef}
            onCancel={() => setSaveDestinationRequest(null)}
            onSaveAs={(documentId) =>
              void resolveSaveDestinationForDocument(documentId)
            }
          />
        </div>
      ) : null}

      {renameDialog ? (
        <div
          className="backdrop z-modal tabbedapp-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setRenameDialog(null);
            }
          }}
        >
          <form
            aria-labelledby={renameDialogTitleId}
            aria-modal="true"
            className="panel floating dialog tabbedapp-modal-surface tabbedapp-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRenameDialog();
            }}
            ref={renameDialogRef}
            role="dialog"
          >
            <h2 className="dialog-title" id={renameDialogTitleId}>
              Rename file
            </h2>
            <label>
              <span>Filename</span>
              <input
                autoFocus
                value={renameDialog.value}
                onChange={(event) =>
                  setRenameDialog((current) =>
                    current
                      ? { ...current, value: event.target.value }
                      : current,
                  )
                }
              />
            </label>
            <div className="dialog-actions">
              <button
                className=""
                type="button"
                onClick={() => setRenameDialog(null)}
              >
                Cancel
              </button>
              <button className="primary" type="submit">
                Save
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {showDropPanel ? (
        <div className="backdrop z-top tabbedapp-modal-backdrop tabbedapp-drop-backdrop">
          <div
            aria-live="polite"
            className="panel floating tabbedapp-modal-surface tabbedapp-drop-card row nowrap md"
            role="status"
          >
            <FolderOpen size={22} />
            <span>Drop PDFs to open</span>
          </div>
        </div>
      ) : null}
    </main>
  );
});

function CloseDocumentsDialog({
  focusFallbackRef,
  onCancel,
  onDiscard,
  onSave,
  request,
}: {
  focusFallbackRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  request: TabbedAppCloseDocumentsRequest;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true, focusFallbackRef);
  const dirtyDocuments = request.documents.filter(
    (document) => document.hasUnsavedChanges,
  );
  const hiddenDirtyCount = Math.max(0, dirtyDocuments.length - 4);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <section
      aria-labelledby={titleId}
      aria-modal="true"
      className="panel floating dialog tabbedapp-modal-surface tabbedapp-file-list-dialog tabbedapp-close-dialog"
      ref={dialogRef}
      role="dialog"
    >
      <h2 className="dialog-title" id={titleId}>
        There are unsaved changes
      </h2>
      <p>The following file(s) have unsaved changes:</p>
      {dirtyDocuments.length > 0 ? (
        <ul aria-label="Unsaved PDFs">
          {dirtyDocuments.slice(0, 4).map((document) => (
            <li className="truncate" key={document.id}>
              {document.title}
            </li>
          ))}
          {hiddenDirtyCount > 0 ? (
            <li className="truncate">
              {hiddenDirtyCount} more PDF
              {hiddenDirtyCount === 1 ? "" : "s"}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="dialog-actions">
        <button
          autoFocus={!request.canSaveChanges}
          className=""
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button className="danger-outline" onClick={onDiscard} type="button">
          Discard changes
        </button>
        {request.canSaveChanges ? (
          <button autoFocus className="primary" onClick={onSave} type="button">
            Save changes
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SaveDestinationDialog({
  documents,
  focusFallbackRef,
  onCancel,
  onSaveAs,
}: {
  documents: TabbedAppOpenDocument[];
  focusFallbackRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onSaveAs: (documentId: string) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true, focusFallbackRef);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <section
      aria-labelledby={titleId}
      aria-modal="true"
      className="panel floating dialog tabbedapp-modal-surface tabbedapp-file-list-dialog"
      ref={dialogRef}
      role="dialog"
    >
      <h2 className="dialog-title" id={titleId}>
        Choose where to save
      </h2>
      <p>These don&rsquo;t have a file of their own to save back to yet:</p>
      <ul aria-label="Files needing a save location">
        {documents.map((document) => (
          <li
            className="tabbedapp-save-destination-row row nowrap"
            key={document.id}
          >
            <span className="truncate">{document.title}</span>
            <button
              className="compact"
              disabled={!documentCanSaveAs(document)}
              onClick={() => onSaveAs(document.id)}
              type="button"
            >
              Save as...
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
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
  onRegisterDocumentRef,
  onSplitRatioChange,
  onTitleChange,
  secondView,
  splitDirection,
  splitRatio,
  documentOptions,
}: {
  document: TabbedAppOpenDocument;
  onBusyChange: (documentId: string, busy: boolean) => void;
  onCloseDocument: (
    documentId: string,
    options?: { skipConfirm?: boolean },
  ) => Promise<boolean>;
  onDirtyChange: (documentId: string, hasUnsavedChanges: boolean) => void;
  onRegisterDocumentRef: (
    documentId: string,
  ) => RefCallback<TabbedAppDocumentHandle>;
  onSplitRatioChange?: Dispatch<SetStateAction<number>>;
  onTitleChange: (documentId: string, title: string) => void;
  secondView?: boolean;
  splitDirection?: SplitAxis;
  splitRatio?: number;
  documentOptions: TabbedAppDocumentOptions;
}) {
  const handleDirtyChange = useCallback(
    (hasUnsavedChanges: boolean) =>
      onDirtyChange(document.id, hasUnsavedChanges),
    [document.id, onDirtyChange],
  );
  const handleTitleChange = useCallback(
    (title: string) => onTitleChange(document.id, title),
    [document.id, onTitleChange],
  );
  const handleBusyChange = useCallback(
    (busy: boolean) => onBusyChange(document.id, busy),
    [document.id, onBusyChange],
  );

  return (
    <Suspense
      fallback={
        <div className="tabbedapp-document-pane tabbedapp-document-pane-loading">
          Loading…
        </div>
      }
    >
      <TabbedAppDocument
        className="tabbedapp-document-pane"
        enableGlobalShortcuts
        enableWheelZoom
        initialSession={document.session}
        manageDocumentTitle={false}
        confirmDiscardChanges={documentOptions.confirmDiscardChanges}
        onClose={() => void onCloseDocument(document.id, { skipConfirm: true })}
        onBusyChange={handleBusyChange}
        onDirtyChange={handleDirtyChange}
        onDocumentTitleChange={handleTitleChange}
        onOpenExternalLink={documentOptions.onOpenExternalLink}
        pickImageFile={documentOptions.pickImageFile}
        pickMergePdfFile={documentOptions.pickMergePdfFile}
        printTarget={documentOptions.printTarget}
        ref={onRegisterDocumentRef(document.id)}
        secondView={secondView}
        splitDirection={splitDirection}
        splitRatio={splitRatio}
        onSplitRatioChange={onSplitRatioChange}
        allowEditing={documentOptions.allowEditing ?? true}
        allowImageAnnotations={documentOptions.allowImageAnnotations}
        showCloseButton={false}
        source={document.source}
      />
    </Suspense>
  );
}

function applySessionToDocument(
  document: TabbedAppOpenDocument,
  session: SensitiveTabbedAppDocumentSession,
): TabbedAppOpenDocument {
  return {
    ...document,
    fileKey: session.fileKey ?? document.fileKey,
    hasUnsavedChanges: session.hasUnsavedChanges,
    session,
    source: {
      kind: "bytes",
      fileKey: session.fileKey ?? document.source.fileKey,
      saveTarget:
        session.readOnlyReason && session.editingEnabled
          ? null
          : (session.saveTarget ?? document.source.saveTarget ?? null),
      downloadTarget:
        session.downloadTarget ?? document.source.downloadTarget ?? null,
      saveAsTarget:
        session.saveAsTarget ?? document.source.saveAsTarget ?? null,
      bytes: session.pdfBytes,
      name: session.fileName,
      sourceId: session.sourceId,
    },
    title: session.fileName,
  };
}

function documentCanSave(document: TabbedAppOpenDocument) {
  return documentCanSaveAs(document) || Boolean(documentSaveTarget(document));
}

function documentCanSaveAs(document: TabbedAppOpenDocument) {
  return Boolean(documentSaveAsTarget(document));
}

function documentCanDownload(document: TabbedAppOpenDocument) {
  return Boolean(
    document.session?.downloadTarget ?? document.source.downloadTarget,
  );
}

function documentSaveTarget(document: TabbedAppOpenDocument) {
  return document.session?.saveTarget ?? document.source.saveTarget ?? null;
}

function documentSaveAsTarget(document: TabbedAppOpenDocument) {
  return document.session?.saveAsTarget ?? document.source.saveAsTarget ?? null;
}

function nextDocumentId(name: string, nextDocumentIdRef: { current: number }) {
  nextDocumentIdRef.current += 1;
  return `web:${nextDocumentIdRef.current}:${name}`;
}

function panelDocumentIds(left: string | null, right: string | null) {
  return [...new Set([left, right])].filter((id): id is string => id !== null);
}

function isFileDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files");
}

function canOpenDroppedFiles(fileAdapter: TabbedAppHostAdapter) {
  return Boolean(
    fileAdapter.pdfDocumentsFromDrop || fileAdapter.pdfDocumentsFromFileInput,
  );
}

// A title is a filename, so it is untrusted: a document opened through the
// imperative API is titled from `source.name` before the core sees it, so the
// character rules have to be applied on this side too.
function cleanDocumentTitle(title: string) {
  return displayableFileName(title.replace(/^\*/, ""));
}

function filenameStem(title: string) {
  const filename = cleanDocumentTitle(title).split(/[\\/]/).pop() ?? title;
  const extensionStart = filename.lastIndexOf(".");
  return extensionStart > 0 ? filename.slice(0, extensionStart) : filename;
}

function cornellNoteStem(stem: string) {
  return `NOTE - ${stem}`;
}

function cornellTitleAnnotation(text: string): PdfAnnotation {
  const titleLineHeight = 14 * 1.25;
  const titleHeight = titleLineHeight * 3 + 4;

  return {
    id: crypto.randomUUID(),
    kind: "freeText",
    pageIndex: 0,
    rect: {
      x1: CORNELL_CONTENT_BOUNDS.left,
      y1: CORNELL_CONTENT_BOUNDS.titleTop - titleHeight,
      x2: CORNELL_CONTENT_BOUNDS.right,
      y2: CORNELL_CONTENT_BOUNDS.titleTop,
    },
    text,
    fontSize: 14,
    color: [0.09, 0.11, 0.11],
    opacity: 1,
    layoutWidth: CORNELL_CONTENT_BOUNDS.titleWidth,
  };
}

// The callback is mirrored in a ref, not listed as a dependency: the shell's
// close handlers are inline, so depending on one re-subscribes every render.
function useDismissOnOutsidePress(
  open: boolean,
  insideSelector: string,
  dismiss: () => void,
) {
  const dismissRef = useLatestRef(dismiss);
  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest(insideSelector)) {
        return;
      }

      dismissRef.current();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismissRef.current();
      }
    }

    function handleResize() {
      dismissRef.current();
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [open, insideSelector, dismissRef]);
}

function clampContextMenuPosition(x: number, y: number) {
  return clampMenuPosition(x, y, 256, 172);
}

function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  );
  if (items.length === 0) {
    return;
  }

  event.preventDefault();
  const currentIndex = items.indexOf(
    document.activeElement as HTMLButtonElement,
  );
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? currentIndex < 0
            ? 0
            : (currentIndex + 1) % items.length
          : currentIndex < 0
            ? items.length - 1
            : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex].focus();
}

function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
) {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin)),
  };
}

// The tab-list toggle lives at the bar's own right edge, so this menu opens
// right-edge anchored rather than left-anchored like the others: positioned
// with CSS `right`, not `left`, its own right edge lands exactly on the
// button's regardless of the menu's actual max-content width - clampMenuPosition's
// left-anchored math would leave a gap sized to however far that width falls
// short of its own assumed maximum. `right`'s returned x is a distance from
// the viewport's right edge, not the left one.
function clampTabListMenuPosition(buttonRight: number, y: number) {
  const margin = 8;
  const menuMaxWidth = 352; // matches .tabbedapp-tab-list-menu's own max-width
  const menuMaxHeight = 352; // matches .tabbedapp-tab-list-menu's own max-height
  const rawRight = window.innerWidth - buttonRight;
  return {
    x: Math.max(
      margin,
      Math.min(rawRight, window.innerWidth - menuMaxWidth - margin),
    ),
    y: Math.max(
      margin,
      Math.min(y, window.innerHeight - menuMaxHeight - margin),
    ),
  };
}
