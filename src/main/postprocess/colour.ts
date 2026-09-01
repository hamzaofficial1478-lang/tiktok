import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { ProcessRunner } from '../resolve/process-runner';

/**
 * Auto colour correction — measured from the video, never assumed.
 *
 * The complaint this answers is that some downloads look dull and lifeless
 * while others are fine. That is a real difference in the source, not a fault
 * in the download: phone footage shot indoors or in overcast light comes off
 * the sensor flat, TikTok's encoder then throws away some of what little
 * contrast there was, and the result is a video that plays correctly and looks
 * like nothing.
 *
 * ## Why this measures first
 *
 * The obvious implementation is a fixed `eq=saturation=1.2:contrast=1.1` on
 * everything, and it is obviously wrong. Roughly half of TikTok is already
 * graded to within an inch of its life — heavy filters, crushed blacks, neon
 * skin — and adding 20% saturation to that produces the clipped, radioactive
 * look of a video that has been through three apps. The videos that need help
 * and the videos that would be ruined are in the same folder, and the only way
 * to tell them apart is to look.
 *
 * So a handful of frames are measured, and the correction is computed from
 * what is actually missing. A flat video gets a real lift. A video that is
 * already vivid gets nothing at all, and skips the re-encode with it.
 *
 * ## What it corrects, and what it will not
 *
 * Three things, all of them restorative rather than creative:
 *
 *   - **Tonal range.** When the darkest pixels are not dark and the brightest
 *     are not bright, the whole picture sits in a grey band. Stretching it back
 *     to the full range is the single biggest contributor to "dull" and the
 *     safest thing to fix.
 *   - **Saturation.** Only upward, only when low, and hard-capped. Colour that
 *     was never recorded cannot be invented; this recovers what compression
 *     flattened.
 *   - **A colour cast.** A wash of blue from a screen or orange from indoor
 *     light is neutralised gently, by nudging the channel balance back towards
 *     grey rather than by picking a target white point.
 *
 * It does not restyle. There is no teal-and-orange, no film emulation, no
 * curve that imposes a look — the brief was the video's own colours in their
 * corrected form, and anything else would be a different video. Every
 * adjustment is bounded so the worst case is a small change nobody objects to
 * rather than a large one somebody does.
 */

/** How many frames to measure. Enough to survive one odd shot, cheap to read. */
const SAMPLE_COUNT = 12;

export interface ColourStats {
  /** Mean luma, 0-255. */
  readonly luma: number;
  /** Where the darkest and brightest of the picture actually sit, 0-255. */
  readonly lumaLow: number;
  readonly lumaHigh: number;
  /** Mean distance of the colour channels from neutral, 0-128. */
  readonly saturation: number;
  /** Mean U and V, where 128 is neutral. Their drift is the colour cast. */
  readonly uMean: number;
  readonly vMean: number;
}

export interface ColourCorrection {
  /** The ffmpeg filter chain, or null when the video needs nothing. */
  readonly filter: string | null;
  /** What was found and what is being done about it, for the log. */
  readonly reason: string;
}

/**
 * The bounds, in one place, because every one of them is a judgement.
 *
 * They are deliberately timid. A correction that is slightly too small is
 * invisible; one that is slightly too large is the thing people mean when they
 * say a video looks "edited". These are set so that the worst case on a video
 * that did not need help is a change nobody would notice.
 */
const LIMITS = {
  /** Below this mean saturation, a video is flat enough to lift. */
  flatSaturation: 42,
  /** Never push saturation past this multiplier, whatever the measurement. */
  maxSaturation: 1.35,
  /** Nor contrast. */
  maxContrast: 1.25,
  /** A cast smaller than this is measurement noise, not a cast. */
  castThreshold: 3,
  /** And no more than this much of it is ever removed. */
  maxCastShift: 8,
  /** Ignore a range stretch that would change less than this, in 0-255 terms. */
  minRangeGain: 6,
} as const;

