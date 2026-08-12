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

function statusToError(status: number, url: string): AppError {
  if (status === 403) return new AppError('REGION_BLOCKED', `${url} returned 403`);
  if (status === 404 || status === 410) return new AppError('VIDEO_DELETED', `${url} returned ${status}`);
  if (status === 429) return new AppError('RATE_LIMITED', `${url} returned 429`);
  if (status >= 500) return new AppError('NETWORK_ERROR', `${url} returned ${status}`);
  return new AppError('DOWNLOAD_INCOMPLETE', `${url} returned ${status}`);
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
