import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserShell } from './browserapp/BrowserShell';
import { ElectronShell } from './electronapp/ElectronShell';
import { hasDesktopBridge } from './electronapp/electronFileAdapter';
import { configurePdfRuntime } from './pdfRuntime';

configurePdfRuntime();

const desktopRuntimeExpected =
  hasDesktopBridge() || window.location.protocol === 'pdfannotator:';
const AppShell = desktopRuntimeExpected ? ElectronShell : BrowserShell;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);
