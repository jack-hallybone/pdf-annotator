import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { ChevronRight } from "lucide-react";
import { PdfDocumentEditor } from "../pdfdocumenteditor";
import type {
  PdfDocumentEditorCloseRequest,
  PdfDocumentEditorFindResults,
  PdfDocumentEditorHandle,
  PdfDocumentEditorReadOnlyState,
  PdfDocumentEditorViewState,
} from "../pdfdocumenteditor";
import type {
  PdfDocumentEditorSource,
  PdfDocumentEditorHostCapabilities,
  PdfSaveTargetChange,
  PdfSaveWithResult,
  SplitAxis,
} from "../pdfdocumenteditor";
import { canEditReadOnlyCopy } from "../pdfdocumenteditor";
import { usesAnnotationLayer } from "../pdfdocumenteditor";
import { ZOOM_STEP } from "../pdfdocumenteditor";
import type { Tool, ToolPresetMap, ToolSettings } from "../pdfdocumenteditor";
import { SIDEBAR_DEFAULT_WIDTH } from "./sidebarConfig";
import { composeTabbedAppSession } from "./tabbedAppSession";
import type { SensitiveTabbedAppDocumentSession } from "./tabbedAppSession";
export type {
  TabbedAppDocumentChromeState,
  SensitiveTabbedAppDocumentSession,
} from "./tabbedAppSession";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { FindBar } from "./components/FindBar";
import type { DocumentSidebarTab } from "./components/DocumentSidebar";
import {
  EMPTY_ANNOTATION_FILTER,
  annotationListMarkdown,
} from "./annotationList";
import type { AnnotationListFilter, AnnotationListRow } from "./annotationList";
import {
  FloatingBackControl,
  FloatingDocumentControls,
  FloatingHistoryControls,
  FloatingToolDock,
  FloatingZoomControls,
} from "./components/FloatingControls";
import {
  ExternalLinkDialog,
  PasswordUnlockForm,
} from "./components/TabbedAppDialogs";
import {
  ReadOnlyBanner,
  TabbedAppNoticeStack,
} from "./components/TabbedAppNotices";
import {
  createDefaultToolPresets,
  defaultToolKeyForTool,
  defaultToolSettings,
  isDrawToolKey,
  pickDrawSettings,
  tools,
} from "./toolConfig";
import { useExternalLinks } from "./useExternalLinks";
import { useTabbedAppNotices } from "./useTabbedAppNotices";

// A host for the document editor core: it owns no document state and reaches the core only through the command API on PdfDocumentEditorHandle.

const NO_FIND_RESULTS: PdfDocumentEditorFindResults = {
  complete: false,
  current: 0,
  total: 0,
};

export type TabbedAppDocumentHandle = {
  // A sensitive in-memory session; discard it when the tab is closed.
  captureSessionForTabCache: () => SensitiveTabbedAppDocumentSession | null;
  downloadCopy: () => Promise<void>;
  print: () => Promise<void>;
  releaseRenderResources: () => Promise<void>;
  save: () => Promise<boolean>;
  saveAs: (suggestedName?: string) => Promise<boolean>;
  /** Save through a writer the host supplies; see PdfDocumentEditorHandle.saveWith. */
  saveWith: (
    write: (bytes: Uint8Array) => Promise<PdfSaveWithResult | void>,
  ) => Promise<boolean>;
};

export type TabbedAppDocumentProps = PdfDocumentEditorHostCapabilities & {
  allowEditing?: boolean;
  allowImageAnnotations?: boolean;
  className?: string;
  confirmDiscardChanges?: (
    request: PdfDocumentEditorCloseRequest,
  ) => boolean | Promise<boolean>;
  emptyTitle?: string;
  enableGlobalShortcuts?: boolean;
  enableWheelZoom?: boolean;
  initialSession?: SensitiveTabbedAppDocumentSession | null;
  manageDocumentTitle?: boolean;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (hasUnsavedChanges: boolean) => void;
  onDocumentTitleChange?: (title: string) => void;
  onSaveTargetChange?: (change: PdfSaveTargetChange) => void;
  /** The chrome is the document's, not a view's, so it stays with the first. */
  secondView?: boolean;
  showCloseButton?: boolean;
  source: PdfDocumentEditorSource;
  splitDirection?: SplitAxis;
  // Passed straight through to PdfDocumentEditor: see its own doc comment.
  splitRatio?: number;
  onSplitRatioChange?: Dispatch<SetStateAction<number>>;
  style?: CSSProperties;
};

