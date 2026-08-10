/**
 * Optional local bundle of cf-worker → public/_worker.js (not the primary deploy path).
 * Primary: `npx wrangler deploy` (Workers + Static Assets).
 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'public', '_worker.js');

mkdirSync(join(root, 'public'), { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'cf-worker', 'index.js')],
  bundle: true,
  outfile,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['worker', 'browser', 'import'],
  mainFields: ['browser', 'module', 'main'],
  packages: 'bundle',
  logLevel: 'info',
  legalComments: 'none',
  minify: false,
});

try {
  rmSync(join(root, 'public', '_routes.json'));
} catch (_) {}
try {
  rmSync(join(root, '_routes.json'));
} catch (_) {}

writeFileSync(
  join(root, 'public', '_worker_build.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), mode: 'worker-bundle' }, null, 2),
);

console.log('Wrote', outfile);
