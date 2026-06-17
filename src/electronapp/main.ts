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
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { safePdfFileName } from '../fileNames.js';
import { electronIpcChannels } from './ipc.js';
import type { DesktopImageFile, DesktopPdfDocument } from './bridge.js';

const appProtocol = 'pdfannotator';
const allowedExternalProtocols = new Set(['http:', 'https:', 'mailto:']);
const closeConfirmationTimeoutMs = 15000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..', '..');
const rendererDistDir = app.isPackaged
  ? path.join(app.getAppPath(), 'dist')
  : path.join(projectRoot, 'dist');
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(projectRoot, 'build', 'icon.ico');
const preloadPath = path.join(__dirname, 'preload.js');
const devRendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || null;
const filePathsById = new Map<string, string>();
const pendingOpenPaths: string[] = [];

let mainWindow: BrowserWindow | null = null;
let closeConfirmed = false;
let closeRequestPending = false;
let closeRequestTimer: NodeJS.Timeout | null = null;

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
    queueOpenPaths(pdfPathsFromArgs(argv));
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpenPaths([filePath]);
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    configureSessionSecurity();
    registerIpcHandlers();
    await createMainWindow();
    queueOpenPaths(pdfPathsFromArgs(process.argv));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}

async function createMainWindow() {
  const window = new BrowserWindow({
    backgroundColor: '#f3f3f3',
    height: 900,
    ...(existsSync(appIconPath) ? { icon: appIconPath } : {}),
    show: false,
    title: 'PDF Annotator',
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

  mainWindow = window;
  hardenWindow(window);
  window.once('ready-to-show', () => window.show());
  window.webContents.once('did-finish-load', () => {
    void flushPendingOpenPaths();
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.on('close', (event) => {
    if (closeConfirmed) {
      return;
    }

    event.preventDefault();
    if (closeRequestPending) {
      void confirmForceClose(window);
      return;
    }

    requestRendererCloseConfirmation(window);
  });

  if (!app.isPackaged && devRendererUrl) {
    await window.loadURL(devRendererUrl);
    return;
  }

  await window.loadURL(`${appProtocol}://app/index.html`);
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
    assertTrustedSender(event.sender);
    const result = await showOpenDialog({
      filters: [{ extensions: ['pdf'], name: 'PDF files' }],
      properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : readPdfDocuments(result.filePaths);
  });

  ipcMain.handle(electronIpcChannels.pickImageFile, async (event) => {
    assertTrustedSender(event.sender);
    const result = await showOpenDialog({
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
    assertTrustedSender(event.sender);
    assertUint8Array(bytes);
    const filePath = filePathsById.get(String(fileId));
    if (!filePath) {
      throw new Error('No save target is registered for this document.');
    }

    await writePdfFile(filePath, bytes);
  });

  ipcMain.handle(
    electronIpcChannels.savePdfAs,
    async (event, bytes, suggestedName) => {
      assertTrustedSender(event.sender);
      assertUint8Array(bytes);
      const result = await showSaveDialog({
        defaultPath: safePdfFileName(String(suggestedName)),
        filters: [{ extensions: ['pdf'], name: 'PDF files' }]
      });
      if (result.canceled || !result.filePath) {
        return null;
      }

      const filePath = ensurePdfExtension(result.filePath);
      await writePdfFile(filePath, bytes);
      return rememberPdfFile(filePath, bytes);
    }
  );

  ipcMain.handle(
    electronIpcChannels.downloadPdf,
    async (event, bytes, suggestedName) => {
      assertTrustedSender(event.sender);
      assertUint8Array(bytes);
      const result = await showSaveDialog({
        defaultPath: safePdfFileName(String(suggestedName)),
        filters: [{ extensions: ['pdf'], name: 'PDF files' }]
      });
      if (!result.canceled && result.filePath) {
        await writePdfFile(ensurePdfExtension(result.filePath), bytes);
      }
    }
  );

  ipcMain.handle(electronIpcChannels.printPdf, async (event, bytes, suggestedName) => {
    assertTrustedSender(event.sender);
    assertUint8Array(bytes);
    await printPdfFile(bytes, String(suggestedName));
  });

  ipcMain.handle(electronIpcChannels.openExternalLink, async (event, url) => {
    assertTrustedSender(event.sender);
    const safeUrl = safeExternalUrl(String(url));
    if (!safeUrl) {
      throw new Error('Blocked unsupported external link.');
    }

    await shell.openExternal(safeUrl);
  });

  ipcMain.on(electronIpcChannels.closeDecision, (event, allowed) => {
    assertTrustedSender(event.sender);
    clearCloseRequestTimer();
    closeRequestPending = false;
    if (allowed === true && mainWindow) {
      closeConfirmed = true;
      mainWindow.close();
    }
  });
}

async function flushPendingOpenPaths() {
  if (!mainWindow || pendingOpenPaths.length === 0) {
    return;
  }

  const paths = pendingOpenPaths.splice(0, pendingOpenPaths.length);
  const documents = await readPdfDocuments(paths);
  if (documents.length > 0 && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(electronIpcChannels.openPdfFiles, documents);
  }
}

function queueOpenPaths(filePaths: string[]) {
  const pdfPaths = filePaths.filter(isPdfPath);
  if (pdfPaths.length === 0) {
    return;
  }

  pendingOpenPaths.push(...pdfPaths);
  if (mainWindow?.webContents.isLoading() === false) {
    void flushPendingOpenPaths();
  }
}

async function readPdfDocuments(filePaths: string[]) {
  const documents: DesktopPdfDocument[] = [];
  for (const filePath of uniqueFilePaths(filePaths.filter(isPdfPath))) {
    try {
      const bytes = new Uint8Array(await fs.readFile(filePath));
      documents.push(rememberPdfFile(filePath, bytes));
    } catch {
      // A file may have been moved or become unreadable between selection and read.
    }
  }

  return documents;
}

function rememberPdfFile(filePath: string, bytes: Uint8Array): DesktopPdfDocument {
  const fileId = randomUUID();
  filePathsById.set(fileId, filePath);
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

async function printPdfFile(bytes: Uint8Array, suggestedName: string) {
  const printDir = path.join(app.getPath('temp'), 'pdf-annotator-print');
  await fs.mkdir(printDir, { recursive: true });
  const printPath = path.join(
    printDir,
    `${randomUUID()}-${safePdfFileName(suggestedName)}`
  );
  await writePdfFile(printPath, bytes);
  scheduleTempFileCleanup(printPath);

  if (process.platform === 'win32') {
    try {
      await printPdfWithWindowsShell(printPath);
      return;
    } catch {
      await showPrintFailureMessage();
      return;
    }
  }

  await showPrintFailureMessage();
}

async function printPdfWithWindowsShell(filePath: string) {
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Start-Process -FilePath $args[0] -Verb Print',
      filePath
    ],
    { windowsHide: true }
  );
}

function scheduleTempFileCleanup(filePath: string) {
  const timer = setTimeout(() => {
    void fs.rm(filePath, { force: true });
  }, 30 * 60 * 1000);
  timer.unref?.();
}

async function showPrintFailureMessage() {
  const options: MessageBoxOptions = {
    buttons: ['OK'],
    defaultId: 0,
    message: 'PDF Annotator could not hand this PDF to the system printer.',
    noLink: true,
    title: 'Print failed',
    type: 'warning'
  };

  if (mainWindow) {
    await dialog.showMessageBox(mainWindow, options);
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
  if (closeRequestPending || window.isDestroyed()) {
    return;
  }

  closeRequestPending = true;
  window.webContents.send(electronIpcChannels.requestClose);
  closeRequestTimer = setTimeout(() => {
    closeRequestPending = false;
    closeRequestTimer = null;
  }, closeConfirmationTimeoutMs);
  closeRequestTimer.unref?.();
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
      'PDF Annotator is still checking whether files have unsaved changes.',
    message: 'Close without waiting?',
    noLink: true,
    title: 'PDF Annotator',
    type: 'warning'
  });
  if (result.response === 1 && !window.isDestroyed()) {
    clearCloseRequestTimer();
    closeRequestPending = false;
    closeConfirmed = true;
    window.close();
  }
}

function clearCloseRequestTimer() {
  if (closeRequestTimer) {
    clearTimeout(closeRequestTimer);
    closeRequestTimer = null;
  }
}

function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
}

function showSaveDialog(options: SaveDialogOptions) {
  return mainWindow
    ? dialog.showSaveDialog(mainWindow, options)
    : dialog.showSaveDialog(options);
}

function assertTrustedSender(sender: Electron.WebContents) {
  if (!mainWindow || sender.id !== mainWindow.webContents.id) {
    throw new Error('Blocked IPC from an untrusted sender.');
  }
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