export const TabbedAppDocument = forwardRef<
  TabbedAppDocumentHandle,
  TabbedAppDocumentProps
>(function TabbedAppDocument(
  {
    allowEditing = true,
    allowImageAnnotations = true,
    className,
    confirmDiscardChanges,
    emptyTitle,
    enableGlobalShortcuts = true,
    enableWheelZoom = true,
    initialSession = null,
    manageDocumentTitle = true,
    onClose,
    onBusyChange,
    onDirtyChange,
    onDocumentTitleChange,
    onSaveTargetChange,
    onOpenExternalLink,
    pickImageFile,
    pickMergePdfFile,
    printTarget = null,
    secondView = false,
    showCloseButton = true,
    source,
    splitDirection,
    splitRatio,
    onSplitRatioChange,
    style,
  },
  ref,
) {
  const documentEditorRef = useRef<PdfDocumentEditorHandle | null>(null);
  const initialSessionRef = useRef(initialSession);
  initialSessionRef.current = initialSession;
  const sourceIdRef = useRef(source.sourceId);
  sourceIdRef.current = source.sourceId;
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState("document.pdf");
  const [activeToolKey, setActiveToolKey] = useState("select");
  const [toolSettings, setToolSettings] =
    useState<ToolSettings>(defaultToolSettings);
  const [toolPresets, setToolPresets] = useState<ToolPresetMap>(
    createDefaultToolPresets,
  );
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<DocumentSidebarTab>("pages");
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [annotationFilter, setAnnotationFilter] =
    useState<AnnotationListFilter>(EMPTY_ANNOTATION_FILTER);
  const [settingsToolKey, setSettingsToolKey] = useState<string | null>(null);
  const [pageMenuIndex, setPageMenuIndex] = useState<number | null>(null);
  const [readOnlyState, setReadOnlyState] =
    useState<PdfDocumentEditorReadOnlyState>({
      canUnlockOriginal: false,
      readOnly: false,
      ready: false,
      reason: null,
    });
  const [findOpen, setFindOpen] = useState(false);
  // Kept while the bar is closed, so reopening it offers the last search again.
  const [findQuery, setFindQuery] = useState("");
  const [findResults, setFindResults] = useState(NO_FIND_RESULTS);
  // Bumped by every Ctrl+F, including one while the bar is open, which takes the reader back to the field.
  const [findFocusRequest, setFindFocusRequest] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  // Where focus was before Ctrl+F, for closing the bar to give it back.
  const findReturnFocusRef = useRef<HTMLElement | null>(null);
  const {
    notices,
    showNotice,
    dismissNotice,
    reportMalformedAnnotations,
    pauseNoticeTimers,
    resumeNoticeTimers,
  } = useTabbedAppNotices();
  const {
    pendingExternalLink,
    cancelButtonRef: externalLinkCancelButtonRef,
    requestExternalLink,
    confirmExternalLink,
    cancelExternalLink,
    reset: resetExternalLinks,
  } = useExternalLinks({
    onOpenExternalLink,
    fileName,
    sourceIdRef,
    showNotice,
  });

  // Derived rather than tracked, so it cannot drift from `activeToolKey`.
  const tool =
    tools.find((item) => item.key === activeToolKey)?.tool ?? "select";

  // The sidebar overlays the viewport, so the core's ResizeObserver never sees it move and has to be told.
  useEffect(() => {
    documentEditorRef.current?.remeasureViewport();
  }, [sidebarOpen, sidebarWidth]);

  useEffect(() => {
    if (findFocusRequest > 0) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [findFocusRequest]);

  // Stable identity, because the sidebar calls this from an effect.
  const ensureAllAnnotations = useCallback(() => {
    void documentEditorRef.current?.importAllAnnotations();
  }, []);

  useImperativeHandle(ref, () => ({
    captureSessionForTabCache: () => {
      const session = documentEditorRef.current?.captureSessionForTabCache();
      if (!session) {
        return null;
      }

      return composeTabbedAppSession(session, {
        // The image tool only lasts while its menu is open, and a restored tab reopens no menu.
        activeToolKey:
          activeToolKey === "imageStamp" ? "select" : activeToolKey,
        annotationFilter,
        showAnnotations,
        sidebarOpen,
        sidebarTab,
        sidebarWidth,
        toolPresets,
        toolSettings,
      });
    },
    downloadCopy: async () => {
      await documentEditorRef.current?.downloadCopy();
    },
    print: async () => {
      await documentEditorRef.current?.print();
    },
    releaseRenderResources: async () => {
      await documentEditorRef.current?.releaseRenderResources();
    },
    save: async () => (await documentEditorRef.current?.save()) ?? false,
    saveAs: async (suggestedName?: string) =>
      (await documentEditorRef.current?.saveAs(suggestedName)) ?? false,
    saveWith: async (write) =>
      (await documentEditorRef.current?.saveWith(write)) ?? false,
  }));

  const handleDocumentTitleChange = useCallback(
    (title: string) => {
      setFileName(title);
      onDocumentTitleChange?.(title);
    },
    [onDocumentTitleChange],
  );

  // The image tool stays selected while its menu, or the picker one of its items opens, is up. Closing the menu any other way drops back to Select, not to the tool that was selected before it.
  const closeToolSettings = useCallback(() => {
    setSettingsToolKey(null);
    setActiveToolKey((current) =>
      current === "imageStamp" ? "select" : current,
    );
  }, []);

  const openFind = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest(".find-bar")) {
      findReturnFocusRef.current = active;
    }
    setFindOpen(true);
    setFindFocusRequest((request) => request + 1);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    const returnFocus = findReturnFocusRef.current;
    findReturnFocusRef.current = null;
    if (returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, []);

  const handleDocumentReset = useCallback(() => {
    setPageMenuIndex(null);
    setFindOpen(false);
    closeToolSettings();
    setSidebarOpen(false);
    setSidebarTab("pages");
    setAnnotationFilter(EMPTY_ANNOTATION_FILTER);
    resetExternalLinks();
  }, [closeToolSettings, resetExternalLinks]);

  const handleSessionRestore = useCallback(() => {
    const chrome = initialSessionRef.current?.chrome;
    if (!chrome) {
      return;
    }

    setActiveToolKey(
      tools.some((item) => item.key === chrome.activeToolKey)
        ? chrome.activeToolKey
        : "select",
    );
    setToolSettings(chrome.toolSettings);
    setToolPresets(chrome.toolPresets);
    setShowAnnotations(chrome.showAnnotations);
    setSidebarOpen(chrome.sidebarOpen);
    setSidebarTab(chrome.sidebarTab);
    setSidebarWidth(chrome.sidebarWidth);
    setAnnotationFilter(chrome.annotationFilter);
  }, []);

  const handleCoreToolChange = useCallback((nextTool: Tool) => {
    setActiveToolKey(defaultToolKeyForTool(nextTool));
    setSettingsToolKey(null);
  }, []);

  function selectDockTool(toolKey: string, view: PdfDocumentEditorViewState) {
    if (view.readOnly || view.busy) {
      return;
    }

    const item = tools.find((candidate) => candidate.key === toolKey);
    if (!item) {
      return;
    }

    window.getSelection()?.removeAllRanges();
    documentEditorRef.current?.finishAnnotationEdit();
    documentEditorRef.current?.clearAnnotationSelection();
    const preset = toolPresets[toolKey] ?? item.preset;
    if (preset) {
      setToolSettings((current) => ({ ...current, ...preset }));
    }
    if (usesAnnotationLayer(item.tool)) {
      setShowAnnotations(true);
    }
    setActiveToolKey(toolKey);
    setSettingsToolKey(null);
  }

  function updateToolSettings(
    update: Partial<ToolSettings>,
    view: PdfDocumentEditorViewState,
  ) {
    if (view.readOnly || view.busy) {
      return;
    }

    // A pen remembers its own colour and stroke.
    const targetToolKey = settingsToolKey ?? activeToolKey;
    if (targetToolKey && isDrawToolKey(targetToolKey)) {
      const drawUpdate = pickDrawSettings(update);
      if (Object.keys(drawUpdate).length > 0) {
        setToolPresets((current) => ({
          ...current,
          [targetToolKey]: { ...current[targetToolKey], ...drawUpdate },
        }));
      }
    }

    setToolSettings((current) => ({ ...current, ...update }));
  }

  function toggleAnnotations(view: PdfDocumentEditorViewState) {
    if (view.busy) {
      return;
    }

    if (showAnnotations) {
      documentEditorRef.current?.finishAnnotationEdit();
    }

    const next = !showAnnotations;
    setShowAnnotations(next);
    if (!next) {
      setActiveToolKey("select");
      setSettingsToolKey(null);
      documentEditorRef.current?.clearAnnotationSelection();
    }
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = passwordInputRef.current?.value ?? "";
    if (!password) {
      passwordInputRef.current?.focus();
      return;
    }

    passwordInputRef.current!.value = "";
    documentEditorRef.current?.submitPassword(password);
  }

  // Not shown before the document is on screen.
  const readOnlyBannerReason =
    readOnlyState.ready && readOnlyState.readOnly ? readOnlyState.reason : null;

  // The menu closes only once the operation has run.
  async function runPageOperation(operation: Promise<void>) {
    await operation;
    setPageMenuIndex(null);
  }

  // Plain text, so it pastes as Markdown wherever it lands.
  async function copyAnnotationsAsMarkdown(
    rows: AnnotationListRow[],
    fileName: string,
  ) {
    const { count, markdown } = annotationListMarkdown(rows, fileName);
    if (count === 0) {
      showNotice("These annotations have no text to copy.", {
        tone: "warning",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      showNotice(
        `Copied ${count} annotation${count === 1 ? "" : "s"} as Markdown.`,
        { tone: "success" },
      );
    } catch {
      showNotice("Could not copy the annotations.", { tone: "danger" });
    }
  }

  return (
    <main
      className={[
        "tabbedapp-document",
        "document-shell",
        className ?? "document-shell--fullscreen",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      {/* Outside the core, not in its overlay slot: below 700px this docks in flow and has to push the whole core - viewport and floating chrome together - down the page. */}
      {notices.length > 0 || readOnlyBannerReason || findOpen ? (
        <TabbedAppNoticeStack
          notices={notices}
          onDismissNotice={dismissNotice}
          onPauseTimers={pauseNoticeTimers}
          onResumeTimers={resumeNoticeTimers}
        >
          {findOpen ? (
            <FindBar
              inputRef={findInputRef}
              onClose={closeFind}
              onNext={() => documentEditorRef.current?.findNext()}
              onPrevious={() => documentEditorRef.current?.findPrevious()}
              onQueryChange={setFindQuery}
              query={findQuery}
              results={findResults}
            />
          ) : null}
          {readOnlyBannerReason ? (
            <ReadOnlyBanner
              canEditCopy={canEditReadOnlyCopy(readOnlyBannerReason)}
              canUnlockOriginal={readOnlyState.canUnlockOriginal}
              onEnableEditing={() => documentEditorRef.current?.enableEditing()}
              onUnlockOriginal={() =>
                documentEditorRef.current?.unlockOriginal()
              }
              reason={readOnlyBannerReason}
            />
          ) : null}
        </TabbedAppNoticeStack>
      ) : null}

      <PdfDocumentEditor
        allowEditing={allowEditing}
        allowImageAnnotations={allowImageAnnotations}
        className="tabbedapp-document-viewport grow"
        confirmDiscardChanges={confirmDiscardChanges}
        emptyTitle={emptyTitle}
        enableGlobalShortcuts={enableGlobalShortcuts}
        enableWheelZoom={enableWheelZoom}
        findQuery={findOpen ? findQuery : ""}
        initialSession={initialSession}
        manageDocumentTitle={manageDocumentTitle}
        onBusyChange={onBusyChange}
        onClose={onClose}
        onDirtyChange={onDirtyChange}
        onDocumentReplaced={() => {
          setPageMenuIndex(null);
          closeToolSettings();
        }}
        onDocumentReset={handleDocumentReset}
        onDocumentTitleChange={handleDocumentTitleChange}
        onExternalLinkRequest={requestExternalLink}
        onFindRequest={openFind}
        onFindResultsChange={setFindResults}
        onMalformedAnnotations={reportMalformedAnnotations}
        onNotice={showNotice}
        onSaveTargetChange={onSaveTargetChange}
        onReadOnlyChange={setReadOnlyState}
        onSessionRestore={handleSessionRestore}
        onShowAnnotationsChange={setShowAnnotations}
        onToolChange={handleCoreToolChange}
        pickImageFile={pickImageFile}
        pickMergePdfFile={pickMergePdfFile}
        printTarget={printTarget}
        ref={documentEditorRef}
        secondView={secondView}
        showAnnotations={showAnnotations}
        source={source}
        splitDirection={splitDirection}
        splitRatio={splitRatio}
        onSplitRatioChange={onSplitRatioChange}
        tool={tool}
        toolSettings={toolSettings}
      >
        {(view) => (
          <>
            {view.ready && view.pages.length > 0 ? (
              <DocumentSidebar
                activePageIndex={view.activePageIndex}
                annotationFilter={annotationFilter}
                annotationsByPage={view.annotationsByPage}
                annotationsComplete={view.annotationsComplete}
                busy={view.busy}
                canMergePdf={view.mergeAvailable}
                onChangeAnnotationFilter={setAnnotationFilter}
                onChangeTab={setSidebarTab}
                onCopyAnnotationsMarkdown={(rows) =>
                  void copyAnnotationsAsMarkdown(rows, view.fileName)
                }
                onEnsureAllAnnotations={ensureAllAnnotations}
                onRevealAnnotation={(annotationId) =>
                  documentEditorRef.current?.revealAnnotation(annotationId)
                }
                onSelectOutlineDestination={(destination) =>
                  void documentEditorRef.current?.goToDestination(destination)
                }
                onSetAnnotationBookmarked={(annotationId, bookmarked) =>
                  documentEditorRef.current?.setAnnotationBookmarked(
                    annotationId,
                    bookmarked,
                  )
                }
                onSetAnnotationComment={(annotationId, comment) =>
                  documentEditorRef.current?.setAnnotationComment(
                    annotationId,
                    comment,
                  )
                }
                outline={view.outline}
                selectedAnnotationIds={view.selectedAnnotationIds}
                tab={sidebarTab}
                onAddPage={(pageIndex, position, kind) =>
                  void runPageOperation(
                    documentEditorRef.current?.insertPage(
                      pageIndex,
                      position,
                      kind,
                    ) ?? Promise.resolve(),
                  )
                }
                onClose={() => setSidebarOpen(false)}
                onDeletePage={(pageIndex) =>
                  void runPageOperation(
                    documentEditorRef.current?.deletePage(pageIndex) ??
                      Promise.resolve(),
                  )
                }
                onMergePdf={() =>
                  void documentEditorRef.current?.appendDocument()
                }
                onMovePageDown={(pageIndex) =>
                  void runPageOperation(
                    documentEditorRef.current?.reorderPages(
                      pageIndex ?? view.activePageIndex,
                      1,
                    ) ?? Promise.resolve(),
                  )
                }
                onMovePageUp={(pageIndex) =>
                  void runPageOperation(
                    documentEditorRef.current?.reorderPages(
                      pageIndex ?? view.activePageIndex,
                      -1,
                    ) ?? Promise.resolve(),
                  )
                }
                onRotatePage={(pageIndex) =>
                  void runPageOperation(
                    documentEditorRef.current?.rotatePage(pageIndex) ??
                      Promise.resolve(),
                  )
                }
                onSelectPage={(pageIndex) =>
                  documentEditorRef.current?.goToPage(pageIndex)
                }
                onThumbnailPageLoad={(page, pageIndex) =>
                  documentEditorRef.current?.ensurePageLoaded(page, pageIndex)
                }
                onWidthChange={setSidebarWidth}
                open={sidebarOpen}
                pageSize={view.pageSize}
                pageMenuIndex={pageMenuIndex}
                pdfDoc={view.pdfDoc}
                pages={view.pages}
                readOnly={view.readOnly}
                setPageMenuIndex={setPageMenuIndex}
                showAnnotations={showAnnotations}
                width={sidebarWidth}
              />
            ) : null}

            {view.ready && view.pages.length > 0 && !sidebarOpen ? (
              <div className="sidebar-toggle panel raised z-floating no-print">
                <button
                  aria-label="Show sidebar"
                  className="icon-button ghost icon-center"
                  disabled={view.busy}
                  onClick={() => setSidebarOpen(true)}
                  title="Show sidebar"
                  type="button"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            ) : null}

            {view.ready && view.pages.length > 0 ? (
              <>
                {!view.readOnly ? (
                  <FloatingToolDock
                    activeTool={tool}
                    activeToolKey={activeToolKey}
                    disabled={view.busy}
                    onChangeSettings={(update) =>
                      updateToolSettings(update, view)
                    }
                    onCloseSettings={closeToolSettings}
                    onPasteImageFile={() => {
                      setSettingsToolKey(null);
                      void documentEditorRef.current?.addImageFromSystemClipboard();
                    }}
                    onPickImageFile={() => {
                      setSettingsToolKey(null);
                      void documentEditorRef.current?.addImageFromPicker();
                    }}
                    onSelectTool={(toolKey) => selectDockTool(toolKey, view)}
                    onToggleSettings={(nextToolKey) =>
                      setSettingsToolKey((current) =>
                        current === nextToolKey ? null : nextToolKey,
                      )
                    }
                    settings={toolSettings}
                    settingsToolKey={settingsToolKey}
                    toolDefinitions={
                      view.imageAnnotationsAvailable
                        ? tools
                        : tools.filter((item) => item.tool !== "imageStamp")
                    }
                    toolPresets={toolPresets}
                  />
                ) : null}

                <FloatingDocumentControls
                  busy={view.busy}
                  onClosePdf={() =>
                    void documentEditorRef.current?.requestClose()
                  }
                  onDownload={
                    view.downloadAvailable
                      ? () => void documentEditorRef.current?.downloadCopy()
                      : undefined
                  }
                  onFind={view.pages.length > 0 ? openFind : undefined}
                  onPrint={
                    view.printAvailable
                      ? () => void documentEditorRef.current?.print()
                      : undefined
                  }
                  onSave={
                    view.saveAvailable
                      ? () => void documentEditorRef.current?.save()
                      : undefined
                  }
                  onSaveAs={
                    view.saveAsAvailable
                      ? () => void documentEditorRef.current?.saveAs()
                      : undefined
                  }
                  saveLabel="Save"
                  onToggleAnnotations={() => toggleAnnotations(view)}
                  showCloseButton={showCloseButton}
                  showAnnotations={showAnnotations}
                />

                <FloatingZoomControls
                  activePageIndex={view.activePageIndex}
                  disabled={view.busy}
                  onDefaultZoom={() => documentEditorRef.current?.resetZoom()}
                  onFitHeight={() => documentEditorRef.current?.fitHeight()}
                  onFitWidth={() => documentEditorRef.current?.fitWidth()}
                  onJumpToPage={(pageNumber) =>
                    documentEditorRef.current?.goToPage(pageNumber - 1)
                  }
                  onSetZoom={(nextScale) =>
                    documentEditorRef.current?.setZoom(nextScale)
                  }
                  pageCount={view.pages.length}
                  scale={view.scale}
                  onZoomIn={() => documentEditorRef.current?.zoomBy(ZOOM_STEP)}
                  onZoomOut={() =>
                    documentEditorRef.current?.zoomBy(-ZOOM_STEP)
                  }
                />

                {view.backPageIndex !== null ? (
                  <FloatingBackControl
                    disabled={view.busy}
                    onBack={() => documentEditorRef.current?.goBack()}
                    pageIndex={view.backPageIndex}
                    sidebarOpen={sidebarOpen}
                    sidebarWidth={sidebarWidth}
                    stacked={!view.readOnly}
                  />
                ) : null}

                {!view.readOnly ? (
                  <FloatingHistoryControls
                    canRedo={view.canRedo}
                    canUndo={view.canUndo}
                    disabled={view.busy}
                    onRedo={() => void documentEditorRef.current?.redo()}
                    onUndo={() => void documentEditorRef.current?.undo()}
                    sidebarOpen={sidebarOpen}
                    sidebarWidth={sidebarWidth}
                  />
                ) : null}
              </>
            ) : null}

            {!view.ready ? (
              <div className="loading-overlay z-dropdown no-print">
                {view.passwordRequired ? (
                  <PasswordUnlockForm
                    failed={view.passwordRetry}
                    inputRef={passwordInputRef}
                    onSubmit={submitPassword}
                  />
                ) : (
                  <div
                    className={
                      view.loadError
                        ? "loading-message loading-message-error row nowrap"
                        : "loading-message row nowrap"
                    }
                    // Announcing progress as an alert interrupts a reader.
                    role={view.loadError ? "alert" : "status"}
                  >
                    <span>{view.loadError ?? "Loading..."}</span>
                    {view.loadError ? (
                      <button
                        className="loading-retry-button"
                        onClick={() => documentEditorRef.current?.retryLoad()}
                        type="button"
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            {pendingExternalLink ? (
              <ExternalLinkDialog
                link={pendingExternalLink}
                onCancel={cancelExternalLink}
                onOpen={(always) => confirmExternalLink({ always })}
                cancelButtonRef={externalLinkCancelButtonRef}
              />
            ) : null}
          </>
        )}
      </PdfDocumentEditor>
    </main>
  );
});
