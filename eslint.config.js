import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist', 'public', 'node_modules', 'coverage', '**/*.d.ts']
  },
  // Application + library source (browser environment, React).
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true }
      ],
      // `any` is used at a few pdfjs/pdf-lib interop boundaries where the
      // upstream types are incomplete; keep it visible as a warning rather
      // than forcing awkward casts.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow intentionally-unused args/vars when prefixed with _.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none'
        }
      ]
    }
  },
  // Node-run tooling and tests.
  {
    files: [
      'tests/**/*.ts',
      'tests-e2e/**/*.ts',
      'scripts/**/*.mjs',
      '*.{js,mjs,ts}'
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  },
  // DOM component/hook tests: run under Node's test runner but render React
  // into jsdom, so they need both Node and browser globals plus JSX.
  {
    files: ['tests/**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  }
);
