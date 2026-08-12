import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from 'pino';
import type { ProcessRunner } from '../resolve/process-runner';
import { CANDIDATE_REGIONS } from './regions';
import { scoreRegionLuminance, type FrameSample } from './watermark-detector';
import { ANALYSIS_WINDOW_MS, type OutroSignals } from './outro-detector';

/**
 * Turns video into the plain numbers the detectors consume.
 *
 * This is the only part of post-processing that touches ffmpeg. Everything
 * downstream — segmentation, confidence, safety rails, filter graphs — works
 * on arrays of numbers and is therefore testable without a single media file.
 * The split is deliberate: the decisions that can silently ruin a user's video
 * are the ones that must be exhaustively tested, and they are all on the far
 * side of this boundary.
 *
 * Frames go to a temp file rather than through stdout, because ProcessRunner
 * decodes stdout as UTF-8 and would mangle raw pixel bytes.
 */

/** Analysis resolution. Small enough to be quick, large enough to see the mark. */
const SAMPLE_WIDTH = 270;
const SAMPLE_HEIGHT = 480;
const FRAME_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;

/** How many frames to sample across the video for watermark detection. */
export const WATERMARK_SAMPLE_COUNT = 24;
/** Frames per second sampled within the outro analysis window. */
const OUTRO_FPS = 2;
/** Mono PCM sample rate used for the audio RMS signal. */
const AUDIO_RATE = 8_000;

export interface SamplerOptions {
  readonly ffmpegPath: string | null;
  readonly runner: ProcessRunner;
  readonly log?: Logger;
  readonly signal?: AbortSignal;
}

