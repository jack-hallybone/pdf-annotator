import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import './webapp/styles.css';
import App from './webapp/App.tsx';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
warmPdfJsStartupPath();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

function warmPdfJsStartupPath() {
  preloadModule(pdfWorkerUrl);

  const pdfJsAssetBase = `${import.meta.env.BASE_URL}pdfjs/wasm/`;
  const warmableAssets = [
    `${pdfJsAssetBase}openjpeg.wasm`,
    `${pdfJsAssetBase}jbig2.wasm`,
    `${pdfJsAssetBase}qcms_bg.wasm`
  ];

  scheduleIdleWork(() => {
    for (const assetUrl of warmableAssets) {
      void fetch(assetUrl, { cache: 'force-cache' }).catch(() => undefined);
    }
  });
}

function preloadModule(href: string) {
  if (document.querySelector(`link[rel="modulepreload"][href="${href}"]`)) {
    return;
  }

  const link = document.createElement('link');
  link.href = href;
  link.rel = 'modulepreload';
  document.head.append(link);
}

function scheduleIdleWork(task: () => void) {
  if (window.requestIdleCallback) {
    window.requestIdleCallback(task, { timeout: 2000 });
    return;
  }

  window.setTimeout(task, 500);
}
