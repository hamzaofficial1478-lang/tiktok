import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';
import { AppError } from '@shared/errors';
import { assertEnoughSpace } from './disk-space';

/**
 * Streaming download — spec section 9 steps 5-6, and section 8's `.part` rule:
 * "Partial downloads write to {target}.part and are atomically renamed on
 * success. Never leave a half-written file with the final name."
 *
 * That rule is the reason this module exists as its own unit rather than a few
 * lines inside the pipeline. Every exit path — success, failure, cancellation,
 * a killed process — has to leave the filesystem in one of exactly two states:
 * a complete file under its final name, or a `.part` alongside nothing. A user
 * who finds a 3MB truncated MP4 in their output folder concludes the product
 * is broken, and they are right to.
 */

export interface DownloadProgress {
  readonly bytesDone: number;
  readonly bytesTotal: number | null;
  readonly speed: number | null;
  readonly etaMs: number | null;
}

export interface DownloadOptions {
  readonly url: string;
  /** Final destination. The `.part` file is derived from it. */
  readonly targetPath: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: DownloadProgress) => void;
  readonly expectedBytes?: number | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  /** Skip the free-space precheck (used when the caller already did one). */
  readonly skipSpaceCheck?: boolean;
  /**
   * Permit loopback and private addresses. Off in production: a stream URL
   * pointing at the user's own machine means something has gone wrong or is
   * being manipulated. Set only by tests serving fixtures from 127.0.0.1.
   */
  readonly allowPrivateHosts?: boolean;
  readonly now?: () => number;
}

export interface DownloadOutcome {
  readonly partPath: string;
  readonly bytes: number;
  /** Non-zero when an interrupted download was continued rather than restarted. */
  readonly resumedFrom: number;
}

export function partPathFor(targetPath: string): string {
  return `${targetPath}.part`;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function downloadToPart(options: DownloadOptions): Promise<DownloadOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const partPath = partPathFor(options.targetPath);
  mkdirSync(dirname(options.targetPath), { recursive: true });

  // A `.part` left by a crash is a resume point (section 8). One left by a
  // cancellation was already deleted, so anything here is genuinely resumable.
  const existingBytes = existsSync(partPath) ? statSync(partPath).size : 0;

  if (!options.skipSpaceCheck && options.expectedBytes) {
    assertEnoughSpace(dirname(options.targetPath), Math.max(0, options.expectedBytes - existingBytes));
  }

  assertFetchableUrl(options.url, options.allowPrivateHosts ?? false);

  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: '*/*',
    ...options.headers,
  };
  if (existingBytes > 0) headers['range'] = `bytes=${existingBytes}-`;

  let response: Response;
  try {
    response = await fetchImpl(options.url, { headers, signal: options.signal, redirect: 'follow' });
  } catch (err) {
    if (options.signal.aborted) throw new AppError('CANCELLED', 'download cancelled');
    throw new AppError('NETWORK_ERROR', `could not start the download: ${describe(err)}`, { cause: err });
  }

  if (response.status === 416) {
    // The range is past the end: the `.part` is at least as large as the
    // remote file and cannot be trusted. Start over rather than splice.
    rmSync(partPath, { force: true });
    return downloadToPart({ ...options, skipSpaceCheck: true });
  }

  if (!response.ok) throw statusToError(response.status, options.url);
  if (!response.body) throw new AppError('NETWORK_ERROR', 'the server returned no response body');

  /**
   * A server that ignores Range answers 200 with the whole file. Appending
   * that to an existing `.part` would silently produce a corrupt file, so the
   * partial is discarded and the transfer restarts from zero.
   */
  const isResuming = existingBytes > 0 && response.status === 206;
  if (existingBytes > 0 && !isResuming) rmSync(partPath, { force: true });
  const startBytes = isResuming ? existingBytes : 0;

  const contentLength = Number(response.headers.get('content-length') ?? '');
  const bytesTotal = Number.isFinite(contentLength)
    ? contentLength + startBytes
    : (options.expectedBytes ?? null);

  const sink = createWriteStream(partPath, isResuming ? { flags: 'a' } : { flags: 'w' });
  let bytesDone = startBytes;
  const startedAt = now();
  let lastReport = 0;

  try {
    await pipeToFile(response.body, sink, (chunkSize) => {
      bytesDone += chunkSize;
      const elapsed = now() - startedAt;
      // Reporting is cheap but not free; the engine throttles for the UI, this
      // just avoids computing a speed on every 16KB chunk.
      if (elapsed - lastReport < 100 && bytesDone !== bytesTotal) return;
      lastReport = elapsed;

      const transferred = bytesDone - startBytes;
      const speed = elapsed > 0 ? (transferred / elapsed) * 1_000 : null;
      const remaining = bytesTotal === null ? null : Math.max(0, bytesTotal - bytesDone);
      options.onProgress({
        bytesDone,
        bytesTotal,
        speed,
        etaMs: speed && speed > 0 && remaining !== null ? Math.round((remaining / speed) * 1_000) : null,
      });
    });
  } catch (err) {
    if (options.signal.aborted) {
      // Cancellation is explicit: section 8 requires the `.part` to go, so a
      // cancelled item leaves nothing behind at all.
      rmSync(partPath, { force: true });
      throw new AppError('CANCELLED', 'download cancelled');
    }
    // Any other interruption keeps the `.part` so the retry can resume it.
    throw new AppError('DOWNLOAD_INCOMPLETE', `the transfer stopped early: ${describe(err)}`, { cause: err });
  }

  const finalSize = existsSync(partPath) ? statSync(partPath).size : 0;
  if (finalSize === 0) {
    rmSync(partPath, { force: true });
    throw new AppError('DOWNLOAD_INCOMPLETE', 'the server returned an empty file');
  }

  if (bytesTotal !== null && finalSize < bytesTotal) {
    throw new AppError(
      'DOWNLOAD_INCOMPLETE',
      `expected ${bytesTotal} bytes but received ${finalSize}; the partial file was kept for resume`,
    );
  }

  options.onProgress({ bytesDone: finalSize, bytesTotal: bytesTotal ?? finalSize, speed: null, etaMs: 0 });
  return { partPath, bytes: finalSize, resumedFrom: startBytes };
}

