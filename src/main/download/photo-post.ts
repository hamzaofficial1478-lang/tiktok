import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from 'pino';
import type { ProcessRunner } from '../resolve/process-runner';
import { classifyYtDlpFailure } from '../resolve/yt-dlp-errors';
import { BROWSER_USER_AGENT } from '../resolve/yt-dlp-extractor';
import { toOutputTemplate } from './yt-dlp-downloader';

/**
 * Downloading a photo slideshow.
 *
 * A separate path from the video downloader, because almost nothing the video
 * path does applies. There is no stream to select — the post is N images and
 * usually a piece of music. There is nothing for ffprobe to verify, no
 * watermark to remove, no outro to trim, and no single file to hash. Trying to
 * squeeze it through the video pipeline would mean disabling most of that
 * pipeline with flags, which is a worse description of what is happening than
 * a function that says so.
 *
 * ## Why a folder rather than a file
 *
 * A slideshow is several files that only mean something together. Scattering
 * eight numbered images among a folder of videos loses that, and the eighth
 * post's third image sitting next to the third post's eighth is not a library
 * anyone can use. One folder per post keeps them as the thing they are, and
 * gives the ledger a single path to record.
 */

export interface PhotoPostDownloadOptions {
  readonly binaryPath: string | null;
  readonly runner: ProcessRunner;
  /** Canonical post URL — yt-dlp re-resolves, so it needs the page. */
  readonly url: string;
  /** Routes to try, best first, exactly as the video download does. */
  readonly routes?: readonly (readonly string[])[];
  /** The folder to create and fill. Named after the post, by the caller. */
  readonly directory: string;
  readonly signal: AbortSignal;
  readonly proxyUrl?: string | undefined;
  readonly timeoutMs?: number;
  readonly log?: Logger;
}

export interface PhotoPostResult {
  readonly directory: string;
  readonly files: readonly string[];
  readonly bytes: number;
}

/** Everything now in the folder, with its total size. */
function contentsOf(directory: string): { files: string[]; bytes: number } {
  if (!existsSync(directory)) return { files: [], bytes: 0 };
  const files: string[] = [];
  let bytes = 0;

  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    let size = 0;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      // Removed between the listing and the stat; not ours to worry about.
      continue;
    }
    files.push(path);
    bytes += size;
  }
  return { files, bytes };
}

export async function downloadPhotoPost(options: PhotoPostDownloadOptions): Promise<PhotoPostResult> {
  const binary = options.binaryPath;
  if (!binary) throw new AppError('EXTRACTOR_FAILED', 'yt-dlp is not installed');

  mkdirSync(options.directory, { recursive: true });
  const routes = options.routes && options.routes.length > 0 ? options.routes : [[]];
  let lastError: unknown;

  for (const [index, route] of routes.entries()) {
    try {
      return await attempt(options, binary, route);
    } catch (err) {
      lastError = err;
      const code = (err as { code?: string }).code;
      if (code !== 'EXTRACTOR_FAILED' && code !== 'CDN_FORBIDDEN') throw err;
      if (index < routes.length - 1) {
        options.log?.warn({ code, route: index }, 'slideshow route failed; trying the next one');
      }
    }
  }

  throw lastError;
}

async function attempt(
  options: PhotoPostDownloadOptions,
  binary: string,
  route: readonly string[],
): Promise<PhotoPostResult> {
  const args = [
    '--no-warnings',
    '--no-mtime',
    /**
     * The one place `--no-playlist` must NOT be sent.
     *
     * yt-dlp models a slideshow as a playlist of its images, so the flag the
     * video path relies on to avoid pulling a whole account would here fetch
     * exactly one picture out of eight and call it done.
     */
    '--yes-playlist',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--socket-timeout',
    '20',
    '--user-agent',
    BROWSER_USER_AGENT,
    '-o',
    // Numbered by their order in the post, so the folder reads in the order
    // the images were meant to be seen.
    toOutputTemplate(join(options.directory, '%(playlist_index)03d-%(id)s.%(ext)s')),
    ...route,
  ];

  if (options.proxyUrl) args.push('--proxy', options.proxyUrl);
  args.push(options.url);

  const result = await options.runner.run(binary, args, {
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    signal: options.signal,
  });

  if (options.signal.aborted) throw new AppError('CANCELLED', 'download cancelled');

  const produced = contentsOf(options.directory);

  if (result.exitCode !== 0) {
    /**
     * A partial slideshow is still a result worth keeping.
     *
     * yt-dlp exits non-zero if any one image fails, and losing seven pictures
     * because the eighth 404'd would be a poor trade. The failure is logged
     * either way, so a short folder is explicable rather than mysterious.
     */
    if (produced.files.length > 0) {
      options.log?.warn(
        { exitCode: result.exitCode, files: produced.files.length, stderr: result.stderr.slice(0, 400) },
        'some of the slideshow could not be downloaded; keeping what arrived',
      );
      return { directory: options.directory, files: produced.files, bytes: produced.bytes };
    }

    const classified = classifyYtDlpFailure(result);
    throw new AppError(classified.code, result.stderr.trim().split('\n').pop() ?? `yt-dlp exited ${result.exitCode}`);
  }

  if (produced.files.length === 0) {
    throw new AppError('DOWNLOAD_INCOMPLETE', 'yt-dlp reported success but the slideshow folder is empty');
  }

  return { directory: options.directory, files: produced.files, bytes: produced.bytes };
}
