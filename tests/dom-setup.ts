// Loaded via `node --import` before any test module, so jsdom's globals exist
// before React DOM is imported.
import "global-jsdom/register";
import { afterEach } from "node:test";
import { cleanup } from "@testing-library/react";

// React 19 uses this flag to enable `act()` warnings and batching in tests.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Unmount anything a test rendered, so its state and timers cannot leak on.
afterEach(() => {
  cleanup();
});
