#!/usr/bin/env node
/**
 * Fetches the sidecar binaries into resources/bin/<platform>-<arch>/ and
 * writes the checksum manifest the app verifies at startup.
 *
 * The binaries are not committed to the repository: they are large, they are
 * platform-specific, and yt-dlp in particular must be replaceable independently
 * of an app release (spec section 2).
 *
 * ffmpeg is deliberately NOT downloaded by default. Section 3 requires an LGPL
 * build for a closed-source commercial product, and every convenient prebuilt
 * (BtbN, evermeet, gyan) ships a GPL build compiled with libx264/libx265.
 * Pointing this script at one of those would quietly create a licensing
 * problem, so an ffmpeg source must be supplied explicitly via
 * resources/sidecar-sources.json. See docs/SIDECARS.md.
 *
 * Usage:
 *   node scripts/fetch-sidecars.mjs                 # current platform
 *   node scripts/fetch-sidecars.mjs --all           # every target platform
 *   node scripts/fetch-sidecars.mjs --only=yt-dlp
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binRoot = join(root, 'resources', 'bin');
const sourcesFile = join(root, 'resources', 'sidecar-sources.json');

const YT_DLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

/** yt-dlp publishes a standalone binary per platform — no Python needed. */
const YT_DLP_ASSETS = {
  'win32-x64': `${YT_DLP_RELEASE}/yt-dlp.exe`,
  'darwin-arm64': `${YT_DLP_RELEASE}/yt-dlp_macos`,
  'darwin-x64': `${YT_DLP_RELEASE}/yt-dlp_macos_legacy`,
  'linux-x64': `${YT_DLP_RELEASE}/yt-dlp_linux`,
};

const TARGETS = Object.keys(YT_DLP_ASSETS);

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
const targets = wantAll ? TARGETS : [`${process.platform}-${process.arch}`];

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, buffer);
  if (!destination.endsWith('.exe')) await chmod(destination, 0o755);
  return createHash('sha256').update(buffer).digest('hex');
}

async function loadSources() {
  if (!existsSync(sourcesFile)) return {};
  return JSON.parse(await readFile(sourcesFile, 'utf8'));
}

async function main() {
  const sources = await loadSources();
  const manifest = { files: {}, sources: {} };
  const manifestPath = join(binRoot, 'manifest.json');
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
    Object.assign(manifest.files, existing.files ?? {});
    Object.assign(manifest.sources, existing.sources ?? {});
  }

  for (const target of targets) {
    if (!TARGETS.includes(target)) {
      console.error(`unknown target ${target}; expected one of ${TARGETS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const exe = target.startsWith('win32') ? '.exe' : '';

    if (!only || only === 'yt-dlp') {
      const key = `${target}/yt-dlp${exe}`;
      process.stdout.write(`fetching ${key} … `);
      manifest.files[key] = await download(YT_DLP_ASSETS[target], join(binRoot, key));
      manifest.sources[key] = YT_DLP_ASSETS[target];
      console.log('ok');
    }

    for (const name of ['ffmpeg', 'ffprobe']) {
      if (only && only !== name) continue;
      const url = sources?.[target]?.[name];
      if (!url) {
        console.warn(
          `skipping ${target}/${name}: no source configured.\n` +
            `  Add an LGPL build URL to resources/sidecar-sources.json — do NOT use a GPL build\n` +
            `  (anything compiled with libx264/libx265). See docs/SIDECARS.md.`,
        );
        continue;
      }
      const key = `${target}/${name}${exe}`;
      process.stdout.write(`fetching ${key} … `);
      manifest.files[key] = await download(url, join(binRoot, key));
      manifest.sources[key] = url;
      console.log('ok');
    }
  }

  await mkdir(binRoot, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote ${manifestPath} (${Object.keys(manifest.files).length} entries)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
