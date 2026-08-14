import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOutputPath } from '@main/download/filename';
import {
  downloadWithYtDlp,
  parseOutputLine,
  parseProgressLine,
  toOutputTemplate,
  workPathFor,
} from '@main/download/yt-dlp-downloader';
import type { ProcessResult, ProcessRunner, RunOptions } from '@main/resolve/process-runner';

/**
 * Downloading through yt-dlp.
 *
 * This exists because TikTok's CDN authenticates against the cookiejar yt-dlp
 * builds during extraction, which never reaches our process. The tests below
 * pin the two things that make the handover correct: the download reaches the
 * same endpoint the metadata came from, and the file ends up on the `.part`
 * path this app's resume and commit logic expects.
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

/** Where the real yt-dlp writes, given the `-o` it was handed. */
function outputOf(call: readonly string[]): string {
  return call[call.indexOf('-o') + 1] as string;
}

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

describe('reading back the filename yt-dlp settled on', () => {
  it('takes the path out of the print line', () => {
    expect(parseOutputLine('dlfile:/videos/001 - creator.mp4.download')).toBe('/videos/001 - creator.mp4.download');
  });

  it('treats an unknown path as no answer rather than a file called NA', () => {
    expect(parseOutputLine('dlfile:NA')).toBeNull();
    expect(parseOutputLine('dlfile:')).toBeNull();
    expect(parseOutputLine('[download] 100% of 2.00MiB')).toBeNull();
  });
});

describe('escaping the output template', () => {
  /**
   * `-o` is a template, not a filename. TikTok captions are full of "50% off",
   * and a folder the user picked can contain anything; an unescaped `%(id)s`
   * inside a caption is substituted by yt-dlp, which lands the video somewhere
   * this app is not looking.
   */
  it('escapes a literal percent so it is not read as a field', () => {
    expect(toOutputTemplate('/out/50%(id)s off.mp4.download')).toBe('/out/50%%(id)s off.mp4.download');
    expect(toOutputTemplate('/out/100% clean.mp4.download')).toBe('/out/100%% clean.mp4.download');
  });

  it('leaves an ordinary path exactly as it is', () => {
    expect(toOutputTemplate('/out/001 - creator - 7123.mp4.download')).toBe('/out/001 - creator - 7123.mp4.download');
  });
});

const base = {
  url: 'https://www.tiktok.com/@a/video/7123456789012345678',
  formatId: 'bytevc1_1080p_1292473-0',
  signal: new AbortController().signal,
  onProgress: () => {},
};

