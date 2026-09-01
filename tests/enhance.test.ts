import { describe, expect, it } from 'vitest';
import { applyQuality, parseBitrate, sharpenFilter } from '@main/postprocess/enhance';
import { SHARPEN_LEVELS } from '@shared/types';

/**
 * The two levers a re-uploaded video actually benefits from, and the limits of
 * both.
 *
 * Sharpening raises local contrast at edges. It adds no detail — the pixels are
 * the pixels — but it makes what survived TikTok's compression read as crisper
 * and gives the next platform's encoder better-defined edges to spend bits on.
 * Raising the quality target does not make this encode look better, since it is
 * already near-transparent; it makes the file survive being compressed again.
 *
 * Neither is upscaling, and nothing here pretends otherwise.
 */

describe('sharpening', () => {
  it('is nothing at all when off', () => {
    expect(sharpenFilter('off')).toBeNull();
  });

  it('produces a filter for every level that is not off', () => {
    for (const level of SHARPEN_LEVELS.filter((l) => l !== 'off')) {
      expect(sharpenFilter(level)).toMatch(/^unsharp=/);
    }
  });

  it('gets stronger in order, and stops somewhere sensible', () => {
    const amount = (level: 'light' | 'medium' | 'strong'): number =>
      Number((sharpenFilter(level) ?? '').split(':')[2]);

    expect(amount('light')).toBeLessThan(amount('medium'));
    expect(amount('medium')).toBeLessThan(amount('strong'));
    // Past about 1.5 the haloes are unmistakable, and a lossy source shows
    // them sooner. This is a video that cannot be un-sharpened afterwards.
    expect(amount('strong')).toBeLessThanOrEqual(1.5);
  });

  it('leaves chroma alone at every level', () => {
    // TikTok's chroma is subsampled and already the roughest part of the
    // picture; sharpening it amplifies blocking and improves nothing.
    for (const level of SHARPEN_LEVELS.filter((l) => l !== 'off')) {
      expect((sharpenFilter(level) ?? '').split(':')[5]).toBe('0.0');
    }
  });
});

describe('the quality step', () => {
  const NVENC = ['-preset', 'p6', '-rc', 'vbr', '-cq', '19', '-b:v', '0'];

  it('changes nothing at all on the balanced default', () => {
    expect(applyQuality(NVENC, 'balanced')).toEqual(NVENC);
  });

  it('lowers the quantiser as quality rises', () => {
    const cq = (args: readonly string[]): number => Number(args[args.indexOf('-cq') + 1]);

    expect(cq(applyQuality(NVENC, 'high'))).toBeLessThan(19);
    expect(cq(applyQuality(NVENC, 'maximum'))).toBeLessThan(cq(applyQuality(NVENC, 'high')));
  });

  it('never drives the quantiser somewhere pointless', () => {
    // Below about 10 the file grows and nothing visible changes.
    const args = applyQuality(['-cq', '12'], 'maximum');
    expect(Number(args[1])).toBeGreaterThanOrEqual(10);
  });

  it("leaves NVENC's -b:v 0 sentinel alone", () => {
    // It means "ignore this, the target is cq". Scaling it would turn a
    // sentinel into a real and very wrong bitrate.
    const args = applyQuality(NVENC, 'maximum');
    expect(args[args.indexOf('-b:v') + 1]).toBe('0');
  });

  it('buys quality with bitrate for an encoder that has no quality mode', () => {
    // openh264 has no CRF equivalent, so this is the only lever it has.
    const high = applyQuality(['-b:v', '10M'], 'high');
    const max = applyQuality(['-b:v', '10M'], 'maximum');

    expect(Number(high[1])).toBeGreaterThan(10_000_000);
    expect(Number(max[1])).toBeGreaterThan(Number(high[1]));
  });

  it('respects that VideoToolbox counts the other way', () => {
    // 1-100 and higher is better. Applying the quantiser direction here would
    // make "maximum quality" mean "as bad as possible".
    const args = applyQuality(['-q:v', '68'], 'maximum');
    expect(Number(args[1])).toBeGreaterThan(68);
    expect(Number(args[1])).toBeLessThanOrEqual(100);
  });

  it('respects that mpeg4 counts the usual way, on the same flag', () => {
    // 1-31, lower is better — the same flag name, the opposite meaning.
    const args = applyQuality(['-q:v', '2'], 'maximum');
    expect(Number(args[1])).toBeLessThanOrEqual(2);
    expect(Number(args[1])).toBeGreaterThanOrEqual(1);
  });

  it('passes through arguments it does not understand', () => {
    // An encoder added later keeps its own tuned defaults rather than being
    // handed a number that means something different on its scale.
    const args = applyQuality(['-preset', 'p6', '-tune', 'hq'], 'maximum');
    expect(args).toEqual(['-preset', 'p6', '-tune', 'hq']);
  });
});

describe('reading a bitrate', () => {
  it('understands the suffixes ffmpeg writes', () => {
    expect(parseBitrate('10M')).toBe(10_000_000);
    expect(parseBitrate('800k')).toBe(800_000);
    expect(parseBitrate('4500000')).toBe(4_500_000);
  });

  it('says so rather than guessing at something it cannot read', () => {
    expect(parseBitrate('fast')).toBeNull();
    expect(parseBitrate('')).toBeNull();
  });
});