/**
 * Moves a verified `.part` to its final name.
 *
 * Called only after verification, which is precisely what makes the guarantee
 * hold: the final name never exists until the bytes behind it are known good.
 */
export function commitPart(partPath: string, targetPath: string): void {
  if (!existsSync(partPath)) throw new AppError('DOWNLOAD_INCOMPLETE', `${partPath} disappeared before it was saved`);
  mkdirSync(dirname(targetPath), { recursive: true });
  try {
    renameSync(partPath, targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError('PERMISSION_DENIED', `cannot write to ${targetPath}`, { cause: err });
    }
    throw new AppError('DOWNLOAD_INCOMPLETE', `could not save ${targetPath}: ${describe(err)}`, { cause: err });
  }
}

export function discardPart(targetPath: string): void {
  rmSync(partPathFor(targetPath), { force: true });
}

/**
 * Streams a web ReadableStream into a Node writable, respecting backpressure.
 *
 * Written by hand rather than with `Readable.fromWeb().pipe()` so the chunk
 * callback sees byte counts as they land, which is what makes the speed and
 * ETA figures reflect the transfer rather than the read buffer.
 */
async function pipeToFile(
  body: ReadableStream<Uint8Array>,
  sink: Writable,
  onChunk: (size: number) => void,
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      onChunk(value.byteLength);
      if (!sink.write(value)) {
        await new Promise<void>((resolve, reject) => {
          sink.once('drain', resolve);
          sink.once('error', reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end(() => resolve());
      sink.once('error', reject);
    });
  } catch (err) {
    sink.destroy();
    throw err;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Loopback and link-local addresses, in the forms a URL can actually carry.
 * 169.254.169.254 is the cloud metadata endpoint and the classic SSRF target.
 */
const BLOCKED_HOST = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[?::1\]?|169\.254\.\d+\.\d+|.*\.local)$/i;
const PRIVATE_IPV4 = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/**
 * Refuses to fetch anything that is not a public web URL.
 *
 * The stream URL is not user input, but it is not ours either: it arrives from
 * whatever the extractor parsed out of a remote response. Treating it as
 * trusted means a manipulated or malformed response could point this function
 * at the local filesystem, at a service on the user's own machine, or at a
 * cloud metadata endpoint — and the result would be written to disk and
 * presented as a downloaded video. Checking the scheme and host costs nothing
 * and removes the whole category.
 */
export function assertFetchableUrl(rawUrl: string, allowPrivateHosts = false): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('DOWNLOAD_INCOMPLETE', `the extractor returned a URL that cannot be parsed: ${rawUrl}`);
  }

  // The scheme rule is absolute. No caller, in any environment, has a
  // legitimate reason to stream a video out of file:, data: or ftp:.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('DOWNLOAD_INCOMPLETE', `refusing to download from a "${url.protocol}" URL`);
  }

  // The private-address rule defaults on and is opted out of explicitly, by
  // exactly one caller: the test suite, which serves fixtures from 127.0.0.1.
  // Making it a parameter rather than deleting the check keeps production
  // secure by default and makes every exception visible at its call site.
  if (allowPrivateHosts) return;

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host) || PRIVATE_IPV4.test(host)) {
    throw new AppError('DOWNLOAD_INCOMPLETE', `refusing to download from the private address ${host}`);
  }
}

function statusToError(status: number, url: string): AppError {
  if (status === 403) {
    /**
     * A 403 on a CDN stream URL is not proof of a geo-block, and saying so cost
     * days of chasing the wrong cause. TikTok signs these URLs and checks the
     * Referer, User-Agent and session cookie from extraction; a request missing
     * them is refused exactly the same way a blocked region is. The URLs also
     * expire, so a stale one 403s too. The message names all three rather than
     * asserting the one the taxonomy code is named after.
     */
    return new AppError(
      'REGION_BLOCKED',
      `the CDN refused the download with 403. The link may have expired, or TikTok may not serve it from this ` +
        `location. URL: ${url.slice(0, 120)}`,
    );
  }
  if (status === 404 || status === 410) return new AppError('VIDEO_DELETED', `${url} returned ${status}`);
  if (status === 429) return new AppError('RATE_LIMITED', `${url} returned 429`);
  if (status >= 500) return new AppError('NETWORK_ERROR', `${url} returned ${status}`);
  return new AppError('DOWNLOAD_INCOMPLETE', `${url} returned ${status}`);
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