describe('invoking yt-dlp', () => {
  it('asks for the exact format the selector chose, via the route that resolved it', async () => {
    const { runner, args } = runnerThat((a) => {
      writeFileSync(outputOf(a), Buffer.alloc(2_048));
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

  /**
   * The regression this file exists to prevent.
   *
   * yt-dlp's `undo_temp_name` strips a trailing `.part` unconditionally, so
   * `--no-part -o "v.mp4.part"` wrote `v.mp4.part` and then renamed it to
   * `v.mp4` — the final name, created behind the pipeline's back, over bytes
   * nothing had verified. The check for the `.part` then found nothing, the
   * item failed as "reported success but wrote no file", and each queue retry
   * chose a fresh non-colliding name. One video, three files, marked failed.
   */
  it('never hands yt-dlp a path ending in .part', async () => {
    const { runner, args } = runnerThat((a) => {
      writeFileSync(outputOf(a), Buffer.alloc(4_096));
    });

    await downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') });

    expect(outputOf(args[0] ?? [])).not.toMatch(/\.part$/);
    expect(outputOf(args[0] ?? [])).toBe(workPathFor(join(dir, 'v.mp4')));
  });

  it('leaves the download on this app\'s .part path, and nowhere else', async () => {
    const { runner, args } = runnerThat((a) => {
      writeFileSync(outputOf(a), Buffer.alloc(4_096));
    });

    const outcome = await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
    });

    const call = args[0] ?? [];
    // Without --no-part yt-dlp adds a suffix of its own on top of ours.
    expect(call).toContain('--no-part');
    expect(call).toContain('--continue');
    expect(outcome.partPath).toBe(join(dir, 'v.mp4.part'));
    expect(outcome.bytes).toBe(4_096);
    expect(statSync(join(dir, 'v.mp4.part')).size).toBe(4_096);
    // The final name must not exist until the pipeline commits it.
    expect(existsSync(join(dir, 'v.mp4'))).toBe(false);
    // And the working file is consumed, not left beside the result.
    expect(existsSync(join(dir, 'v.mp4.download'))).toBe(false);
  });

  it('asks yt-dlp to name the file it wrote, without silencing progress', async () => {
    const { runner, args } = runnerThat((a) => {
      writeFileSync(outputOf(a), Buffer.alloc(1_024));
    });

    await downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') });

    const call = args[0] ?? [];
    expect(call[call.indexOf('--print') + 1]).toBe('after_move:dlfile:%(filepath)s');
    // --print implies --quiet, which would leave the UI with no speed or ETA
    // for the entire transfer.
    expect(call).toContain('--no-quiet');
    expect(call).toContain('--progress-template');
  });

  it('reports what it resumed from', async () => {
    writeFileSync(join(dir, 'v.mp4.download'), Buffer.alloc(1_024));
    const { runner } = runnerThat((a) => {
      writeFileSync(outputOf(a), Buffer.alloc(8_192));
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
    const { runner } = runnerThat((a, options) => {
      // Split mid-line, as a real stdout chunk would be.
      options.onStdout?.('dlprog:100;1000;NA;50;9\ndlprog:500;10');
      options.onStdout?.('00;NA;50;5\n');
      writeFileSync(outputOf(a), Buffer.alloc(1_000));
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

describe('finding the file when yt-dlp does not use the name it was given', () => {
  it('follows the path yt-dlp printed', async () => {
    const elsewhere = join(dir, 'renamed-by-ytdlp.mkv');
    const { runner } = runnerThat((_a, options) => {
      writeFileSync(elsewhere, Buffer.alloc(3_000));
      options.onStdout?.(`dlfile:${elsewhere}\n`);
    });

    const outcome = await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
    });

    expect(outcome.partPath).toBe(join(dir, 'v.mp4.part'));
    expect(outcome.bytes).toBe(3_000);
    expect(existsSync(elsewhere)).toBe(false);
  });

  /**
   * The safety net for the exact failure that shipped: whatever the reason, a
   * file that appears at the final name during the run is this download's
   * output, and adopting it beats failing an item whose bytes are on disk —
   * which is what turns one download into several files.
   */
  it('adopts a file that appeared at the final name during the run', async () => {
    const { runner } = runnerThat(() => {
      writeFileSync(join(dir, 'v.mp4'), Buffer.alloc(5_000));
    });

    const outcome = await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
    });

    expect(outcome.bytes).toBe(5_000);
    expect(outcome.partPath).toBe(join(dir, 'v.mp4.part'));
    // Back under a `.part`, so verification still runs before it is committed.
    expect(existsSync(join(dir, 'v.mp4'))).toBe(false);
  });

  it('never adopts a file that was already there', async () => {
    // Someone else's video, under the name this item happens to have resolved
    // to. Claiming it would report a download that never happened, and the
    // pipeline would rename a stranger's file into this item's place.
    writeFileSync(join(dir, 'v.mp4'), 'an older download');
    const { runner } = runnerThat(() => ({ exitCode: 0 }));

    await expect(
      downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });

    expect(readFileSync(join(dir, 'v.mp4'), 'utf8')).toBe('an older download');
  });

  it('prefers the real file over an empty leftover', async () => {
    const printed = join(dir, 'actual.mp4');
    const { runner } = runnerThat((a, options) => {
      writeFileSync(outputOf(a), Buffer.alloc(0));
      writeFileSync(printed, Buffer.alloc(2_500));
      options.onStdout?.(`dlfile:${printed}\n`);
    });

    const outcome = await downloadWithYtDlp({
      ...base,
      binaryPath: '/fake/yt-dlp',
      runner,
      targetPath: join(dir, 'v.mp4'),
    });

    expect(outcome.bytes).toBe(2_500);
  });
});

describe('the incident: one video, three files', () => {
  /**
   * A stand-in for the real yt-dlp, reproducing the two behaviours that
   * combined to cause it — verified against yt-dlp 2026.07.04 and matching
   * `temp_name` / `undo_temp_name` / `try_rename` in yt_dlp/downloader/.
   */
  function ytDlpLike(): ProcessRunner {
    return {
      run: async (_cmd, a) => {
        const template = a[a.indexOf('-o') + 1] as string;
        // `-o` is a template, scanned left to right: `%%` is a literal percent,
        // `%(x)s` a field. The order matters — `%%(id)s` is a percent followed
        // by plain text, not an escaped percent followed by a field.
        const written = template.replace(/%%|%\(\w+\)s/g, (match) => (match === '%%' ? '%' : 'FIELD'));
        writeFileSync(written, Buffer.alloc(6_000));
        // --no-part means yt-dlp adds no suffix of its own, and then undoes a
        // trailing `.part` it assumes it must have added itself.
        const destination = written.endsWith('.part') ? written.slice(0, -'.part'.length) : written;
        if (destination !== written) renameSync(written, destination);
        return { stdout: `dlfile:${destination}\n`, stderr: '', exitCode: 0, timedOut: false };
      },
    };
  }

  it('downloads once and leaves one file, across the retries that produced three', async () => {
    const runner = ytDlpLike();
    const directory = dir;

    // What the pipeline does per attempt: pick a non-colliding final name,
    // download to its `.part`. Before the fix, attempt 1 landed the video on
    // the final name, failed the item, and attempts 2 and 3 each chose a fresh
    // name and did it again. This pins the outcome rather than one mechanism,
    // and now holds for two independent reasons: yt-dlp is never handed a name
    // it would rewrite, and a file that turns up at the final name anyway is
    // adopted instead of abandoned.
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const targetPath = resolveOutputPath({
        directory,
        basename: '001 - creator - 7123456789012345678',
        extension: '.mp4',
        onCollision: 'suffix',
      });
      outcomes.push(
        (await downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath })).partPath,
      );
    }

    // Every attempt resolved to the same name, because no attempt ever created
    // the final one — so nothing collided and nothing was suffixed.
    expect(new Set(outcomes).size).toBe(1);
    expect(readdirSync(directory).filter((name) => name.includes('7123456789012345678'))).toEqual([
      '001 - creator - 7123456789012345678.mp4.part',
    ]);
  });

  it('survives a caption yt-dlp would otherwise read as a field', async () => {
    const runner = ytDlpLike();
    const targetPath = join(dir, '001 - 50%(id)s off.mp4');

    const outcome = await downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath });

    expect(outcome.partPath).toBe(`${targetPath}.part`);
    expect(existsSync(`${targetPath}.part`)).toBe(true);
    // Unescaped, the caption would have become "001 - 50FIELD off.mp4".
    expect(readdirSync(dir).some((name) => name.includes('FIELD'))).toBe(false);
  });
});

