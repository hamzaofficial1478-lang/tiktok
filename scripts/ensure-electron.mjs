#!/usr/bin/env node
/**
 * Makes sure the Electron binary is actually on disk after `npm install`.
 *
 * The `electron` npm package is a small wrapper: the real ~150 MB binary is
 * fetched separately and recorded in `node_modules/electron/path.txt`. When
 * that fetch does not happen — a proxy, an offline install, a devDependency
 * install that ran without lifecycle scripts, or an `electron` build whose
 * own postinstall hook is absent — nothing complains at install time. The
 * failure surfaces much later and much less helpfully, as electron-vite
 * throwing `Error: Electron uninstall` when you try to start the app.
 *
 * `electron/install.js` is idempotent and exits immediately when the binary is
 * already present, so running it here costs a file check on a normal install.
 *
 * This script NEVER fails the install. A missing Electron binary means the GUI
 * cannot start, but the engine, the test suite and the CLI harnesses all still
 * work, and failing `npm install` outright over it would be the same mistake
 * the old `electron-builder install-app-deps` postinstall made.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let electronDir;
try {
  electronDir = dirname(require.resolve('electron/package.json'));
} catch {
  // Electron is a devDependency, so a production install legitimately has none.
  process.exit(0);
}

/** True when path.txt exists and the executable it names is really there. */
function binaryPresent() {
  const pathFile = join(electronDir, 'path.txt');
  if (!existsSync(pathFile)) return false;
  const relative = readFileSync(pathFile, 'utf8').trim();
  return relative !== '' && existsSync(join(electronDir, 'dist', relative));
}

if (binaryPresent()) process.exit(0);

const installer = join(electronDir, 'install.js');
if (!existsSync(installer)) {
  console.warn('[ensure-electron] electron/install.js is missing; skipping.');
  process.exit(0);
}

console.log('[ensure-electron] downloading the Electron binary (~150 MB, once)…');
const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', cwd: electronDir });

if (result.status !== 0 || !binaryPresent()) {
  console.warn(
    '\n[ensure-electron] could not download the Electron binary.\n' +
      '  Everything except the app window still works: `npm test`, `npm run typecheck`,\n' +
      '  `npm run harness:queue`.\n' +
      '  To retry once you have a working connection:  npm run setup:electron\n' +
      '  Behind a corporate proxy, set ELECTRON_GET_USE_PROXY=1 and HTTPS_PROXY first.\n',
  );
}

// Always succeed: a missing GUI binary must not break the whole install.
process.exit(0);
