import { describe, expect, it } from 'vitest';
import { planColourCorrection, readYuvStats, type ColourStats } from '@main/postprocess/colour';

/**
 * Auto colour correction, and the judgement that makes it safe to offer.
 *
 * Applying a correction is trivial. Deciding a video does not need one is the
 * whole feature: roughly half of TikTok is already graded to within an inch of
 * its life, and a fixed "add 20% saturation" would give all of it the clipped,
 * radioactive look of a video that has been through three apps. The videos
 * that need help and the videos that would be ruined sit in the same folder.
 */

const stats = (patch: Partial<ColourStats>): ColourStats => ({
  luma: 128,
  lumaLow: 0,
  lumaHigh: 255,
  saturation: 60,
  uMean: 128,
  vMean: 128,
  ...patch,
});

describe('deciding what a video needs', () => {
  it('leaves a healthy picture completely alone', () => {
    // Full tonal range, plenty of colour, no cast. Touching this can only make
    // it worse, and skipping it skips the re-encode too.
    const plan = planColourCorrection(stats({}));

    expect(plan.filter).toBeNull();
    expect(plan.reason).toMatch(/already healthy/i);
  });

  it('leaves a heavily graded video alone rather than pushing it further', () => {
    // The case a fixed lift would ruin: already saturated well past neutral.
    const plan = planColourCorrection(stats({ saturation: 95, lumaLow: 2, lumaHigh: 253 }));
    expect(plan.filter).toBeNull();
  });

  it('opens up a video whose picture sits in a grey band', () => {
    // Nothing dark, nothing bright — the single biggest cause of "dull".
    const plan = planColourCorrection(stats({ lumaLow: 60, lumaHigh: 190 }));

    expect(plan.filter).toMatch(/contrast=/);
    expect(plan.reason).toMatch(/range 60-190 stretched/);
  });

  it('lifts colour only when there is little of it', () => {
    const flat = planColourCorrection(stats({ saturation: 15 }));
    const vivid = planColourCorrection(stats({ saturation: 70 }));

    expect(flat.filter).toMatch(/saturation=/);
    expect(vivid.filter).toBeNull();
  });

  it('never lifts colour past the cap, however flat the source', () => {
    // Colour that was never recorded cannot be invented, and the failure mode
    // of trying is a video that looks broken rather than dull.
    const plan = planColourCorrection(stats({ saturation: 0 }), 3);
    const factor = Number(/saturation=([\d.]+)/.exec(plan.filter ?? '')?.[1]);

    expect(factor).toBeLessThanOrEqual(1.35);
  });

  it('never pushes contrast past its cap either', () => {
    const plan = planColourCorrection(stats({ lumaLow: 120, lumaHigh: 135 }), 3);
    const factor = Number(/contrast=([\d.]+)/.exec(plan.filter ?? '')?.[1]);

    expect(factor).toBeLessThanOrEqual(1.25);
  });

  it('neutralises a real colour cast', () => {
    // A blue wash from a screen, or orange from indoor light.
    const plan = planColourCorrection(stats({ uMean: 140 }));

    expect(plan.filter).toMatch(/colorbalance=/);
    expect(plan.reason).toMatch(/cast neutralised/i);
  });

  it('ignores a drift too small to be a cast', () => {
    // A scene with a lot of sky is not a fault to be corrected.
    expect(planColourCorrection(stats({ uMean: 130 })).filter).toBeNull();
  });

  it('corrects a cast towards neutral, not away from it', () => {
    // The sign is the entire correctness of this: getting it backwards makes a
    // blue video bluer, and would look like a deliberate style choice.
    const blue = planColourCorrection(stats({ uMean: 145 }));
    const amount = Number(/bm=(-?[\d.]+)/.exec(blue.filter ?? '')?.[1]);

    expect(amount).toBeLessThan(0);
  });

  it('does nothing at all when the measurement failed', () => {
    const plan = planColourCorrection(null);

    expect(plan.filter).toBeNull();
    expect(plan.reason).toMatch(/could not be measured/i);
  });

  it('goes further on strong than on auto, without leaving the caps', () => {
    const auto = planColourCorrection(stats({ saturation: 20, lumaLow: 50, lumaHigh: 200 }), 1);
    const strong = planColourCorrection(stats({ saturation: 20, lumaLow: 50, lumaHigh: 200 }), 1.6);

    const sat = (plan: { filter: string | null }): number =>
      Number(/saturation=([\d.]+)/.exec(plan.filter ?? '')?.[1] ?? '1');

    expect(sat(strong)).toBeGreaterThan(sat(auto));
    expect(sat(strong)).toBeLessThanOrEqual(1.35);
  });
});

describe('reading the picture out of raw frames', () => {
  /** One frame of flat YUV444 at the given values. */
  const frame = (y: number, u: number, v: number, pixels: number): Buffer =>
    Buffer.concat([Buffer.alloc(pixels, y), Buffer.alloc(pixels, u), Buffer.alloc(pixels, v)]);

  it('averages across every whole frame', () => {
    const raw = Buffer.concat([frame(100, 128, 128, 16), frame(140, 128, 128, 16)]);
    const measured = readYuvStats(raw, 16);

    expect(measured?.luma).toBe(120);
  });

  it('measures colourfulness as distance from neutral grey', () => {
    const grey = readYuvStats(frame(128, 128, 128, 16), 16);
    const colourful = readYuvStats(frame(128, 168, 88, 16), 16);

    expect(grey?.saturation).toBe(0);
    expect(colourful?.saturation).toBe(40);
  });

  it('ignores a trailing partial frame rather than reading past it', () => {
    const raw = Buffer.concat([frame(100, 128, 128, 16), Buffer.alloc(10)]);
    expect(readYuvStats(raw, 16)?.luma).toBe(100);
  });

  it('says so when there is not even one frame', () => {
    expect(readYuvStats(Buffer.alloc(5), 16)).toBeNull();
  });

  /**
   * The percentile, not the extreme.
   *
   * One blown highlight or a single black pixel in a corner would otherwise
   * report the range as already full and suppress the correction on a video
   * that plainly needs it.
   */
  it('describes where the picture lives, not its stray pixels', () => {
    const pixels = 1_000;
    const y = Buffer.alloc(pixels, 130);
    y[0] = 0;
    y[1] = 255;
    const raw = Buffer.concat([y, Buffer.alloc(pixels, 128), Buffer.alloc(pixels, 128)]);

    const measured = readYuvStats(raw, pixels);
    expect(measured?.lumaLow).toBe(130);
    expect(measured?.lumaHigh).toBe(130);
  });
});
