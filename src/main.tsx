import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserShell } from "./browserapp/BrowserShell";
import { warmPdfRuntimeCaches } from "./pdfRuntime";

// URLs only; the library itself arrives with the tabbedapp chunk.
warmPdfRuntimeCaches();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserShell />
  </StrictMode>,
);
