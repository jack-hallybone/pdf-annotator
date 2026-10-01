// Loaded via `node --import` before any test module, so jsdom's globals exist before React DOM is imported.
import "global-jsdom/register";
import { afterEach } from "node:test";
import { cleanup } from "@testing-library/react";

// React 19 uses this flag to enable `act()` warnings and batching in tests.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no Web Worker. The PDF read gate (src/pdfdocumenteditor/pdfParseGate.ts)
// checks pdf-lib's read in a worker before a file is opened; with no Worker it would refuse
// every open and these tests, which load ordinary small PDFs, would never mount. A real
// browser runs the actual worker; here a stand-in reports the read finished in time - the
// outcome an ordinary file gets - so the gate is transparent. Its refusal of a read that
// overruns is covered off jsdom, in tests/pdf-decompression-bomb.test.ts (the in-process
// bound) and tests-e2e/decompression-bomb.spec.ts (the worker gate, in real Chromium).
class ReadWithinTimeWorker {
  private readonly onMessage: Array<(event: { data: unknown }) => void> = [];
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === "message") this.onMessage.push(listener);
  }
  removeEventListener() {}
  postMessage() {
    queueMicrotask(() => {
      for (const listener of this.onMessage) listener({ data: "read" });
    });
  }
  terminate() {}
}
(globalThis as { Worker?: unknown }).Worker ??= ReadWithinTimeWorker;

// Unmount anything a test rendered, so its state and timers cannot leak on.
afterEach(() => {
  cleanup();
});
