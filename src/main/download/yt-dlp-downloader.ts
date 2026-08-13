import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from 'pino';
import type { ProcessRunner } from '../resolve/process-runner';
import { classifyYtDlpFailure } from '../resolve/yt-dlp-errors';
import type { DownloadOutcome, DownloadProgress } from './downloader';

/**
 * Downloading the video with yt-dlp rather than with our own HTTP client.
 *
 * ## Why this exists
 *
 * TikTok's CDN does not serve a stream URL to anyone holding it. Reading
 * yt-dlp's TikTok extractor settles how it is actually authenticated:
 *
 *     'http_headers': {'Referer': webpage_url},          # the only header
 *
 *     auth_cookie = self._get_cookies(self._WEBPAGE_HOST).get('sid_tt')
 *     if auth_cookie:
 *         for f in formats:
 *             self._set_cookie(urlparse(f['url']).hostname, 'sid_tt', ...)
 *
 * The session that makes the CDN answer lives in yt-dlp's **cookiejar**, built
 * while it solved TikTok's challenge during extraction. It is never serialised
 * into the JSON we parse, so no amount of replaying `http_headers` can
 * reproduce it — an earlier attempt to do exactly that still came back 403,
 * because Referer alone was never the thing being checked.
 *
 * Handing the transfer back to the process that holds the session is the only
 * approach that does not amount to reimplementing TikTok's challenge flow. The
 * queue, ordering, deduplication, naming and `.part` guarantees are unchanged;
 * only the bytes move differently.
 */

/** Machine-readable progress, rather than scraping yt-dlp's human output. */
const PROGRESS_PREFIX = 'dlprog:';
const PROGRESS_TEMPLATE =
  `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s;%(progress.total_bytes)s;` +
  `%(progress.total_bytes_estimate)s;%(progress.speed)s;%(progress.eta)s`;

export interface YtDlpDownloadOptions {
  readonly binaryPath: string | null;
  readonly runner: ProcessRunner;
  /** Canonical video URL — yt-dlp re-resolves, so it needs the page, not the CDN URL. */
  readonly url: string;
  /** yt-dlp format_id chosen by the stream selector. */
  readonly formatId: string;
  /** The route that resolved this video; the download must use the same one. */
  readonly extractorArgs?: readonly string[];
  readonly targetPath: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: DownloadProgress) => void;
  readonly proxyUrl?: string | undefined;
  readonly timeoutMs?: number;
  readonly log?: Logger;
}

/** `NA` is what the progress template prints for a value yt-dlp does not have. */
function num(value: string | undefined): number | null {
  if (!value || value === 'NA') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseProgressLine(line: string): DownloadProgress | null {
  const at = line.indexOf(PROGRESS_PREFIX);
  if (at === -1) return null;

  const [done, total, estimate, speed, eta] = line
    .slice(at + PROGRESS_PREFIX.length)
    .trim()
    .split(';');

  const bytesDone = num(done);
  if (bytesDone === null) return null;

  return {
    bytesDone,
    // The estimate is what a fragmented download reports before it knows the
    // real size; without it the UI would show no total at all for those.
    bytesTotal: num(total) ?? num(estimate),
    speed: num(speed),
    etaMs: (() => {
      const seconds = num(eta);
      return seconds === null ? null : Math.round(seconds * 1_000);
    })(),
  };
}

/**
 * Runs yt-dlp against the canonical URL and writes straight to the `.part`.
 *
 * `--no-part` is deliberate and slightly counter-intuitive: yt-dlp would
 * otherwise append its own `.part` suffix to a path that already ends in one,
 * leaving `video.mp4.part.part` and defeating this app's resume logic, which
 * looks for the first. `--continue` then resumes that same file, so an
 * interrupted transfer still picks up where it stopped.
 */
export async function downloadWithYtDlp(options: YtDlpDownloadOptions): Promise<DownloadOutcome> {
  const binary = options.binaryPath;
  if (!binary) throw new AppError('EXTRACTOR_FAILED', 'yt-dlp is not installed');

  const partPath = `${options.targetPath}.part`;
  mkdirSync(dirname(options.targetPath), { recursive: true });
  const resumedFrom = existsSync(partPath) ? statSync(partPath).size : 0;

  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--continue',
    '--no-mtime',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--socket-timeout',
    '20',
    '--newline',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '-f',
    options.formatId,
    '-o',
    partPath,
  ];

  if (options.extractorArgs) args.push(...options.extractorArgs);
  if (options.proxyUrl) args.push('--proxy', options.proxyUrl);
  args.push(options.url);

  let buffer = '';
  const result = await options.runner.run(binary, args, {
    timeoutMs: options.timeoutMs ?? 20 * 60_000,
    signal: options.signal,
    onStdout: (chunk) => {
      // Chunks split anywhere, so hold the tail until a newline completes it.
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const progress = parseProgressLine(line);
        if (progress) options.onProgress(progress);
      }
    },
  });

  if (options.signal.aborted) throw new AppError('CANCELLED', 'download cancelled');

  if (result.exitCode !== 0) {
    const classified = classifyYtDlpFailure(result);
    options.log?.warn(
      { formatId: options.formatId, exitCode: result.exitCode, stderr: result.stderr.slice(0, 800) },
      'yt-dlp download failed',
    );
    // The `.part` is left in place: a partial from a network drop is a resume
    // point, exactly as with the direct downloader.
    throw new AppError(
      classified.code,
      result.stderr.trim().split('\n').pop() ?? `yt-dlp exited ${result.exitCode}`,
    );
  }

  if (!existsSync(partPath)) {
    throw new AppError('DOWNLOAD_INCOMPLETE', 'yt-dlp reported success but wrote no file');
  }

  const bytes = statSync(partPath).size;
  if (bytes === 0) {
    throw new AppError('DOWNLOAD_INCOMPLETE', 'yt-dlp wrote an empty file');
  }

  options.onProgress({ bytesDone: bytes, bytesTotal: bytes, speed: null, etaMs: 0 });
  return { partPath, bytes, resumedFrom };
}
