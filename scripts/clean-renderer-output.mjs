import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererOutput = join(root, 'out', 'renderer');

// The service worker precaches every allowed output file. Removing this one
// exact build directory first prevents obsolete hashed bundles from being
// carried into a later cache manifest.
rmSync(rendererOutput, {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100
});
