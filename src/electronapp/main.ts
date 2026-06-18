import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell
} from 'electron';
import type {
  MessageBoxOptions,
  OpenDialogOptions,
  SaveDialogOptions
} from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safePdfFileName } from '../fileNames.js';
import { electronIpcChannels } from './ipc.js';
import type { DesktopImageFile, DesktopPdfDocument } from './bridge.js';

type DesktopFileRecord = {
  filePath: string;
  ownerWebContentsId: number;
};

type DesktopWindowState = {
  closeConfirmed: boolean;
  closeRequestPending: boolean;
  closeRequestTimer: NodeJS.Timeout | null;
};

const appProtocol = 'pdfannotator';
const allowedExternalProtocols = new Set(['http:', 'https:', 'mailto:']);
const closeConfirmationTimeoutMs = 15000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const rendererDistDir = app.isPackaged
  ? path.join(app.getAppPath(), 'dist')
  : path.join(projectRoot, 'dist');
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(projectRoot, 'build', 'icon.ico');
const preloadPath = path.join(__dirname, 'preload.cjs');
const devRendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || null;
const fileRecordsById = new Map<string, DesktopFileRecord>();
const pendingOpenPathsByWindowId = new Map<number, string[]>();
const windowStates = new Map<number, DesktopWindowState>();

let activeWindow: BrowserWindow | null = null;
let primaryWindow: BrowserWindow | null = null;

protocol.registerSchemesAsPrivileged([
  {
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true
    },
    scheme: appProtocol
  }
]);
app.enableSandbox();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    void openPathsInExistingWindow(pdfPathsFromArgs(argv));
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    void openPathsInExistingWindow([filePath]);
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    configureSessionSecurity();
    registerIpcHandlers();
    const window = await createMainWindow();
    queueOpenPaths(pdfPathsFromArgs(process.argv), window);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
      return;
    }

    preferredOpenWindow()?.show();
  });
}

async function createMainWindow() {
  const window = new BrowserWindow({
    backgroundColor: '#f3f3f3',
    height: 900,
    ...(existsSync(appIconPath) ? { icon: appIconPath } : {}),
    show: false,
    title: 'PDF Annotator',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#ffffff',
            height: 40,
            symbolColor: '#171c1c'
          },
          titleBarStyle: 'hidden' as const
        }
      : {}),
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      experimentalFeatures: false,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
      webSecurity: true
    },
    width: 1280
  });

  activeWindow = window;
  primaryWindow ??= window;
  windowStates.set(window.id, {
    closeConfirmed: false,
    closeRequestPending: false,
    closeRequestTimer: null
  });
  hardenWindow(window);
  window.on('focus', () => {
    activeWindow = window;
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.once('did-finish-load', () => {
    void flushPendingOpenPaths(window);
  });
  window.on('closed', () => {
    const state = windowStates.get(window.id);
    if (state) {
      clearCloseRequestTimer(state);
      windowStates.delete(window.id);
    }
    pendingOpenPathsByWindowId.delete(window.id);
    if (activeWindow === window) {
      activeWindow = null;
    }
    if (primaryWindow === window) {
      primaryWindow = BrowserWindow.getAllWindows()[0] ?? null;
    }
  });
  window.on('close', (event) => {
    const state = windowStateFor(window);
    if (state.closeConfirmed) {
      return;
    }

    event.preventDefault();
    if (state.closeRequestPending) {
      window.show();
      window.focus();
      return;
    }

    requestRendererCloseConfirmation(window);
  });

  if (!app.isPackaged && devRendererUrl) {
    await window.loadURL(devRendererUrl);
    return window;
  }

  await window.loadURL(`${appProtocol}://app/index.html`);
  return window;
}

function hardenWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) {
      event.preventDefault();
    }
  });
}

function configureSessionSecurity() {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()]
      }
    });
  });
}

function contentSecurityPolicy() {
  const scriptSrc = app.isPackaged
    ? "script-src 'self' 'wasm-unsafe-eval'"
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";
  const connectSrc =
    !app.isPackaged && devRendererUrl
      ? "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173 ws://localhost:5173"
      : "connect-src 'self'";

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "frame-src 'self' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    scriptSrc,
    connectSrc
  ].join('; ');
}

