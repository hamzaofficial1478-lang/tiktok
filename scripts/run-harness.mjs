#!/usr/bin/env node
/**
 * Bundles and runs a TypeScript harness script outside Electron.
 *
 * Exists because the app's migrations are imported with Vite's `?raw` suffix,
 * which esbuild does not understand on its own. Rather than change the app to
 * suit a dev script, the plugin below teaches esbuild the same trick — so the
 * harness runs against exactly the code that ships.
 *
 *     node scripts/run-harness.mjs scripts/queue-harness.ts
 */
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/run-harness.mjs <entry.ts>');
  process.exit(1);
}

/** Mirrors Vite's `import x from './y.sql?raw'`. */
const sqlRawPlugin = {
  name: 'sql-raw',
  setup(build) {
    build.onResolve({ filter: /\.sql\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'sql-raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'sql-raw' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const outfile = resolve(root, '.harness', 'bundle.mjs');

await build({
  entryPoints: [resolve(root, entry)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile,
  logLevel: 'warning',
  plugins: [sqlRawPlugin],
  alias: {
    '@main': resolve(root, 'src/main'),
    '@shared': resolve(root, 'src/shared'),
  },
});

await import(pathToFileURL(outfile).href);
