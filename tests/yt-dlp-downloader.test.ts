import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadWithYtDlp, parseProgressLine } from '@main/download/yt-dlp-downloader';
import type { ProcessResult, ProcessRunner, RunOptions } from '@main/resolve/process-runner';

/**
 * Downloading through yt-dlp.
 *
 * This exists because TikTok's CDN authenticates against the cookiejar yt-dlp
 * builds during extraction, which never reaches our process. The tests below
 * pin the two things that make the handover correct: the download reaches the
 * same endpoint the metadata came from, and it writes to the `.part` path this
 * app's resume logic expects.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ytdl-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runnerThat(
  behaviour: (args: readonly string[], options: RunOptions) => Partial<ProcessResult> | void,
): { runner: ProcessRunner; args: string[][] } {
  const args: string[][] = [];
  return {
    args,
    runner: {
      run: async (_cmd, a, options = {}) => {
        args.push([...a]);
        const result = behaviour(a, options) ?? {};
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
      },
    },
  };
}

const base = {
  url: 'https://www.tiktok.com/@a/video/7123456789012345678',
  formatId: 'bytevc1_1080p_1292473-0',
  signal: new AbortController().signal,
  onProgress: () => {},
};

describe('parsing progress', () => {
  it('reads the machine-readable template rather than yt-dlp prose', () => {
    expect(parseProgressLine('dlprog:524288;1048576;NA;131072.5;4')).toEqual({
      bytesDone: 524_288,
      bytesTotal: 1_048_576,
      speed: 131_072.5,
      etaMs: 4_000,
    });
  });

  it('falls back to the estimate when the real total is unknown', () => {
    // A fragmented download reports only an estimate until it finishes.
    expect(parseProgressLine('dlprog:1000;NA;5000;NA;NA')).toMatchObject({
      bytesDone: 1_000,
      bytesTotal: 5_000,
      speed: null,
      etaMs: null,
    });
  });

  it('ignores yt-dlp lines that are not progress', () => {
    expect(parseProgressLine('[TikTok] Extracting URL: https://...')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine('dlprog:NA;NA;NA;NA;NA')).toBeNull();
  });
});

describe('invoking yt-dlp', () => {
  it('asks for the exact format the selector chose, via the route that resolved it', async () => {
    const { runner, args } = runnerThat((_a) => {
      writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(2_048));
    });

    await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
      routes: [['--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com']],
    });

    const call = args[0] ?? [];
    // A different route would re-resolve through the one that was failing.
    expect(call).toContain('--extractor-args');
    expect(call).toContain('tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com');
    expect(call[call.indexOf('-f') + 1]).toBe('bytevc1_1080p_1292473-0');
    // yt-dlp is given the page URL: it re-resolves and holds the session.
    expect(call[call.length - 1]).toBe(base.url);
  });

  it('writes to this app\'s .part path, not one of its own', async () => {
    const { runner, args } = runnerThat(() => {
      writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(4_096));
    });

    const outcome = await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
    });

    const call = args[0] ?? [];
    // Without --no-part yt-dlp appends its own suffix, producing
    // "v.mp4.part.part" and defeating this app's resume logic.
    expect(call).toContain('--no-part');
    expect(call).toContain('--continue');
    expect(call[call.indexOf('-o') + 1]).toBe(join(dir, 'v.mp4.part'));
    expect(outcome.partPath).toBe(join(dir, 'v.mp4.part'));
    expect(outcome.bytes).toBe(4_096);
    // The final name must not exist until the pipeline commits it.
    expect(existsSync(join(dir, 'v.mp4'))).toBe(false);
  });

  it('reports what it resumed from', async () => {
    writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(1_024));
    const { runner } = runnerThat(() => {
      writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(8_192));
    });

    const outcome = await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
    });

    expect(outcome.resumedFrom).toBe(1_024);
  });

  it('streams progress out as it arrives', async () => {
    const seen: number[] = [];
    const { runner } = runnerThat((_a, options) => {
      // Split mid-line, as a real stdout chunk would be.
      options.onStdout?.('dlprog:100;1000;NA;50;9\ndlprog:500;10');
      options.onStdout?.('00;NA;50;5\n');
      writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(1_000));
    });

    await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
      onProgress: (p) => seen.push(p.bytesDone),
    });

    // The second line arrived across two chunks and must not be lost.
    expect(seen).toContain(100);
    expect(seen).toContain(500);
  });
});

describe('failures', () => {
  it('keeps the .part when the transfer fails, so a retry resumes', async () => {
    writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(2_048));
    const { runner } = runnerThat(() => ({ exitCode: 1, stderr: 'ERROR: unable to download video data' }));

    await expect(
      downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(existsSync(join(dir, 'v.mp4.part'))).toBe(true);
  });

  it('does not claim success when yt-dlp exits 0 having written nothing', async () => {
    const { runner } = runnerThat(() => ({ exitCode: 0 }));

    await expect(
      downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });
  });

  it('rejects an empty file rather than committing it', async () => {
    const { runner } = runnerThat(() => {
      writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(0));
    });

    await expect(
      downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });
  });

  it('says so plainly when yt-dlp is not installed', async () => {
    const { runner } = runnerThat(() => ({}));
    await expect(
      downloadWithYtDlp({ ...base, binaryPath: null, runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
  });
});

describe('the download presents the same identity as the extraction', () => {
  it('sends a browser user agent, as extraction does', async () => {
    const { runner, args } = runnerThat(() => {
      writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(2_048));
    });

    await downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') });

    const call = args[0] ?? [];
    /**
     * Its absence was the bug: extraction identified as a browser, the download
     * identified as yt-dlp, and TikTok answered the second one differently —
     * a resolve at 20:57:45 followed by a download failure at 20:57:55 on the
     * very same route.
     */
    expect(call).toContain('--user-agent');
    expect(call[call.indexOf('--user-agent') + 1]).toContain('Mozilla/5.0');
  });
});

describe('trying more than one route to download', () => {
  it('moves to the next route when extraction fails on the first', async () => {
    let attempt = 0;
    const seen: string[][] = [];
    const runner: ProcessRunner = {
      run: async (_cmd, a) => {
        seen.push([...a]);
        attempt++;
        if (attempt === 1) {
          return {
            stdout: '',
            stderr: 'ERROR: [TikTok] 7123: Unexpected response from webpage request',
            exitCode: 1,
            timedOut: false,
          };
        }
        writeFileSync(join(dir, 'v.mp4.part'), Buffer.alloc(4_096));
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    };

    const outcome = await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
      routes: [[], ['--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com']],
    });

    expect(outcome.bytes).toBe(4_096);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com');
  });

  it('does not waste routes on a failure another route cannot fix', async () => {
    let attempts = 0;
    const runner: ProcessRunner = {
      run: async () => {
        attempts++;
        return { stdout: '', stderr: 'ERROR: No space left on device', exitCode: 1, timedOut: false };
      },
    };

    await expect(
      downloadWithYtDlp({
        ...base,
        binaryPath: '/fake/yt-dlp',
        runner,
        targetPath: join(dir, 'v.mp4'),
        routes: [[], ['--extractor-args', 'x'], ['--extractor-args', 'y']],
      }),
    ).rejects.toBeTruthy();

    // A full disk fails identically on every route; retrying is only delay.
    expect(attempts).toBe(1);
  });
});
