import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SidecarResolver, binaryFilename, platformDir, sha256File } from '@main/media/sidecars';
import { probeCapabilities, REQUIRED_FILTERS } from '@main/media/capabilities';

let root: string;

/** Writes an executable stub so resolution and checksums can be tested without a real ffmpeg. */
function writeStub(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return createHash('sha256').update(body).digest('hex');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sidecar-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('sidecar layout', () => {
  it('names directories and binaries per platform', () => {
    expect(platformDir('win32', 'x64')).toBe('win32-x64');
    expect(platformDir('darwin', 'arm64')).toBe('darwin-arm64');
    expect(binaryFilename('yt-dlp', 'win32')).toBe('yt-dlp.exe');
    expect(binaryFilename('yt-dlp', 'darwin')).toBe('yt-dlp');
  });
});

describe('SidecarResolver', () => {
  it('prefers the bundled binary over anything on PATH', () => {
    const dir = join(root, 'bin', platformDir(process.platform, process.arch));
    writeStub(join(dir, binaryFilename('ffmpeg')), '#!/bin/sh\necho stub\n');

    const resolved = new SidecarResolver({ resourcesRoot: root }).resolve('ffmpeg');
    expect(resolved.source).toBe('bundled');
    expect(resolved.path).toBe(join(dir, binaryFilename('ffmpeg')));
  });

  it('reports missing rather than throwing when a packaged build has no binary', async () => {
    const resolver = new SidecarResolver({ resourcesRoot: root, allowPathFallback: false });

    expect(resolver.resolve('yt-dlp')).toMatchObject({ source: 'missing', path: null });

    const status = await resolver.status('yt-dlp');
    expect(status.present).toBe(false);
    expect(status.error).toMatch(/not installed/i);
  });

  it('validates a bundled binary against the manifest', async () => {
    const platformKey = platformDir(process.platform, process.arch);
    const dir = join(root, 'bin', platformKey);
    const hash = writeStub(join(dir, binaryFilename('yt-dlp')), '#!/bin/sh\necho "2026.07.04"\n');
    writeFileSync(
      join(root, 'bin', 'manifest.json'),
      JSON.stringify({ files: { [`${platformKey}/${binaryFilename('yt-dlp')}`]: hash } }),
    );

    const status = await new SidecarResolver({ resourcesRoot: root, allowPathFallback: false }).status('yt-dlp');
    expect(status.present).toBe(true);
    expect(status.checksumValid).toBe(true);
    expect(status.error).toBeNull();
    expect(status.version).toBe('2026.07.04');
  });

  it('flags a binary whose checksum does not match, without throwing', async () => {
    const platformKey = platformDir(process.platform, process.arch);
    const dir = join(root, 'bin', platformKey);
    writeStub(join(dir, binaryFilename('ffprobe')), '#!/bin/sh\necho tampered\n');
    writeFileSync(
      join(root, 'bin', 'manifest.json'),
      JSON.stringify({ files: { [`${platformKey}/${binaryFilename('ffprobe')}`]: 'a'.repeat(64) } }),
    );

    const status = await new SidecarResolver({ resourcesRoot: root, allowPathFallback: false }).status('ffprobe');
    expect(status.present).toBe(true);
    expect(status.checksumValid).toBe(false);
    expect(status.error).toMatch(/checksum/i);
  });

  it('hashes files correctly', async () => {
    const file = join(root, 'x.bin');
    writeFileSync(file, 'hello');
    expect(await sha256File(file)).toBe(createHash('sha256').update('hello').digest('hex'));
  });
});

describe('ffmpeg capability probe', () => {
  it('returns an unprobed result when ffmpeg is absent instead of failing startup', async () => {
    const capabilities = await probeCapabilities({ ffmpegPath: null });
    expect(capabilities.probed).toBe(false);
    expect(capabilities.isGplBuild).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'detects an LGPL build that has the required filters',
    async () => {
      const filters = [...REQUIRED_FILTERS, 'avgblur'].map((f) => ` T.. ${f}   V->V  desc`).join('\n');
      const script = join(root, 'ffmpeg-lgpl');
      writeStub(
        script,
        `#!/bin/sh
case "$*" in
  *-filters*)   echo "Filters:"; echo "${filters.replace(/\n/g, '"; echo "')}" ;;
  *-encoders*)  echo "Encoders:"; echo " V..... libopenh264  OpenH264"; echo " V..... h264_nvenc  NVENC" ;;
  *-buildconf*) echo "configuration:"; echo "  --disable-gpl --enable-libopenh264" ;;
esac
`,
      );

      const capabilities = await probeCapabilities({ ffmpegPath: script });
      expect(capabilities.probed).toBe(true);
      expect(capabilities.isGplBuild).toBe(false);
      expect(capabilities.missingRequired).toEqual([]);
      expect(capabilities.filters['removelogo']).toBe(true);
      expect(capabilities.filters['gblur']).toBe(true);
      expect(capabilities.encoders['libopenh264']).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'flags a GPL build and reports missing LGPL-safe filters',
    async () => {
      // A GPL build that has delogo/boxblur but lacks removelogo — exactly the
      // situation section 3 forbids shipping.
      const script = join(root, 'ffmpeg-gpl');
      writeStub(
        script,
        `#!/bin/sh
case "$*" in
  *-filters*)   echo "Filters:"; echo " T.. delogo   V->V"; echo " T.. boxblur  V->V"; echo " T.. overlay  V->V"; echo " ... crop     V->V"; echo " ... split    V->V"; echo " ... scale    V->V"; echo " ... trim     V->V" ;;
  *-encoders*)  echo "Encoders:"; echo " V..... libx264  H.264" ;;
  *-buildconf*) echo "configuration:"; echo "  --enable-gpl --enable-libx264" ;;
esac
`,
      );

      const capabilities = await probeCapabilities({ ffmpegPath: script });
      expect(capabilities.isGplBuild).toBe(true);
      expect(capabilities.filters['removelogo']).toBe(false);
      expect(capabilities.missingRequired).toContain('removelogo');
      expect(capabilities.missingRequired).toContain('gblur');
      // libx264 is GPL and deliberately not an accepted encoder.
      expect(capabilities.missingRequired).toContain('an H.264 encoder (hardware or libopenh264)');
    },
  );
});
