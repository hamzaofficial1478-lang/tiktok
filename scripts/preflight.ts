/**
 * Pre-packaging checks — run before building an installer.
 *
 *     npm run preflight
 *
 * Everything here is something that produces a *working build of a broken
 * app*: the installer succeeds, the user runs it, and it fails on their
 * machine instead of on ours. A missing extractor, a GPL ffmpeg, an unbuilt
 * renderer — none of them stop electron-builder, and all of them are worse to
 * discover after shipping.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ChildProcessRunner } from '@main/resolve/process-runner';
import { SidecarResolver, SIDECAR_NAMES, platformDir, binaryFilename } from '@main/media/sidecars';
import { probeCapabilities, REQUIRED_FILTERS } from '@main/media/capabilities';

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

const root = process.cwd();
let failures = 0;
let warnings = 0;

function pass(label: string, detail = ''): void {
  console.log(`  ${green('ok')}   ${label} ${dim(detail)}`);
}
function fail(label: string, detail = ''): void {
  failures++;
  console.log(`  ${red('FAIL')} ${label}`);
  if (detail) console.log(dim(`       ${detail}`));
}
function warn(label: string, detail = ''): void {
  warnings++;
  console.log(`  ${yellow('warn')} ${label}`);
  if (detail) console.log(dim(`       ${detail}`));
}

async function main(): Promise<void> {
  console.log('\nPreflight\n');

  /* --- The renderer and main bundles must exist ------------------------ */
  for (const artifact of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    if (existsSync(join(root, artifact))) pass(artifact);
    else fail(artifact, 'run npm run build first');
  }

  /* --- The preload must be CommonJS and free of node_modules ----------- */
  const preloadPath = join(root, 'out/preload/index.cjs');
  if (existsSync(preloadPath)) {
    const preload = readFileSync(preloadPath, 'utf8');
    const requires = [...preload.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    const foreign = requires.filter((name) => name !== 'electron' && !name?.startsWith('node:'));
    if (foreign.length === 0) pass('preload requires only electron', `${Math.round(preload.length / 1024)} kB`);
    else fail('preload requires node_modules', `a sandboxed preload cannot resolve: ${foreign.join(', ')}`);
  }

  /* --- Sidecars for the current platform ------------------------------- */
  const resolver = new SidecarResolver({ resourcesRoot: join(root, 'resources'), allowPathFallback: false });
  const manifestPath = join(root, 'resources/bin/manifest.json');
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: Record<string, string> })
    : null;

  for (const name of SIDECAR_NAMES) {
    const resolved = resolver.resolve(name);
    if (!resolved.path) {
      // yt-dlp absent means the app cannot download anything at all.
      if (name === 'yt-dlp') fail(`${name} is missing`, 'run npm run fetch:sidecars');
      else warn(`${name} is missing`, 'watermark filtering and verification will be unavailable');
      continue;
    }

    const key = `${platformDir()}/${binaryFilename(name)}`;
    const expected = manifest?.files?.[key];
    if (!expected) {
      warn(`${name} has no manifest entry`, 'a corrupt binary will not be detected at runtime');
      continue;
    }

    const actual = createHash('sha256').update(readFileSync(resolved.path)).digest('hex');
    if (actual === expected.toLowerCase()) pass(`${name} matches its checksum`, `${Math.round(statSync(resolved.path).size / 1024)} kB`);
    else fail(`${name} does not match its checksum`, 'the shipped binary would be rejected at startup');
  }

  /* --- ffmpeg licence: the one that must not ship wrong ----------------- */
  const ffmpeg = resolver.resolve('ffmpeg').path;
  if (ffmpeg) {
    const runner = new ChildProcessRunner();
    const buildconf = await runner
      .run(ffmpeg, ['-hide_banner', '-buildconf'], { timeoutMs: 15_000 })
      .then((r) => r.stdout)
      .catch(() => '');

    if (buildconf === '') {
      warn('could not read the ffmpeg build configuration', 'licence unverified');
    } else if (/--enable-gpl\b/.test(buildconf)) {
      fail(
        'ffmpeg is a GPL build',
        'shipping it would extend GPL obligations to this product. See docs/SIDECARS.md.',
      );
    } else {
      pass('ffmpeg is an LGPL build');
    }

    const capabilities = await probeCapabilities({ ffmpegPath: ffmpeg });
    const missing = REQUIRED_FILTERS.filter((f) => !capabilities.filters[f]);
    if (missing.length === 0) pass('ffmpeg has every required filter');
    else fail('ffmpeg is missing required filters', missing.join(', '));
  }

  /* --- Icons ------------------------------------------------------------ */
  const icons = [
    ['build/icon.ico', 'Windows'],
    ['build/icon.icns', 'macOS'],
    ['build/icon.png', 'Linux'],
  ] as const;
  for (const [file, platform] of icons) {
    if (existsSync(join(root, file))) pass(`${platform} icon`);
    else warn(`${platform} icon missing (${file})`, 'electron-builder will substitute its default');
  }

  /* --- Native module built for Electron, not Node ----------------------- */
  const binding = join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (existsSync(binding)) pass('better-sqlite3 has a compiled binding');
  else warn('better-sqlite3 has no compiled binding', 'run npm run rebuild before packaging');

  console.log(
    `\n${failures === 0 ? green('ready to package') : red(`${failures} blocking issue(s)`)}` +
      `${warnings > 0 ? yellow(` · ${warnings} warning(s)`) : ''}\n`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