function tempPath(suffix: string): string {
  return join(tmpdir(), `tt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

/** Reads one frame's worth of grayscale bytes out of a raw buffer. */
function frameAt(raw: Buffer, index: number): Uint8Array | null {
  const offset = index * FRAME_BYTES;
  if (offset + FRAME_BYTES > raw.length) return null;
  return new Uint8Array(raw.buffer, raw.byteOffset + offset, FRAME_BYTES);
}

/** Crops a region out of a full grayscale frame. */
function cropRegion(frame: Uint8Array, x: number, y: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const src = (y + row) * SAMPLE_WIDTH + x;
    out.set(frame.subarray(src, src + width), row * width);
  }
  return out;
}

/**
 * Samples frames across the whole video and scores each candidate region.
 *
 * Returns an empty array on any failure, which the detector reads as "cannot
 * be trusted" and answers with the static tier — the safe direction to fail in.
 */
export async function sampleWatermarkRegions(
  filePath: string,
  durationMs: number,
  options: SamplerOptions,
): Promise<FrameSample[]> {
  if (!options.ffmpegPath || durationMs <= 0) return [];

  const rawPath = tempPath('.gray');
  const seconds = durationMs / 1_000;
  const fps = Math.max(0.1, WATERMARK_SAMPLE_COUNT / seconds);

  try {
    const result = await options.runner.run(
      options.ffmpegPath,
      [
        '-v', 'error',
        '-i', filePath,
        '-vf', `fps=${fps.toFixed(4)},scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=gray`,
        '-frames:v', String(WATERMARK_SAMPLE_COUNT),
        '-f', 'rawvideo',
        '-y', rawPath,
      ],
      { timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (result.exitCode !== 0) {
      options.log?.debug({ stderr: result.stderr.slice(0, 200) }, 'watermark frame sampling failed');
      return [];
    }

    const raw = readFileSync(rawPath);
    const frames = Math.floor(raw.length / FRAME_BYTES);
    const samples: FrameSample[] = [];

    for (let i = 0; i < frames; i++) {
      const frame = frameAt(raw, i);
      if (!frame) break;

      const regionScores: Record<string, number> = {};
      for (const region of CANDIDATE_REGIONS) {
        const x = Math.max(0, Math.min(SAMPLE_WIDTH - 1, Math.round(region.x * SAMPLE_WIDTH)));
        const y = Math.max(0, Math.min(SAMPLE_HEIGHT - 1, Math.round(region.y * SAMPLE_HEIGHT)));
        const width = Math.max(1, Math.min(SAMPLE_WIDTH - x, Math.round(region.width * SAMPLE_WIDTH)));
        const height = Math.max(1, Math.min(SAMPLE_HEIGHT - y, Math.round(region.height * SAMPLE_HEIGHT)));
        regionScores[region.id] = scoreRegionLuminance(cropRegion(frame, x, y, width, height), width, height);
      }

      samples.push({ timeMs: (i / fps) * 1_000, regionScores });
    }

    return samples;
  } catch (err) {
    options.log?.debug({ err: String(err) }, 'watermark sampling threw; falling back to the static tier');
    return [];
  } finally {
    rmSync(rawPath, { force: true });
  }
}

/**
 * Measures the four outro signals over the final six seconds.
 *
 * Returns null when the measurements cannot be taken, which the detector reads
 * as "do not trim" — again the safe direction, since section 9 is explicit
 * that a missed outro is far better than a wrong cut.
 */
export async function sampleOutroSignals(
  filePath: string,
  durationMs: number,
  options: SamplerOptions,
): Promise<OutroSignals | null> {
  if (!options.ffmpegPath || durationMs <= 0) return null;

  const windowStartMs = Math.max(0, durationMs - ANALYSIS_WINDOW_MS);
  const startSeconds = windowStartMs / 1_000;
  const videoPath = tempPath('.gray');
  const audioPath = tempPath('.pcm');

  try {
    const [video, audio] = await Promise.all([
      options.runner.run(
        options.ffmpegPath,
        [
          '-v', 'error',
          '-ss', startSeconds.toFixed(3),
          '-i', filePath,
          '-vf', `fps=${OUTRO_FPS},scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=gray`,
          '-f', 'rawvideo',
          '-y', videoPath,
        ],
        { timeoutMs: 90_000, ...(options.signal ? { signal: options.signal } : {}) },
      ),
      options.runner.run(
        options.ffmpegPath,
        [
          '-v', 'error',
          '-ss', startSeconds.toFixed(3),
          '-i', filePath,
          '-vn', '-ac', '1', '-ar', String(AUDIO_RATE),
          '-f', 's16le',
          '-y', audioPath,
        ],
        { timeoutMs: 90_000, ...(options.signal ? { signal: options.signal } : {}) },
      ),
    ]);

    if (video.exitCode !== 0) {
      options.log?.debug({ stderr: video.stderr.slice(0, 200) }, 'outro frame sampling failed');
      return null;
    }

    const raw = readFileSync(videoPath);
    const frames = Math.floor(raw.length / FRAME_BYTES);
    if (frames < 2) return null;

    const sliceMs = 1_000 / OUTRO_FPS;
    const frameDeltas: number[] = [];
    const glyphScores: number[] = [];
    const colorUniformity: number[] = [];

    for (let i = 0; i < frames; i++) {
      const frame = frameAt(raw, i);
      if (!frame) break;

      // Difference from the previous frame; the first slice has no predecessor
      // so it is treated as fully changed rather than falsely static.
      const previous = i > 0 ? frameAt(raw, i - 1) : null;
      frameDeltas.push(previous ? meanAbsoluteDifference(frame, previous) : 1);

      // The end card carries the same glyph the watermark does, so the same
      // region scorer reads it.
      glyphScores.push(Math.max(...CANDIDATE_REGIONS.map((region) => {
        const x = Math.max(0, Math.round(region.x * SAMPLE_WIDTH));
        const y = Math.max(0, Math.round(region.y * SAMPLE_HEIGHT));
        const width = Math.max(1, Math.min(SAMPLE_WIDTH - x, Math.round(region.width * SAMPLE_WIDTH)));
        const height = Math.max(1, Math.min(SAMPLE_HEIGHT - y, Math.round(region.height * SAMPLE_HEIGHT)));
        return scoreRegionLuminance(cropRegion(frame, x, y, width, height), width, height);
      })));

      colorUniformity.push(dominantShare(frame));
    }

    const audioRms =
      audio.exitCode === 0 ? computeRms(readFileSync(audioPath), frameDeltas.length, sliceMs) : frameDeltas.map(() => 1);

    return { frameDeltas, audioRms, glyphScores, colorUniformity, sliceMs, windowStartMs };
  } catch (err) {
    options.log?.debug({ err: String(err) }, 'outro sampling threw; leaving the video untrimmed');
    return null;
  } finally {
    rmSync(videoPath, { force: true });
    rmSync(audioPath, { force: true });
  }
}

/** Mean absolute luminance difference, normalised 0-1. */
export function meanAbsoluteDifference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 1;
  let total = 0;
  for (let i = 0; i < length; i++) total += Math.abs((a[i] as number) - (b[i] as number));
  return total / length / 255;
}

/** Share of pixels falling in the most populated of 16 luminance buckets. */
export function dominantShare(frame: Uint8Array): number {
  if (frame.length === 0) return 0;
  const buckets = new Array<number>(16).fill(0);
  for (const value of frame) buckets[value >> 4] = (buckets[value >> 4] as number) + 1;
  return Math.max(...buckets) / frame.length;
}

/** Per-slice RMS of signed 16-bit mono PCM, normalised 0-1. */
export function computeRms(pcm: Buffer, slices: number, sliceMs: number): number[] {
  if (slices <= 0) return [];
  const samplesPerSlice = Math.max(1, Math.round((AUDIO_RATE * sliceMs) / 1_000));
  const out: number[] = [];

  for (let slice = 0; slice < slices; slice++) {
    const start = slice * samplesPerSlice * 2;
    let sum = 0;
    let count = 0;
    for (let i = start; i + 1 < pcm.length && count < samplesPerSlice; i += 2) {
      const value = pcm.readInt16LE(i) / 32_768;
      sum += value * value;
      count++;
    }
    // No audio for this slice reads as silence, which is one of four signals
    // and cannot on its own justify a cut.
    out.push(count === 0 ? 0 : Math.sqrt(sum / count));
  }

  return out;
}
