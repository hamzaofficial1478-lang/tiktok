import type { Box, WatermarkSegment } from './types';

/**
 * Builds the ffmpeg filter graph for watermark removal.
 *
 * Two things make this file worth reading carefully.
 *
 * **It is time-segmented.** Section 2: "TikTok's watermark alternates between
 * roughly two corner positions on a cycle of a few seconds. A single static
 * blur box will miss it half the time." So every filter instance is gated with
 * `enable='between(t,a,b)'` and only acts during the window its box is correct
 * for.
 *
 * **It is LGPL-only.** The brief names `delogo` and `boxblur`; both are gated
 * on `--enable-gpl` in ffmpeg's configure and are simply absent from the build
 * this product is allowed to ship. The replacements were checked to support
 * the timeline `enable` flag, which is the property the whole approach depends
 * on:
 *
 *     removelogo   interpolates from the region border, like delogo   (LGPL)
 *     gblur        gaussian blur, replaces boxblur                    (LGPL)
 *     overlay      composites the treated region back                 (LGPL)
 *
 * The generated strings cannot be validated without a real ffmpeg, so they are
 * unit-tested for structure here and exercised end to end by
 * `npm run probe:ffmpeg` on a machine that has the binaries.
 */

/** ffmpeg's expression syntax needs seconds, not milliseconds. */
function seconds(ms: number): string {
  return (ms / 1_000).toFixed(3);
}

/** `enable` expression restricting a filter to one segment. */
export function enableExpression(startMs: number, endMs: number): string {
  return `enable='between(t,${seconds(startMs)},${seconds(endMs)})'`;
}

/** ffmpeg filter arguments are comma/colon separated, so those need escaping. */
function escapePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/'/g, "\\'");
}

export interface RemovelogoSegment extends WatermarkSegment {
  /** Full-frame PGM mask marking this segment's region in white. */
  readonly maskPath: string;
}

/**
 * Tier 1 — chained `removelogo`, one instance per segment.
 *
 * `removelogo` takes a full-frame bitmap mask rather than a rectangle, so each
 * distinct watermark position needs its own mask file. Chaining the instances
 * with disjoint `enable` windows means only one is ever active at a time.
 */
export function buildRemovelogoGraph(segments: readonly RemovelogoSegment[]): string {
  if (segments.length === 0) return '';
  return segments
    .map((segment) => `removelogo=filename='${escapePath(segment.maskPath)}':${enableExpression(segment.startMs, segment.endMs)}`)
    .join(',');
}

export interface BlurOptions {
  /** Gaussian sigma. Higher is stronger; 12-20 covers a TikTok watermark. */
  readonly sigma?: number;
}

/**
 * Tier 2 — crop the region, blur it, composite it back, gated per segment.
 *
 * `gblur` on its own would blur the entire frame, so the region is isolated
 * with `crop` first and returned with `overlay`. The `enable` goes on the
 * overlay: crop and gblur run on a branch that is only composited during the
 * segment's window, so an untouched frame passes through the rest of the time.
 */
export function buildBlurGraph(segments: readonly WatermarkSegment[], options: BlurOptions = {}): string {
  if (segments.length === 0) return '';
  const sigma = options.sigma ?? 16;

  const parts: string[] = [];
  // One split output per segment, plus the base the overlays stack onto.
  parts.push(`[0:v]split=${segments.length + 1}${['[base]', ...segments.map((_, i) => `[src${i}]`)].join('')}`);

  segments.forEach((segment, index) => {
    const { x, y, width, height } = segment.box;
    parts.push(`[src${index}]crop=${width}:${height}:${x}:${y},gblur=sigma=${sigma}[blur${index}]`);
  });

  segments.forEach((segment, index) => {
    const input = index === 0 ? '[base]' : `[stage${index - 1}]`;
    const output = index === segments.length - 1 ? '[vout]' : `[stage${index}]`;
    const { x, y } = segment.box;
    parts.push(
      `${input}[blur${index}]overlay=${x}:${y}:${enableExpression(segment.startMs, segment.endMs)}${output}`,
    );
  });

  return parts.join(';');
}

/**
 * Tier 3 — blur every candidate region for the whole duration.
 *
 * Section 9: "if detection confidence is low, blur both candidate regions for
 * the entire duration. Crude but never misses." Used when the detector is not
 * confident enough to be trusted with timing, and the item is flagged so the
 * user knows a fallback was applied.
 */
export function buildStaticBlurGraph(regions: readonly Box[], options: BlurOptions = {}): string {
  if (regions.length === 0) return '';
  const sigma = options.sigma ?? 16;

  const parts: string[] = [];
  parts.push(`[0:v]split=${regions.length + 1}${['[base]', ...regions.map((_, i) => `[src${i}]`)].join('')}`);

  regions.forEach((region, index) => {
    parts.push(
      `[src${index}]crop=${region.width}:${region.height}:${region.x}:${region.y},gblur=sigma=${sigma}[blur${index}]`,
    );
  });

  regions.forEach((region, index) => {
    const input = index === 0 ? '[base]' : `[stage${index - 1}]`;
    const output = index === regions.length - 1 ? '[vout]' : `[stage${index}]`;
    parts.push(`${input}[blur${index}]overlay=${region.x}:${region.y}${output}`);
  });

  return parts.join(';');
}

/**
 * A binary PGM (P5) mask for `removelogo`: white marks the pixels to remove.
 *
 * The mask must match the video's dimensions exactly, which is why it is
 * generated per video rather than shipped as an asset.
 */
export function buildMaskPgm(width: number, height: number, boxes: readonly Box[]): Buffer {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  const pixels = Buffer.alloc(width * height, 0);

  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(width, Math.ceil(box.x + box.width));
    const y1 = Math.min(height, Math.ceil(box.y + box.height));
    for (let y = y0; y < y1; y++) {
      pixels.fill(255, y * width + x0, y * width + x1);
    }
  }

  return Buffer.concat([header, pixels]);
}

/**
 * removelogo interpolates from the pixels immediately outside the mask, so the
 * mask must not touch the frame edge or there is nothing to interpolate from.
 */
export function insetBoxFromEdges(box: Box, frameWidth: number, frameHeight: number, margin = 2): Box {
  const x = Math.min(Math.max(box.x, margin), Math.max(margin, frameWidth - margin - 1));
  const y = Math.min(Math.max(box.y, margin), Math.max(margin, frameHeight - margin - 1));
  const width = Math.max(1, Math.min(box.width, frameWidth - margin - x));
  const height = Math.max(1, Math.min(box.height, frameHeight - margin - y));
  return { x, y, width, height };
}