function registerAppProtocol() {
  protocol.handle(appProtocol, async (request) => {
    const filePath = filePathForProtocolUrl(request.url);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }

    try {
      return new Response(await fs.readFile(filePath), {
        headers: {
          'content-type': contentTypeForPath(filePath),
          'x-content-type-options': 'nosniff'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function filePathForProtocolUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const resolvedPath = path.resolve(
    rendererDistDir,
    relativePath.length > 0 ? relativePath : 'index.html'
  );
  return pathInside(rendererDistDir, resolvedPath) ? resolvedPath : null;
}

function registerIpcHandlers() {
  ipcMain.handle(electronIpcChannels.pickPdfFiles, async (event) => {
    const ownerWindow = trustedWindowForSender(event.sender);
    const result = await showOpenDialog(ownerWindow, {
      filters: [{ extensions: ['pdf'], name: 'PDF files' }],
      properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : readPdfDocuments(result.filePaths, ownerWindow);
  });

  ipcMain.handle(electronIpcChannels.pickImageFile, async (event) => {
    const ownerWindow = trustedWindowForSender(event.sender);
    const result = await showOpenDialog(ownerWindow, {
      filters: [
        { extensions: ['jpg', 'jpeg', 'png', 'webp'], name: 'Image files' }
      ],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    return readImageFile(result.filePaths[0]);
  });

  ipcMain.handle(electronIpcChannels.savePdf, async (event, fileId, bytes) => {
    const ownerWindow = trustedWindowForSender(event.sender);
    assertUint8Array(bytes);
    const fileRecord = fileRecordsById.get(String(fileId));
    if (!fileRecord || fileRecord.ownerWebContentsId !== ownerWindow.webContents.id) {
      throw new Error('No save target is registered for this document.');
    }

    await writePdfFile(fileRecord.filePath, bytes);
  });

  ipcMain.handle(
    electronIpcChannels.savePdfAs,
    async (event, bytes, suggestedName) => {
      const ownerWindow = trustedWindowForSender(event.sender);
      assertUint8Array(bytes);
      const result = await showSaveDialog(ownerWindow, {
        defaultPath: safePdfFileName(String(suggestedName)),
        filters: [{ extensions: ['pdf'], name: 'PDF files' }]
      });
      if (result.canceled || !result.filePath) {
        return null;
      }

      const filePath = ensurePdfExtension(result.filePath);
      await writePdfFile(filePath, bytes);
      return rememberPdfFile(filePath, bytes, ownerWindow);
    }
  );

  ipcMain.handle(
    electronIpcChannels.downloadPdf,
    async (event, bytes, suggestedName) => {
      const ownerWindow = trustedWindowForSender(event.sender);
      assertUint8Array(bytes);
      const result = await showSaveDialog(ownerWindow, {
        defaultPath: safePdfFileName(String(suggestedName)),
        filters: [{ extensions: ['pdf'], name: 'PDF files' }]
      });
      if (!result.canceled && result.filePath) {
        await writePdfFile(ensurePdfExtension(result.filePath), bytes);
      }
    }
  );

  ipcMain.handle(electronIpcChannels.newWindow, async (event) => {
    trustedWindowForSender(event.sender);
    await createMainWindow();
  });

  ipcMain.handle(
    electronIpcChannels.printPdf,
    async (event, bytes, suggestedName) => {
      const ownerWindow = trustedWindowForSender(event.sender);
      assertUint8Array(bytes);
      await printPdfFile(ownerWindow, bytes, String(suggestedName));
    }
  );

  ipcMain.handle(electronIpcChannels.openExternalLink, async (event, url) => {
    trustedWindowForSender(event.sender);
    const safeUrl = safeExternalUrl(String(url));
    if (!safeUrl) {
      throw new Error('Blocked unsupported external link.');
    }

    await shell.openExternal(safeUrl);
  });

  ipcMain.on(electronIpcChannels.closeDecision, (event, allowed) => {
    const ownerWindow = trustedWindowForSender(event.sender);
    const state = windowStateFor(ownerWindow);
    clearCloseRequestTimer(state);
    state.closeRequestPending = false;
    if (allowed === true) {
      state.closeConfirmed = true;
      ownerWindow.close();
    }
  });
}

async function flushPendingOpenPaths(window: BrowserWindow) {
  const pendingOpenPaths = pendingOpenPathsByWindowId.get(window.id) ?? [];
  if (pendingOpenPaths.length === 0 || window.isDestroyed()) {
    return;
  }

  const paths = pendingOpenPaths.splice(0, pendingOpenPaths.length);
  pendingOpenPathsByWindowId.delete(window.id);
  const documents = await readPdfDocuments(paths, window);
  if (documents.length > 0 && !window.isDestroyed()) {
    window.webContents.send(electronIpcChannels.openPdfFiles, documents);
  }
}

function queueOpenPaths(filePaths: string[], targetWindow: BrowserWindow) {
  const pdfPaths = filePaths.filter(isPdfPath);
  if (pdfPaths.length === 0) {
    return;
  }

  const pendingOpenPaths = pendingOpenPathsByWindowId.get(targetWindow.id) ?? [];
  pendingOpenPaths.push(...pdfPaths);
  pendingOpenPathsByWindowId.set(targetWindow.id, pendingOpenPaths);
  if (targetWindow.webContents.isLoading() === false) {
    void flushPendingOpenPaths(targetWindow);
  }
}

async function openPathsInExistingWindow(filePaths: string[]) {
  const targetWindow = preferredOpenWindow() ?? (await createMainWindow());
  targetWindow.show();
  targetWindow.focus();
  queueOpenPaths(filePaths, targetWindow);
}

async function readPdfDocuments(
  filePaths: string[],
  ownerWindow: BrowserWindow
) {
  const documents: DesktopPdfDocument[] = [];
  for (const filePath of uniqueFilePaths(filePaths.filter(isPdfPath))) {
    try {
      const bytes = new Uint8Array(await fs.readFile(filePath));
      documents.push(rememberPdfFile(filePath, bytes, ownerWindow));
    } catch {
      // A file may have been moved or become unreadable between selection and read.
    }
  }

  return documents;
}

function rememberPdfFile(
  filePath: string,
  bytes: Uint8Array,
  ownerWindow: BrowserWindow
): DesktopPdfDocument {
  const fileId = randomUUID();
  fileRecordsById.set(fileId, {
    filePath,
    ownerWebContentsId: ownerWindow.webContents.id
  });
  return {
    bytes,
    fileId,
    fileKey: fileKeyForPath(filePath),
    name: path.basename(filePath)
  };
}

async function readImageFile(filePath: string): Promise<DesktopImageFile | null> {
  if (!isImagePath(filePath)) {
    return null;
  }

  return {
    bytes: new Uint8Array(await fs.readFile(filePath)),
    mimeType: imageMimeType(filePath),
    name: path.basename(filePath)
  };
}

async function writePdfFile(filePath: string, bytes: Uint8Array) {
  const targetPath = ensurePdfExtension(filePath);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, bytes, { flag: 'wx' });
    await fs.rename(tempPath, targetPath);
    await verifyFileBytes(targetPath, bytes);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function printPdfFile(
  ownerWindow: BrowserWindow,
  bytes: Uint8Array,
  suggestedName: string
) {
  const printDir = path.join(app.getPath('temp'), 'pdf-annotator-print');
  await fs.mkdir(printDir, { recursive: true });
  const printPath = path.join(
    printDir,
    `${randomUUID()}-${safePdfFileName(suggestedName)}`
  );

  await writePdfFile(printPath, bytes);
  try {
    await printTempPdfInChromium(ownerWindow, printPath);
  } catch (error) {
    await showPrintFailureMessage(ownerWindow, error);
  } finally {
    await fs.rm(printPath, { force: true }).catch(() => undefined);
  }
}

async function printTempPdfInChromium(
  ownerWindow: BrowserWindow,
  printPath: string
) {
  const printWindow = new BrowserWindow({
    backgroundColor: '#ffffff',
    height: 800,
    parent: ownerWindow.isDestroyed() ? undefined : ownerWindow,
    show: false,
    title: 'Print PDF',
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: false,
      experimentalFeatures: false,
      nodeIntegration: false,
      plugins: true,
      sandbox: true,
      webSecurity: true
    },
    width: 1000
  });

  hardenPrintWindow(printWindow, printPath);
  try {
    await printWindow.loadFile(printPath);
    await new Promise<void>((resolve, reject) => {
      printWindow.webContents.print(
        {
          printBackground: true,
          silent: false
        },
        (success, failureReason) => {
          if (success || isPrintCancelled(failureReason)) {
            resolve();
            return;
          }

          reject(new Error(failureReason || 'Print failed.'));
        }
      );
    });
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.close();
    }
  }
}

function hardenPrintWindow(window: BrowserWindow, printPath: string) {
  const allowedPrintUrl = pathToFileURL(printPath).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedPrintUrl) {
      event.preventDefault();
    }
  });
}

function isPrintCancelled(reason?: string) {
  return /cancel/i.test(reason ?? '');
}

async function showPrintFailureMessage(
  ownerWindow: BrowserWindow,
  error: unknown
) {
  const options: MessageBoxOptions = {
    buttons: ['OK'],
    defaultId: 0,
    detail: error instanceof Error ? error.message : undefined,
    message: 'PDF Annotator could not open the print dialog for this PDF.',
    noLink: true,
    title: 'Print failed',
    type: 'warning'
  };

  if (!ownerWindow.isDestroyed()) {
    await dialog.showMessageBox(ownerWindow, options);
    return;
  }

  await dialog.showMessageBox(options);
}

async function verifyFileBytes(filePath: string, expectedBytes: Uint8Array) {
  const actualBytes = await fs.readFile(filePath);
  if (actualBytes.byteLength !== expectedBytes.byteLength) {
    throw new Error('Saved file verification failed: byte length mismatch.');
  }

  for (let index = 0; index < actualBytes.byteLength; index += 1) {
    if (actualBytes[index] !== expectedBytes[index]) {
      throw new Error('Saved file verification failed: byte mismatch.');
    }
  }
}

function requestRendererCloseConfirmation(window: BrowserWindow) {
  const state = windowStateFor(window);
  if (state.closeRequestPending || window.isDestroyed()) {
    return;
  }

  state.closeRequestPending = true;
  window.show();
  window.focus();
  window.webContents.send(electronIpcChannels.requestClose);
  state.closeRequestTimer = setTimeout(() => {
    state.closeRequestTimer = null;
    if (state.closeRequestPending && !window.isDestroyed()) {
      void confirmForceClose(window);
    }
  }, closeConfirmationTimeoutMs);
  state.closeRequestTimer.unref?.();
}

async function confirmForceClose(window: BrowserWindow) {
  if (window.isDestroyed()) {
    return;
  }

  const result = await dialog.showMessageBox(window, {
    buttons: ['Cancel', 'Close app'],
    cancelId: 0,
    defaultId: 0,
    detail:
      'PDF Annotator did not respond while checking for unsaved changes.',
    message: 'Close without waiting?',
    noLink: true,
    title: 'PDF Annotator',
    type: 'warning'
  });
  if (result.response === 1 && !window.isDestroyed()) {
    const state = windowStateFor(window);
    clearCloseRequestTimer(state);
    state.closeRequestPending = false;
    state.closeConfirmed = true;
    window.close();
    return;
  }

  if (!window.isDestroyed()) {
    windowStateFor(window).closeRequestPending = false;
  }
}

function clearCloseRequestTimer(state: DesktopWindowState) {
  if (state.closeRequestTimer) {
    clearTimeout(state.closeRequestTimer);
    state.closeRequestTimer = null;
  }
}

function showOpenDialog(ownerWindow: BrowserWindow, options: OpenDialogOptions) {
  return ownerWindow.isDestroyed()
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(ownerWindow, options);
}

function showSaveDialog(ownerWindow: BrowserWindow, options: SaveDialogOptions) {
  return ownerWindow.isDestroyed()
    ? dialog.showSaveDialog(options)
    : dialog.showSaveDialog(ownerWindow, options);
}

function trustedWindowForSender(sender: Electron.WebContents) {
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  if (!ownerWindow || !windowStates.has(ownerWindow.id)) {
    throw new Error('Blocked IPC from an untrusted sender.');
  }

  return ownerWindow;
}

function windowStateFor(window: BrowserWindow) {
  const state = windowStates.get(window.id);
  if (!state) {
    throw new Error('Missing Electron window state.');
  }

  return state;
}

function preferredOpenWindow() {
  const candidate =
    activeWindow && !activeWindow.isDestroyed()
      ? activeWindow
      : primaryWindow && !primaryWindow.isDestroyed()
        ? primaryWindow
        : BrowserWindow.getAllWindows()[0] ?? null;

  return candidate && !candidate.isDestroyed() ? candidate : null;
}

function assertUint8Array(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('Expected PDF bytes.');
  }
}

function isAllowedRendererUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${appProtocol}:`) {
      return true;
    }

    return (
      !app.isPackaged &&
      devRendererUrl !== null &&
      parsed.origin === new URL(devRendererUrl).origin
    );
  } catch {
    return false;
  }
}

function safeExternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!allowedExternalProtocols.has(parsed.protocol)) {
      return null;
    }

    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function pdfPathsFromArgs(argv: string[]) {
  return argv.filter(isPdfPath);
}

function isPdfPath(filePath: string) {
  return filePath.toLowerCase().endsWith('.pdf');
}

function isImagePath(filePath: string) {
  return /\.(jpe?g|png|webp)$/i.test(filePath);
}

function imageMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function ensurePdfExtension(filePath: string) {
  return filePath.toLowerCase().endsWith('.pdf') ? filePath : `${filePath}.pdf`;
}

function fileKeyForPath(filePath: string) {
  return `desktop:${createHash('sha256')
    .update(path.normalize(filePath).toLowerCase())
    .digest('hex')}`;
}

function uniqueFilePaths(filePaths: string[]) {
  return Array.from(new Set(filePaths.map((filePath) => path.resolve(filePath))));
}

function pathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function contentTypeForPath(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.wasm':
      return 'application/wasm';
    case '.bcmap':
      return 'application/octet-stream';
    case '.icc':
      return 'application/vnd.iccprofile';
    case '.pfb':
      return 'application/x-font-type1';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}