/**
 * Measures a video's colour by decoding a few frames to raw YUV.
 *
 * Reads the planes directly rather than parsing `signalstats` output: the
 * numbers wanted here are simple averages, the frames are tiny at this scale,
 * and a numeric answer computed here cannot be broken by ffmpeg rewording a
 * log line the way the extractor's error parsing can.
 */
export async function measureColour(
  filePath: string,
  options: { ffmpegPath: string; runner: ProcessRunner; signal?: AbortSignal | undefined; log?: Logger | undefined },
): Promise<ColourStats | null> {
  // 64x64 is far below any detail that matters and keeps the whole sample
  // under a megabyte, which is the point: this runs on every download.
  const width = 64;
  const height = 64;

  /**
   * Written to a file rather than read from stdout, and that is not a style
   * choice.
   *
   * The process runner decodes stdout as UTF-8, because every other thing it
   * runs produces text. Pixel data is not text: every byte above 0x7F would
   * come back as a replacement character, and the averages computed from it
   * would be confident nonsense — a correction applied to numbers that never
   * described the video. A temp file moves bytes as bytes.
   */
  const rawPath = join(
    tmpdir(),
    `tt-colour-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.yuv`,
  );

  const args = [
    '-v',
    'error',
    '-i',
    filePath,
    // Evenly spread across the video rather than the opening seconds, which on
    // TikTok are as likely to be a title card as the actual footage.
    '-vf',
    `thumbnail=n=25,scale=${width}:${height}`,
    '-frames:v',
    String(SAMPLE_COUNT),
    '-pix_fmt',
    'yuv444p',
    '-f',
    'rawvideo',
    '-y',
    rawPath,
  ];

  try {
    const result = await options.runner.run(options.ffmpegPath, args, {
      timeoutMs: 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.exitCode !== 0) {
      options.log?.debug({ stderr: result.stderr.slice(0, 200) }, 'colour sampling failed; the video is left alone');
      return null;
    }

    return readYuvStats(readFileSync(rawPath), width * height);
  } catch (err) {
    options.log?.debug({ err: String(err) }, 'could not measure colour; the video is left alone');
    return null;
  } finally {
    rmSync(rawPath, { force: true });
  }
}

/**
 * Averages the Y, U and V planes across every whole frame in the buffer.
 *
 * `yuv444p` so each plane is the same size and the arithmetic needs no
 * subsampling special cases — at 64x64 the memory saved by 4:2:0 would be
 * nothing and the code to handle it would be real.
 */
export function readYuvStats(raw: Buffer, pixelsPerPlane: number): ColourStats | null {
  const frameBytes = pixelsPerPlane * 3;
  const frames = Math.floor(raw.length / frameBytes);
  if (frames === 0) return null;

  let lumaSum = 0;
  let satSum = 0;
  let uSum = 0;
  let vSum = 0;
  const histogram = new Uint32Array(256);

  for (let f = 0; f < frames; f++) {
    const base = f * frameBytes;
    for (let i = 0; i < pixelsPerPlane; i++) {
      const y = raw[base + i] as number;
      const u = raw[base + pixelsPerPlane + i] as number;
      const v = raw[base + pixelsPerPlane * 2 + i] as number;

      lumaSum += y;
      histogram[y] = (histogram[y] as number) + 1;
      uSum += u;
      vSum += v;
      // Distance from neutral grey, which is what "how colourful" means here.
      satSum += Math.abs(u - 128) + Math.abs(v - 128);
    }
  }

  const total = frames * pixelsPerPlane;

  /**
   * The 1st and 99th percentiles rather than the true min and max.
   *
   * A single blown highlight or one black pixel in a corner would otherwise
   * report the range as already full and suppress the correction on a video
   * that plainly needs it. Percentiles describe where the picture actually
   * lives.
   */
  const percentile = (fraction: number): number => {
    let seen = 0;
    const target = total * fraction;
    for (let value = 0; value < 256; value++) {
      seen += histogram[value] as number;
      if (seen >= target) return value;
    }
    return 255;
  };

  return {
    luma: lumaSum / total,
    lumaLow: percentile(0.01),
    lumaHigh: percentile(0.99),
    saturation: satSum / total / 2,
    uMean: uSum / total,
    vMean: vSum / total,
  };
}

const round = (n: number): string => n.toFixed(3).replace(/\.?0+$/, '');

/**
 * Turns a measurement into a filter, or into nothing.
 *
 * Pure, so the judgement can be tested without ffmpeg — which matters, because
 * the judgement is the whole feature. Applying a correction is trivial;
 * deciding that a video does not need one is the part that keeps this from
 * ruining half the library.
 */
export function planColourCorrection(stats: ColourStats | null, strength = 1): ColourCorrection {
  if (!stats) return { filter: null, reason: 'colour could not be measured; left untouched' };

  const parts: string[] = [];
  const notes: string[] = [];

  /**
   * Tonal range: where the picture sits against where it could sit.
   *
   * Expressed through `eq`'s contrast and brightness rather than `curves`,
   * because the two are enough for a linear stretch and `eq` is in every
   * ffmpeg build including the minimal LGPL one this app installs.
   */
  const span = stats.lumaHigh - stats.lumaLow;
  if (span > 1 && 255 - span >= LIMITS.minRangeGain) {
    const gain = Math.min(LIMITS.maxContrast, 1 + ((255 - span) / 255) * strength);
    // Recentre so the stretch opens the shadows and highlights symmetrically
    // instead of dragging the whole image brighter.
    const midpoint = (stats.lumaLow + stats.lumaHigh) / 2;
    const shift = (((128 - midpoint) / 255) * strength) / 2;

    if (gain > 1.01) {
      parts.push(`contrast=${round(gain)}`);
      notes.push(`range ${Math.round(stats.lumaLow)}-${Math.round(stats.lumaHigh)} stretched`);
    }
    if (Math.abs(shift) > 0.01) parts.push(`brightness=${round(shift)}`);
  }

  /**
   * Saturation, upward only and only when there is room.
   *
   * A video that is already vivid is left completely alone. Adding to it is
   * how a download starts looking like it has been through three apps, and
   * that is a worse outcome than dullness because it cannot be undone.
   */
  if (stats.saturation < LIMITS.flatSaturation) {
    const deficit = (LIMITS.flatSaturation - stats.saturation) / LIMITS.flatSaturation;
    const factor = Math.min(LIMITS.maxSaturation, 1 + deficit * 0.5 * strength);
    if (factor > 1.01) {
      parts.push(`saturation=${round(factor)}`);
      notes.push(`saturation ${Math.round(stats.saturation)} lifted`);
    }
  }

  const eq = parts.length > 0 ? `eq=${parts.join(':')}` : null;

  /**
   * A colour cast, corrected towards neutral rather than towards a guess.
   *
   * `colorbalance` nudges the channels; the shift is a fraction of how far the
   * average chroma has drifted from neutral, capped, and only applied when the
   * drift is large enough to be a cast rather than the scene simply containing
   * a lot of sky or skin.
   */
  const uDrift = stats.uMean - 128;
  const vDrift = stats.vMean - 128;
  const casts: string[] = [];
  if (Math.abs(uDrift) > LIMITS.castThreshold) {
    // U carries blue-yellow: positive U is blue, so correct the other way.
    const amount = -clamp(uDrift, LIMITS.maxCastShift) / 128 / 2 / (1 / strength);
    if (Math.abs(amount) > 0.01) casts.push(`bm=${round(amount)}`);
  }
  if (Math.abs(vDrift) > LIMITS.castThreshold) {
    // V carries red-cyan.
    const amount = -clamp(vDrift, LIMITS.maxCastShift) / 128 / 2 / (1 / strength);
    if (Math.abs(amount) > 0.01) casts.push(`rm=${round(amount)}`);
  }
  const balance = casts.length > 0 ? `colorbalance=${casts.join(':')}` : null;
  if (balance) notes.push('colour cast neutralised');

  const filter = [eq, balance].filter(Boolean).join(',');

  return {
    filter: filter === '' ? null : filter,
    reason: notes.length > 0 ? notes.join(', ') : 'colour is already healthy; left untouched',
  };
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}
