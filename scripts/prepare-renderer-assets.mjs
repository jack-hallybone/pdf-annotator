import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedRoot = join(root, '.generated', 'renderer-assets');
const browserAssetsRoot = join(root, 'src', 'browserapp', 'assets');
const pdfjsSourceRoot = join(root, 'node_modules', 'pdfjs-dist');
const pdfjsTargetRoot = join(generatedRoot, 'pdfjs');
const assetDirs = [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs']
];
const licenseFiles = ['LICENSE', 'NOTICE'];
const unusedWasmAssets = ['quickjs-eval.js', 'quickjs-eval.wasm'];

rmSync(generatedRoot, { force: true, recursive: true });
mkdirSync(generatedRoot, { recursive: true });
cpSync(browserAssetsRoot, generatedRoot, { recursive: true });
mkdirSync(pdfjsTargetRoot, { recursive: true });

for (const [sourceDir, targetDir] of assetDirs) {
  const source = join(pdfjsSourceRoot, sourceDir);
  const target = join(pdfjsTargetRoot, targetDir);

  if (!existsSync(source)) {
    throw new Error(`Missing PDF.js asset directory: ${source}`);
  }

  rmSync(target, { force: true, recursive: true });
  cpSync(source, target, { recursive: true });
}

for (const file of licenseFiles) {
  const source = join(pdfjsSourceRoot, file);
  const target = join(pdfjsTargetRoot, file);

  if (existsSync(source)) {
    cpSync(source, target);
  } else {
    rmSync(target, { force: true });
  }
}

for (const asset of unusedWasmAssets) {
  rmSync(join(pdfjsTargetRoot, 'wasm', asset), { force: true });
}
