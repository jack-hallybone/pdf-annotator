import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist", ".generated", "node_modules", "coverage", "**/*.d.ts"],
  },
  // Recommended everywhere. The blocks below add only the environment each
  // area runs in and the few overrides that are load-bearing.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Explicit rather than `recommended-latest`, which also turns on
      // experimental React Compiler diagnostics this build does not use.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Warn, not error, and NOT a downgrade: `lint` runs with
      // `--max-warnings=0`, so these still fail the build; the severity only
      // marks the pdfjs/pdf-lib boundaries whose upstream types are incomplete,
      // where forcing a cast would be worse than the warning.
      "@typescript-eslint/no-explicit-any": "warn",
      // The app runs PDF.js's `legacy` build; see the header comment in
      // src/annotator/pdfRender.ts for why (the default build calls
      // proposal-stage methods Chromium 141 does not have, and every page came
      // up blank). One default-build import is enough to undo that - and worse,
      // to load a second copy of PDF.js whose classes fail `instanceof` against
      // the first - so the default entry points are unimportable here.
      // `allowTypeImports` keeps `import type ... from "pdfjs-dist"` working:
      // types are erased, and the two builds declare the same ones.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pdfjs-dist",
              allowTypeImports: true,
              message:
                'Import PDF.js values from "pdfjs-dist/legacy/build/pdf.mjs" - see src/annotator/pdfRender.ts.',
            },
          ],
          patterns: [
            {
              group: ["pdfjs-dist/build/*", "pdfjs-dist/web/*"],
              allowTypeImports: true,
              message:
                'Use the "pdfjs-dist/legacy/..." equivalent - see src/annotator/pdfRender.ts.',
            },
          ],
        },
      ],
    },
  },
  // The service worker: not a page, not Node. Its own file rather than a global
  // added to the app block, because `self`, `caches` and `clients` are exactly
  // what the app must NOT reach (see `the shipped app reaches no browser
  // store` in tests/build/shipped-artefact.test.mjs).
  {
    files: ["src/sw.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.serviceworker },
    },
  },
  // The fleet's JSON reader: plain browser JS, pasted and never edited here, so
  // it gets the browser globals without the app block's React rules.
  {
    files: ["src/safe-json.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.browser },
    },
  },
  {
    files: [
      "tests/**/*.ts",
      "tests-e2e/**/*.ts",
      "scripts/**/*.mjs",
      "*.{js,mjs,ts}",
    ],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  // Node suites that DRIVE a real browser: the bodies they hand to
  // page.evaluate are browser code, so both global sets, exactly as for the
  // jsdom suites below.
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  },
  // Run under Node's test runner but render into jsdom, so both global sets.
  {
    files: ["tests/**/*.tsx"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  },
  // The split-view test host (tests-e2e/split-view) is a real page served by
  // the dev server, so it is browser code even though it lives beside the
  // Node-side specs. Its rules-of-hooks matter as much as the app's: it is a
  // React host mounting two viewports over one document.
  {
    files: ["tests-e2e/**/*.tsx"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Last, so it wins: switches off every stylistic rule Prettier owns.
  eslintConfigPrettier,
);
