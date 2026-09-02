import type { SharpenLevel, EncodeQuality } from '@shared/types';

/**
 * Making a re-uploaded video look like it was worth watching.
 *
 * Two levers, and it is worth being exact about what each one can and cannot
 * do, because the category is full of software promising the impossible.
 *
 * ## Sharpening
 *
 * `unsharp` raises local contrast at edges. It does not add detail — there is
 * no detail to add, the pixels are the pixels — but it makes the detail that
 * survived TikTok's compression read as crisper, which is what the eye scores
 * as "sharper". It is the same operation every photo editor calls Sharpen and
 * every camera applies by default.
 *
 * It is genuinely useful here for one specific reason: a video downloaded from
 * TikTok and uploaded again is compressed twice, and the second compressor
 * spends its bits on whatever has contrast. Going in slightly sharpened is
 * going in with the edges better defended.
 *
 * Overdone it is unmistakable and ugly — haloes around every edge, mosquito
 * noise in the flat areas — and it cannot be undone afterwards. Hence three
 * conservative steps rather than a slider that goes to eleven. `strong` is
 * about as far as anyone should take a video that is already lossy.
 *
 * ## Bitrate
 *
 * The encoder is quality-targeted rather than bitrate-targeted, which is the
 * right way round: it spends what each frame needs. Raising the target lowers
 * the quantiser, which means finer detail survives the encode and, more to the
 * point, survives the *next* encode when a platform re-compresses the upload.
 *
 * The file gets bigger and nothing else changes. On a video being kept and
 * re-uploaded that is a good trade, and it is the reason `maximum` exists.
 *
 * ## What neither of these is
 *
 * Upscaling. Rendering 1080p at 4K produces a file four times the size that
 * looks identical at best, and no amount of sharpening changes that — the
 * detail is not in the source. Real upscaling needs a trained model, which is
 * a different program with a different budget. Saying so is more useful than
 * shipping a checkbox that quietly wastes an hour per video.
 */

/**
 * `unsharp=lx:ly:la:cx:cy:ca` — luma matrix size, luma amount, and the same
 * for chroma.
 *
 * Chroma is deliberately left alone at every level. TikTok's chroma is
 * subsampled and already the roughest part of the picture; sharpening it
 * amplifies blocking without making anything look better.
 *
 * A 5x5 matrix rather than the 3x3 default: on a 1080-wide frame 3x3 acts on
 * such a small neighbourhood that it emphasises compression noise as readily
 * as edges.
 */
const UNSHARP: Record<Exclude<SharpenLevel, 'off'>, string> = {
  light: 'unsharp=5:5:0.5:5:5:0.0',
  medium: 'unsharp=5:5:0.9:5:5:0.0',
  strong: 'unsharp=5:5:1.4:5:5:0.0',
};

/** The filter chain for a sharpening level, or null when there is nothing to do. */
export function sharpenFilter(level: SharpenLevel): string | null {
  return level === 'off' ? null : UNSHARP[level];
}

/**
 * How far each quality step moves the encoder's target.
 *
 * Expressed as an offset rather than absolute numbers because the scales are
 * not comparable across encoders — NVENC's `cq`, QuickSync's `global_quality`
 * and AMF's `qp` are different quantities with different useful ranges, and a
 * single table of absolutes would be wrong for most of them. An offset applied
 * to each encoder's own tuned default keeps the relationship intact.
 *
 * Lower is better on every scale here except VideoToolbox's, which runs the
 * other way and is handled where it is applied.
 */
const QUALITY_OFFSET: Record<EncodeQuality, number> = {
  // The existing near-transparent target: not meaningfully distinguishable
  // from its input, at roughly 40% over the source size.
  balanced: 0,
  // Visually lossless for practical purposes; noticeably larger files.
  high: -3,
  // Past the point of visible return on its own, and not pointless: the bits
  // are there to survive the platform's re-encode, not this one.
  maximum: -6,
};

/**
 * Applies a quality step to an encoder's own arguments.
 *
 * Only the numeric quality argument is touched, and only for flags this knows
 * the direction of. Anything else is passed through, so an encoder added later
 * keeps its tuned defaults rather than silently getting a number that means
 * something different on its scale.
 */
export function applyQuality(args: readonly string[], quality: EncodeQuality): string[] {
  const offset = QUALITY_OFFSET[quality];
  if (offset === 0) return [...args];

  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    const flag = out[i] as string;
    const raw = out[i + 1] as string;

    /**
     * openh264 has no quality mode at all, so quality has to be bought with
     * bitrate — and its value carries a unit, `10M`, which is why this is
     * handled before anything tries `Number()` on it.
     *
     * `-b:v 0` is NVENC's way of saying "ignore this, the target is `cq`", and
     * scaling it would turn that sentinel into a real and very wrong bitrate.
     */
    if (flag === '-b:v') {
      if (raw === '0') continue;
      const bits = parseBitrate(raw);
      if (bits === null) continue;
      out[i + 1] = String(Math.round(bits * (quality === 'maximum' ? 1.8 : 1.4)));
      continue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) continue;

    // Quantiser-style: lower is better. Floored at 10, below which the file
    // grows without anything visible changing.
    if (['-cq', '-global_quality', '-qp', '-qp_i', '-qp_p', '-crf'].includes(flag)) {
      out[i + 1] = String(Math.max(10, value + offset));
      continue;
    }

    if (flag === '-q:v') {
      // Told apart by the range the value lives in, because `-q:v` means
      // opposite things to different encoders: VideoToolbox is 1-100 and
      // higher is better, while the 1-31 scales are lower-is-better. Applying
      // one direction to the other would make "maximum quality" mean "as bad
      // as possible".
      out[i + 1] =
        value > 31 ? String(Math.min(100, value - offset * 2)) : String(Math.max(1, value + Math.round(offset / 3)));
    }
  }
  return out;
}

/** `-b:v 10M` and friends, as a number of bits per second. */
export function parseBitrate(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  return Math.round(amount * scale);
}
