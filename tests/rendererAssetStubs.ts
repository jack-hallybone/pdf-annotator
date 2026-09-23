// Import this for its side effects, before any `await import()` of renderer
// code: `pdfRender` imports a stylesheet and `pdfRuntime`'s Vite `?url` asset,
// neither of which the Node test runner can load.

// `registerHooks` runs in-thread, so the hook can be a function defined here,
// and the older off-thread `module.register` is deprecated from Node 26
// (DEP0205).
import { registerHooks } from "node:module";

const STUB_MODULE = `data:text/javascript,${encodeURIComponent("export default '/stub';")}`;

registerHooks({
  // Vite resolves `?url` asset imports and stylesheet imports; the Node test
  // runner cannot. Everything else falls through to the real module.
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith(".css") || specifier.endsWith("?url")
      ? { shortCircuit: true, url: STUB_MODULE }
      : nextResolve(specifier, context);
  },
});

Object.assign(globalThis, { DOMMatrix: class {} });
