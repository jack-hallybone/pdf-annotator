import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, 'node_modules', 'pdfjs-dist');
const targetRoot = join(root, 'public', 'pdfjs');
const assetDirs = [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs']
];
const licenseFiles = ['LICENSE', 'NOTICE'];
const unusedWasmAssets = ['quickjs-eval.js', 'quickjs-eval.wasm'];

mkdirSync(targetRoot, { recursive: true });

for (const [sourceDir, targetDir] of assetDirs) {
  const source = join(sourceRoot, sourceDir);
  const target = join(targetRoot, targetDir);

  if (!existsSync(source)) {
    throw new Error(`Missing PDF.js asset directory: ${source}`);
  }

  rmSync(target, { force: true, recursive: true });
  cpSync(source, target, { recursive: true });
}

for (const file of licenseFiles) {
  const source = join(sourceRoot, file);
  const target = join(targetRoot, file);

  if (existsSync(source)) {
    cpSync(source, target);
  } else {
    rmSync(target, { force: true });
  }
}

for (const asset of unusedWasmAssets) {
  rmSync(join(targetRoot, 'wasm', asset), { force: true });
}
