import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from 'pino';
import type { ProcessRunner } from '../resolve/process-runner';
import { classifyYtDlpFailure } from '../resolve/yt-dlp-errors';
import { BROWSER_USER_AGENT } from '../resolve/yt-dlp-extractor';
import { partPathFor, type DownloadOutcome, type DownloadProgress } from './downloader';

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

/** yt-dlp naming the file it actually wrote, rather than us assuming. */
const OUTPUT_PREFIX = 'dlfile:';
const OUTPUT_TEMPLATE = `after_move:${OUTPUT_PREFIX}%(filepath)s`;

/**
 * The suffix yt-dlp writes to while the transfer is in flight.
 *
 * It is emphatically **not** `.part`, and that is the whole point. yt-dlp
 * reserves that suffix for its own temporary files and takes a trailing `.part`
 * on a path as its own handiwork, undoing it:
 *
 *     def temp_name(self, filename):
 *         if self.params.get('nopart', False) or ...:
 *             return filename                       # --no-part: no suffix added
 *         return filename + '.part'
 *
 *     def undo_temp_name(self, filename):
 *         if filename.endswith('.part'):            # unconditional
 *             return filename[:-len('.part')]
 *
 * — yt_dlp/downloader/common.py, with `try_rename(ctx.tmpfilename, ctx.filename)`
 * in http.py performing the move at the end.
 *
 * So `--no-part -o "video.mp4.part"` writes `video.mp4.part` and then renames it
 * to `video.mp4`: this app's own working file is mistaken for yt-dlp's and gets
 * promoted to the final name behind our back. That was a real, shipped bug. Its
 * signature is worth recognising, because it looks nothing like its cause: the
 * download succeeds, the check for the `.part` finds nothing, the item fails
 * with "reported success but wrote no file", the queue retries, and each retry
 * picks a fresh non-colliding name — leaving one video downloaded three times
 * under three names while the UI reports failure.
 *
 * `.download` is left alone (verified against yt-dlp 2026.07.04), so the file
 * stays ours until we rename it onto the `.part` path the pipeline expects.
 */
const WORK_SUFFIX = '.download';

/** Where yt-dlp writes; deterministic, so an interrupted attempt can resume it. */
export function workPathFor(targetPath: string): string {
  return `${targetPath}${WORK_SUFFIX}`;
}

/**
 * Escapes a path for use as a yt-dlp output template.
 *
 * `-o` is a template, not a filename: `%(...)s` sequences in it are substituted.
 * Filenames come from TikTok captions and from a folder the user chose, neither
 * of which is under our control, and `%` is legal on every target platform so
 * nothing upstream strips it. A caption containing `50%(id)s off` would
 * otherwise be silently rewritten by yt-dlp — landing the file somewhere we are
 * not looking, breaking the "output N matches link N" guarantee, and failing the
 * item exactly like the `.part` bug above. `%%` is the documented literal.
 */
export function toOutputTemplate(path: string): string {
  return path.replace(/%/g, '%%');
}

export interface YtDlpDownloadOptions {
  readonly binaryPath: string | null;
  readonly runner: ProcessRunner;
  /** Canonical video URL — yt-dlp re-resolves, so it needs the page, not the CDN URL. */
  readonly url: string;
  /** yt-dlp format_id chosen by the stream selector. */
  readonly formatId: string;
  /**
   * Routes to try, best first.
   *
   * The download re-extracts, so it can fail on a route that resolution
   * succeeded on moments earlier — TikTok's web path in particular is flaky
   * between one request and the next. Resolution already survives that by
   * trying several routes; the download now does the same instead of giving up
   * on the first refusal.
   */
  readonly routes?: readonly (readonly string[])[];
  readonly targetPath: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: DownloadProgress) => void;
  readonly proxyUrl?: string | undefined;
  /**
   * Languages to fetch caption tracks for, in yt-dlp's `--sub-langs` syntax.
   *
   * Absent means no captions were asked for, and no subtitle flags are sent at
   * all. Present, it rides along with the transfer: TikTok's caption URLs need
   * the same session the video does, so fetching them separately would mean a
   * second extraction and a second challenge solve for a video already in
   * flight.
   */
  readonly subtitleLangs?: string | undefined;
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

