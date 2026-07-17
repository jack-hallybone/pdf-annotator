// DOM setup for component/hook tests. Loaded via `node --import` BEFORE any
// test module, so jsdom's globals (window, document, navigator, HTMLElement…)
// exist before React DOM is imported. The pure-logic tests deliberately do NOT
// load this file - they run in a separate process with their own lightweight
// DOM fakes - so jsdom never interferes with them.
import 'global-jsdom/register';
import { afterEach } from 'node:test';
import { cleanup } from '@testing-library/react';

// React 19 uses this flag to enable `act()` warnings and batching in tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Unmount anything rendered by a test so state/effects/timers from one test
// can't leak into the next.
afterEach(() => {
  cleanup();
});
