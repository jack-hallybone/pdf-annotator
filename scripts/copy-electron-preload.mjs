import { mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';

const sourcePath = path.resolve('src/electronapp/preload.cjs');
const targetPath = path.resolve('dist-electron/electronapp/preload.cjs');
const oldTargetPath = path.resolve('dist-electron/electronapp/preload.js');

await mkdir(path.dirname(targetPath), { recursive: true });
await copyFile(sourcePath, targetPath);
await rm(oldTargetPath, { force: true });