/** yt-dlp's `--print` output, naming the file it settled on. */
export function parseOutputLine(line: string): string | null {
  const at = line.indexOf(OUTPUT_PREFIX);
  if (at === -1) return null;
  const path = line.slice(at + OUTPUT_PREFIX.length).trim();
  return path === '' || path === 'NA' ? null : path;
}

/**
 * Finds the file yt-dlp actually produced, in descending order of confidence.
 *
 * Assuming the answer is what cost three copies of one video, so this asks
 * rather than assumes. The work path is where yt-dlp was told to write; the
 * printed path is where it says it wrote; the final name is the one place a
 * future yt-dlp could relocate the file to without telling us, and is only
 * eligible if it appeared during this run — a file that was already there
 * belongs to someone else and must never be adopted.
 */
function locateProduced(candidates: readonly (string | null)[]): string | null {
  const present = candidates.filter((path): path is string => path !== null && existsSync(path));
  // A leftover empty file must not shadow the real one, but if empty is all
  // there is, returning it produces the accurate "wrote an empty file".
  return present.find((path) => statSync(path).size > 0) ?? present[0] ?? null;
}

/**
 * Runs yt-dlp against the canonical URL, then moves the result onto the `.part`.
 *
 * `--no-part` stops yt-dlp adding a second suffix of its own, and `--continue`
 * resumes the work file, so an interrupted transfer picks up where it stopped
 * rather than starting the video again. The final name is created by
 * `commitPart` after verification and at no other point.
 */
export async function downloadWithYtDlp(options: YtDlpDownloadOptions): Promise<DownloadOutcome> {
  const binary = options.binaryPath;
  if (!binary) throw new AppError('EXTRACTOR_FAILED', 'yt-dlp is not installed');

  const partPath = partPathFor(options.targetPath);
  const workPath = workPathFor(options.targetPath);
  mkdirSync(dirname(options.targetPath), { recursive: true });
  const resumedFrom = existsSync(workPath) ? statSync(workPath).size : 0;
  // Captured before anything runs: see locateProduced.
  const targetExisted = existsSync(options.targetPath);

  const routes = options.routes && options.routes.length > 0 ? options.routes : [[]];
  let lastError: unknown;

  for (const [index, route] of routes.entries()) {
    try {
      return await attemptDownload(options, binary, { partPath, workPath, targetExisted }, resumedFrom, route);
    } catch (err) {
      lastError = err;
      const code = (err as { code?: string }).code;
      /**
       * Which failures are worth another route.
       *
       * A full disk or a cancellation would fail identically every time, so
       * those stop here. RESOLVE_FAILED is in the list because that is now
       * where a page served without its video data lands — the exact failure
       * the mobile-app routes exist to get around, since they ask a different
       * endpoint that returns JSON rather than a scraped page. Leaving it out
       * meant the download gave up on the web route without ever trying the
       * two routes that were most likely to work.
       */
      if (code !== 'EXTRACTOR_FAILED' && code !== 'CDN_FORBIDDEN' && code !== 'RESOLVE_FAILED') throw err;
      if (index < routes.length - 1) {
        options.log?.warn(
          { formatId: options.formatId, code, route: index },
          'download route failed; trying the next one',
        );
      }
    }
  }

  throw lastError;
}

interface Paths {
  readonly partPath: string;
  readonly workPath: string;
  readonly targetExisted: boolean;
}