describe('failures', () => {
  it('keeps the partial when the transfer fails, so a retry resumes', async () => {
    writeFileSync(join(dir, 'v.mp4.download'), Buffer.alloc(2_048));
    const { runner } = runnerThat(() => ({ exitCode: 1, stderr: 'ERROR: unable to download video data' }));

    await expect(
      downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(existsSync(join(dir, 'v.mp4.download'))).toBe(true);
  });

  it('does not claim success when yt-dlp exits 0 having written nothing', async () => {
    const { runner } = runnerThat(() => ({ exitCode: 0 }));

    await expect(
      downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });
  });

  it('rejects an empty file rather than committing it', async () => {
    const { runner } = runnerThat((a) => {
      writeFileSync(outputOf(a), Buffer.alloc(0));
    });

    await expect(
      downloadWithYtDlp({ ...base, binaryPath: '/fake/yt-dlp', runner, targetPath: join(dir, 'v.mp4') }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });

    // Zero bytes is not a resume point; leaving it would tell the next attempt
    // it had one.
    expect(existsSync(join(dir, 'v.mp4.download'))).toBe(false);
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
    const { runner, args } = runnerThat((a) => {
      writeFileSync(outputOf(a), Buffer.alloc(2_048));
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
        writeFileSync(outputOf(a), Buffer.alloc(4_096));
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
