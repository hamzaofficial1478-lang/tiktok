import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractorUpdater, extractorAgeDays, shouldCheckExtractor } from '@main/media/extractor-updater';
import type { ProcessRunner, ProcessResult } from '@main/resolve/process-runner';

/**
 * Updating yt-dlp.
 *
 * The behaviour under test is mostly about what must NOT happen: a failed or
 * tampered download must never replace a working extractor, because that turns
 * "some videos fail" into "the app cannot download anything".
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upd-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A plausible binary: big enough to pass the size sanity check. */
const GOOD_BINARY = Buffer.alloc(2_000_000, 7);

function runner(result: Partial<ProcessResult>): ProcessRunner {
  return {
    run: async () => ({ stdout: '2026.08.12\n', stderr: '', exitCode: 0, timedOut: false, ...result }),
  };
}

function updaterWith(
  fetchImpl: typeof fetch,
  processResult: Partial<ProcessResult> = {},
  platform: NodeJS.Platform = 'linux',
): ExtractorUpdater {
  return new ExtractorUpdater({
    overrideRoot: dir,
    runner: runner(processResult),
    platform,
    arch: 'x64',
    fetchImpl,
  });
}

const okFetch = (body: Buffer = GOOD_BINARY): typeof fetch =>
  (async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch;

describe('installing an update', () => {
  it('writes the binary under the writable root and records its checksum', async () => {
    const updater = updaterWith(okFetch());

    const result = await updater.update('2026.07.04');

    expect(result.updated).toBe(true);
    expect(result.version).toBe('2026.08.12');
    expect(existsSync(updater.installedPath)).toBe(true);

    // The resolver treats a checksum mismatch as tampering, so an update that
    // did not record its own hash would warn about a file we just wrote.
    const manifest = JSON.parse(readFileSync(join(dir, 'bin', 'manifest.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(manifest.files['linux-x64/yt-dlp']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports no change when the download is the version already installed', async () => {
    const result = await updaterWith(okFetch()).update('2026.08.12');

    expect(result.updated).toBe(false);
    expect(result.message).toMatch(/already on the latest/i);
  });

});

describe('refusing a bad update', () => {
  it('rejects a response that is too small to be the binary', async () => {
    // A captive portal or proxy error page is the realistic case here.
    const html = Buffer.from('<html>Sign in to continue</html>');

    await expect(updaterWith(okFetch(html)).update(null)).rejects.toMatchObject({
      detail: expect.stringMatching(/not a yt-dlp binary/i),
    });
  });

  it('rejects a non-200 from the release server', async () => {
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;

    await expect(updaterWith(failing).update(null)).rejects.toMatchObject({
      detail: expect.stringMatching(/returned 503/i),
    });
  });

  it('reports an unreachable server as such rather than as a mystery', async () => {
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    }) as unknown as typeof fetch;

    await expect(updaterWith(offline).update(null)).rejects.toMatchObject({
      detail: expect.stringMatching(/could not reach/i),
    });
  });

  it('keeps the previous binary when the downloaded one does not execute', async () => {
    const updater = updaterWith(okFetch(), { exitCode: 127, stdout: '' });
    // Stand in for a working extractor already installed.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'bin', 'linux-x64'), { recursive: true });
    writeFileSync(updater.installedPath, 'previous');

    await expect(updater.update('2026.07.04')).rejects.toMatchObject({
      detail: expect.stringMatching(/did not run/i),
    });

    // The whole point: the old one survived, and no staging file was left.
    expect(readFileSync(updater.installedPath, 'utf8')).toBe('previous');
    expect(existsSync(`${updater.installedPath}.new`)).toBe(false);
  });

  it('names the platform when no build is published for it', async () => {
    const updater = new ExtractorUpdater({
      overrideRoot: dir,
      runner: runner({}),
      platform: 'freebsd' as NodeJS.Platform,
      arch: 'mips',
      fetchImpl: okFetch(),
    });

    await expect(updater.update(null)).rejects.toMatchObject({
      detail: expect.stringMatching(/freebsd-mips/),
    });
  });
});

describe('deciding when to check', () => {
  const now = Date.UTC(2026, 7, 13);

  it('measures a release-dated version in days', () => {
    expect(extractorAgeDays('2026.08.13', now)).toBe(0);
    expect(extractorAgeDays('2026.08.06', now)).toBe(7);
    // The version the user actually had when every download failed.
    expect(extractorAgeDays('2026.07.04', now)).toBe(40);
  });

  it('treats an unknown or unparseable version as needing a check', () => {
    expect(extractorAgeDays(null, now)).toBeNull();
    expect(extractorAgeDays('unknown', now)).toBeNull();
    expect(extractorAgeDays('', now)).toBeNull();
  });

  it('tolerates the build suffix upstream sometimes appends', () => {
    expect(extractorAgeDays('2026.08.06.123456', now)).toBe(7);
  });
});

describe('deciding whether to check at all', () => {
  const now = Date.UTC(2026, 7, 13, 12, 0, 0);
  const hours = (n: number): number => n * 3_600_000;

  it('does not re-download every launch when upstream has stopped releasing', () => {
    // The exact bug this replaced. yt-dlp's newest release was 2026.07.04 and
    // the installed build was already that, so an age-only rule called it
    // stale forever and fetched ~30 MB on every single start.
    const stale = { autoUpdate: true, version: '2026.07.04', now };

    const first = shouldCheckExtractor({ ...stale, lastCheckedAt: 0 });
    expect(first).toEqual({ check: true, reason: 'stale' });

    // Having just checked, the next launch must leave it alone even though the
    // installed build is no newer than it was.
    const second = shouldCheckExtractor({ ...stale, lastCheckedAt: now - hours(1) });
    expect(second).toEqual({ check: false, reason: 'checked-recently' });
  });

  it('checks again once the interval has elapsed', () => {
    expect(
      shouldCheckExtractor({ autoUpdate: true, version: '2026.07.04', lastCheckedAt: now - hours(13), now }),
    ).toEqual({ check: true, reason: 'stale' });
  });

  it('leaves a recent build alone', () => {
    expect(
      shouldCheckExtractor({ autoUpdate: true, version: '2026.08.11', lastCheckedAt: 0, now }),
    ).toEqual({ check: false, reason: 'recent-build' });
  });

  it('treats an unknown version as the strongest reason to check', () => {
    // Usually means nothing is installed, which is the case where checking
    // matters most — never a reason to skip.
    expect(shouldCheckExtractor({ autoUpdate: true, version: null, lastCheckedAt: 0, now })).toEqual({
      check: true,
      reason: 'unknown-version',
    });
  });

  it('respects the setting above everything else', () => {
    expect(
      shouldCheckExtractor({ autoUpdate: false, version: null, lastCheckedAt: 0, now }),
    ).toEqual({ check: false, reason: 'disabled' });
  });

  it('checks on a first run, when nothing has ever been recorded', () => {
    expect(shouldCheckExtractor({ autoUpdate: true, version: '2026.01.01', lastCheckedAt: 0, now }).check).toBe(
      true,
    );
  });
});