async function attemptDownload(
  options: YtDlpDownloadOptions,
  binary: string,
  paths: Paths,
  resumedFrom: number,
  route: readonly string[],
): Promise<DownloadOutcome> {
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--continue',
    '--no-mtime',
    /**
     * `--print` implies `--quiet`, which silences the progress template and
     * would leave the UI with a frozen speed and no ETA for the whole transfer.
     * Asking for both back is the only way to have the file's name reported and
     * the transfer still visible.
     */
    '--no-quiet',
    '--print',
    OUTPUT_TEMPLATE,
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--socket-timeout',
    '20',
    '--newline',
    '--progress-template',
    PROGRESS_TEMPLATE,
    /**
     * The same browser identity the extraction used.
     *
     * Its absence here was the bug: extraction sent a browser user agent and
     * the download sent none, so yt-dlp re-extracted as itself, TikTok served
     * it something else, and the download failed with the web extractor's
     * "Unexpected response from webpage request" seconds after the very same
     * route had resolved the video successfully.
     */
    '--user-agent',
    BROWSER_USER_AGENT,
    '-f',
    options.formatId,
    /**
     * Only when a merge is actually happening.
     *
     * `-o` ends in `.download`, which is not a container yt-dlp recognises, so
     * with two formats to join it would pick one itself and rename the result.
     * The output would still be found — the printed path and the adopt
     * fallback see to that — but it would arrive as an .mkv the rest of the
     * app named .mp4.
     */
    /**
     * Only when a merge is actually happening.
     *
     * `-o` ends in `.download`, which is not a container yt-dlp recognises, so
     * with two formats to join it would pick one itself and rename the result.
     *
     * `-movflags +faststart` is the part that matters to anything downstream.
     * ffmpeg writes an MP4's index — the `moov` atom — at the *end* of the file
     * by default, and only moves it to the front when asked. TikTok's own
     * single-stream files already have it at the front, so a video downloaded
     * whole was fine and a video this app merged was not, which is why the
     * failures clustered on longer videos: those are the ones TikTok serves as
     * a separate video and audio track, so those are the ones that get merged.
     *
     * A player reading locally does not care. An uploader that parses the
     * beginning of the file to learn its duration and dimensions very much
     * does, and reports something unhelpfully generic when it cannot. The flag
     * costs one extra pass over a file ffmpeg has already written and no
     * quality whatsoever.
     */
    ...(options.formatId.includes('+')
      ? [
          '--merge-output-format',
          'mp4',
          '--postprocessor-args',
          // `Merger+ffmpeg_o` = the arguments ffmpeg receives before its output
          // file, and only when the Merger is what invoked it.
          'Merger+ffmpeg_o:-movflags +faststart',
        ]
      : []),
    '-o',
    toOutputTemplate(paths.workPath),
  ];

  if (options.subtitleLangs) {
    args.push(
      '--write-subs',
      // TikTok's own transcription lives under automatic captions for most
      // videos; asking only for uploaded ones would find almost nothing.
      '--write-auto-subs',
      '--sub-langs',
      options.subtitleLangs,
      // One format downstream instead of two. yt-dlp converts whatever TikTok
      // served, so the parser never has to guess.
      '--convert-subs',
      'srt',
      // A video with no captions at all is the common case and not an error.
      '--no-abort-on-error',
    );
  }

  args.push(...route);
  if (options.proxyUrl) args.push('--proxy', options.proxyUrl);
  args.push(options.url);

  let buffer = '';
  let printedPath: string | null = null;
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
        if (progress) {
          options.onProgress(progress);
          continue;
        }
        printedPath = parseOutputLine(line) ?? printedPath;
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
    // The work file is left in place: a partial from a network drop is a resume
    // point, exactly as with the direct downloader.
    throw new AppError(
      classified.code,
      result.stderr.trim().split('\n').pop() ?? `yt-dlp exited ${result.exitCode}`,
    );
  }

  const produced = locateProduced([
    paths.workPath,
    printedPath,
    paths.targetExisted ? null : options.targetPath,
  ]);

  if (!produced) {
    throw new AppError('DOWNLOAD_INCOMPLETE', 'yt-dlp reported success but wrote no file');
  }

  const bytes = statSync(produced).size;
  if (bytes === 0) {
    // Not a resume point, and leaving it would make the next attempt believe it
    // had one. Nothing of value is lost by removing zero bytes.
    rmSync(produced, { force: true });
    throw new AppError('DOWNLOAD_INCOMPLETE', 'yt-dlp wrote an empty file');
  }

  if (produced !== paths.partPath) {
    /**
     * Hands the file back to the pipeline's `.part` contract.
     *
     * A rename inside one directory, so it is atomic and costs nothing however
     * large the video. From here the file is indistinguishable from one the
     * direct downloader produced: verified while still a `.part`, and given its
     * final name only once it passes.
     */
    options.log?.debug({ produced, partPath: paths.partPath }, 'moving the yt-dlp output onto the .part path');
    renameSync(produced, paths.partPath);
  }

  options.onProgress({ bytesDone: bytes, bytesTotal: bytes, speed: null, etaMs: 0 });
  return { partPath: paths.partPath, bytes, resumedFrom };
}
