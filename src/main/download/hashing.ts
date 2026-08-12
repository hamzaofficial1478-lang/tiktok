import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from 'pino';
import type { ProcessRunner } from '../resolve/process-runner';

/**
 * Content hashing — spec section 9 step 11 and dedup layer 4.
 *
 * SHA-256 identifies a byte-identical file. The perceptual hash identifies the
 * same *content* re-encoded under a different aweme ID, which is what a repost
 * is. Section 7 requires the perceptual result to badge and never block,
 * because it has false positives — so every failure path here returns null
 * rather than throwing. A missing hash costs a badge; a thrown one would cost
 * the download.
 */

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface PerceptualHashOptions {
  readonly filePath: string;
  readonly ffmpegPath: string | null;
  readonly runner: ProcessRunner;
  readonly durationMs: number | null;
  readonly log?: Logger;
  readonly signal?: AbortSignal;
}

/** Section 7: "a perceptual hash over ~8 evenly sampled frames". */
const FRAME_COUNT = 8;
/** dHash compares each pixel with its right-hand neighbour, so width is size+1. */
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;
const FRAME_BYTES = HASH_WIDTH * HASH_HEIGHT;

/**
 * Computes a difference hash over evenly spaced frames.
 *
 * Frames go to a temp file rather than through stdout: the ProcessRunner
 * decodes stdout as UTF-8, which would mangle raw pixel bytes beyond use.
 */
export async function computePerceptualHash(options: PerceptualHashOptions): Promise<string | null> {
  const { ffmpegPath, durationMs } = options;
  if (!ffmpegPath) return null;

  const rawPath = join(tmpdir(), `phash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`);

  // Sampling rate that yields roughly FRAME_COUNT frames across the whole
  // video. Very short clips fall back to 1fps rather than a division by zero.
  const seconds = durationMs && durationMs > 0 ? durationMs / 1_000 : null;
  const fps = seconds && seconds > 0.5 ? Math.max(0.1, FRAME_COUNT / seconds) : 1;

  try {
    const result = await options.runner.run(
      ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        options.filePath,
        '-vf',
        `fps=${fps.toFixed(4)},scale=${HASH_WIDTH}:${HASH_HEIGHT},format=gray`,
        '-frames:v',
        String(FRAME_COUNT),
        '-f',
        'rawvideo',
        '-y',
        rawPath,
      ],
      { timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) },
    );

    if (result.exitCode !== 0) {
      options.log?.debug({ stderr: result.stderr.slice(0, 200) }, 'perceptual hash sampling failed');
      return null;
    }

    const pixels = readFileSync(rawPath);
    if (pixels.length < FRAME_BYTES) return null;

    const frames = Math.min(FRAME_COUNT, Math.floor(pixels.length / FRAME_BYTES));
    const bits: string[] = [];

    for (let frame = 0; frame < frames; frame++) {
      const offset = frame * FRAME_BYTES;
      let frameBits = 0n;
      for (let y = 0; y < HASH_HEIGHT; y++) {
        for (let x = 0; x < HASH_WIDTH - 1; x++) {
          const left = pixels[offset + y * HASH_WIDTH + x] as number;
          const right = pixels[offset + y * HASH_WIDTH + x + 1] as number;
          frameBits = (frameBits << 1n) | (left > right ? 1n : 0n);
        }
      }
      bits.push(frameBits.toString(16).padStart(16, '0'));
    }

    return bits.join('');
  } catch (err) {
    options.log?.debug({ err: String(err) }, 'perceptual hash failed; continuing without one');
    return null;
  } finally {
    rmSync(rawPath, { force: true });
  }
}

/**
 * Hamming distance between two perceptual hashes, as a fraction of the bits
 * compared. Lower means more similar. Returns null when the hashes are not
 * comparable (different lengths, i.e. different frame counts).
 */
export function perceptualDistance(a: string, b: string): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let differing = 0;
  let total = 0;
  for (let i = 0; i < a.length; i += 16) {
    const left = BigInt(`0x${a.slice(i, i + 16)}`);
    const right = BigInt(`0x${b.slice(i, i + 16)}`);
    let xor = left ^ right;
    while (xor > 0n) {
      differing += Number(xor & 1n);
      xor >>= 1n;
    }
    total += 64;
  }
  return total === 0 ? null : differing / total;
}
