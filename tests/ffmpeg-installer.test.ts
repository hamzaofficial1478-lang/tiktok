import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegInstaller, findBinaries } from '@main/media/ffmpeg-installer';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';

/**
 * Installing ffmpeg from inside the app.
 *
 * The behaviour that matters is refusal: a half-installed or non-working ffmpeg
 * makes the capability probe report a build with no filters, which the UI shows
 * as "your machine cannot remove watermarks" rather than "the download failed".
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('finding the binaries in an extracted archive', () => {
  /** Upstream nests them under a build-dated directory that changes every release. */
  function makeTree(root: string, names: string[], size = 200_000): void {
    const bin = join(root, 'ffmpeg-master-latest-linux64-lgpl', 'bin');
    mkdirSync(bin, { recursive: true });
    for (const name of names) writeFileSync(join(bin, name), Buffer.alloc(size));
  }

  it('finds both wherever the archive happens to nest them', () => {
    makeTree(dir, ['ffmpeg', 'ffprobe', 'ffplay']);

    const found = findBinaries(dir, 'linux');

    expect(found.ffmpeg).toMatch(/bin[/\\]ffmpeg$/);
    expect(found.ffprobe).toMatch(/bin[/\\]ffprobe$/);
  });

  it('uses the platform-correct filename', () => {
    const bin = join(dir, 'nested', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ffmpeg.exe'), Buffer.alloc(200_000));
    writeFileSync(join(bin, 'ffprobe.exe'), Buffer.alloc(200_000));

    expect(findBinaries(dir, 'win32').ffmpeg).toMatch(/ffmpeg\.exe$/);
    // A Windows archive holds no extensionless binary, and vice versa.
    expect(findBinaries(dir, 'linux').ffmpeg).toBeNull();
  });

  it('ignores a same-named file too small to be an executable', () => {
    // Archives carry licences and man pages; "ffmpeg" as a text file is not it.
    makeTree(dir, ['ffmpeg', 'ffprobe'], 500);
    expect(findBinaries(dir, 'linux').ffmpeg).toBeNull();
  });

  it('reports null rather than throwing on an empty or missing tree', () => {
    expect(findBinaries(dir, 'linux')).toEqual({ ffmpeg: null, ffprobe: null });
    expect(findBinaries(join(dir, 'nope'), 'linux')).toEqual({ ffmpeg: null, ffprobe: null });
  });
});

describe('platform support', () => {
  function installerFor(platform: NodeJS.Platform, arch: string): FfmpegInstaller {
    return new FfmpegInstaller({
      overrideRoot: dir,
      runner: { run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) },
      platform,
      arch,
    });
  }

  it('knows which platforms it can install for', () => {
    expect(installerFor('win32', 'x64').isSupported).toBe(true);
    expect(installerFor('linux', 'x64').isSupported).toBe(true);
    // No LGPL macOS prebuild is published, so this must say so rather than
    // download a GPL one and quietly create a licensing problem.
    expect(installerFor('darwin', 'arm64').isSupported).toBe(false);
  });

  it('names the platform when it cannot help, instead of failing vaguely', async () => {
    await expect(installerFor('darwin', 'arm64').install()).rejects.toMatchObject({
      detail: expect.stringMatching(/darwin-arm64/),
    });
  });
});

describe('refusing a bad install', () => {
  const bigEnough = Buffer.alloc(6_000_000, 3);

  function installerWith(
    fetchImpl: typeof fetch,
    runResults: Partial<ProcessResult>[] = [],
  ): { installer: FfmpegInstaller; commands: string[] } {
    const commands: string[] = [];
    let index = 0;
    const runner: ProcessRunner = {
      run: async (command) => {
        commands.push(command);
        const result = runResults[Math.min(index++, runResults.length - 1)] ?? {};
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
      },
    };
    return {
      commands,
      installer: new FfmpegInstaller({ overrideRoot: dir, runner, platform: 'linux', arch: 'x64', fetchImpl }),
    };
  }

  const ok = (body: Buffer): typeof fetch =>
    (async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch;

  it('rejects a response too small to be the archive', async () => {
    const portal = Buffer.from('<html>Sign in to your network</html>');

    await expect(installerWith(ok(portal)).installer.install()).rejects.toMatchObject({
      detail: expect.stringMatching(/not an ffmpeg archive/i),
    });
  });

  it('rejects a non-200 from the download server', async () => {
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;

    await expect(installerWith(failing).installer.install()).rejects.toMatchObject({
      detail: expect.stringMatching(/returned 404/i),
    });
  });

  it('reports an unreachable server as such', async () => {
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    }) as unknown as typeof fetch;

    await expect(installerWith(offline).installer.install()).rejects.toMatchObject({
      detail: expect.stringMatching(/could not reach/i),
    });
  });

  it('reports a failed unpack rather than an empty archive', async () => {
    const { installer, commands } = installerWith(ok(bigEnough), [
      { exitCode: 1, stderr: 'tar: unexpected end of file' },
    ]);

    await expect(installer.install()).rejects.toMatchObject({
      detail: expect.stringMatching(/could not unpack/i),
    });
    expect(commands[0]).toBe('tar');
  });

  it('says the archive was wrong when it unpacks but holds no binaries', async () => {
    const { installer } = installerWith(ok(bigEnough), [{ exitCode: 0 }]);

    await expect(installer.install()).rejects.toMatchObject({
      detail: expect.stringMatching(/did not contain ffmpeg/i),
    });
    // Nothing was installed, so the app is no worse off than before.
    expect(existsSync(installer.targetPath('ffmpeg'))).toBe(false);
  });

  it('reports progress through each phase', async () => {
    const phases: string[] = [];
    const { installer } = installerWith(ok(bigEnough), [{ exitCode: 1, stderr: 'boom' }]);

    await installer.install((progress) => phases.push(progress.phase)).catch(() => undefined);

    // A ~100 MB download with no feedback reads as a frozen app.
    expect(phases[0]).toBe('downloading');
    expect(phases).toContain('extracting');
  });
});

describe('the manifest after an install', () => {
  it('is left alone when nothing was installed', () => {
    const manifestPath = join(dir, 'bin', 'manifest.json');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ files: { 'linux-x64/yt-dlp': 'abc' } }));

    // A failed ffmpeg install must not disturb the extractor's recorded hash.
    const before = readFileSync(manifestPath, 'utf8');
    expect(JSON.parse(before).files['linux-x64/yt-dlp']).toBe('abc');
  });
});
