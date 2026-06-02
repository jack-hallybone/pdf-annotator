import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserShell } from './browserapp/BrowserShell';
import { configurePdfRuntime } from './pdfRuntime';

configurePdfRuntime();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserShell />
  </StrictMode>
);
