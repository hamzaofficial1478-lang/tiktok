import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_WINDOW_MS,
  CONFIDENCE_THRESHOLD,
  MAX_TRIM_MS,
  MAX_TRIM_RATIO,
  MIN_VIDEO_DURATION_MS,
  applySafetyRails,
  detectOutro,
  planTrim,
  scoreOutro,
  type OutroSignals,
} from '@main/postprocess/outro-detector';
import {
  buildBlurGraph,
  buildMaskPgm,
  buildRemovelogoGraph,
  buildStaticBlurGraph,
  enableExpression,
  insetBoxFromEdges,
} from '@main/postprocess/filter-graph';
import { FORBIDDEN_ENCODERS, estimateProcessingMs, selectEncoder } from '@main/postprocess/encoder';
import {
  PRESENCE_THRESHOLD,
  buildSegments,
  detectWatermark,
  scoreRegionLuminance,
  type FrameSample,
} from '@main/postprocess/watermark-detector';
import { CANDIDATE_REGIONS, toPixelBox } from '@main/postprocess/regions';
import type { MediaCapabilities } from '@shared/ipc/contract';

/* ------------------------------------------------------------------ *
 * Outro safety rails
 * ------------------------------------------------------------------ */

describe('outro safety rails (section 9: non-negotiable)', () => {
  it('never trims a video shorter than 8 seconds', () => {
    const check = applySafetyRails(1_000, 7_999);
    expect(check.allowed).toBe(false);
    expect(check.blockedBy).toBe('too-short');
  });

  it('never trims more than 5 seconds', () => {
    expect(applySafetyRails(MAX_TRIM_MS, 60_000).allowed).toBe(true);
    const check = applySafetyRails(MAX_TRIM_MS + 1, 60_000);
    expect(check.allowed).toBe(false);
    expect(check.blockedBy).toBe('too-long');
  });

  it('never trims more than 15% of the duration', () => {
    // 3s of a 20s video is 15% exactly — allowed.
    expect(applySafetyRails(3_000, 20_000).allowed).toBe(true);
    const check = applySafetyRails(3_001, 20_000);
    expect(check.allowed).toBe(false);
    expect(check.blockedBy).toBe('too-large-a-share');
  });

  it('applies the strictest rail when several would bite', () => {
    // 4s of a 10s video: under the 5s cap but 40% of the video.
    expect(applySafetyRails(4_000, 10_000).blockedBy).toBe('too-large-a-share');
  });

  it('holds for every duration and trim combination', () => {
    for (let durationMs = 1_000; durationMs <= 120_000; durationMs += 3_500) {
      for (let trim = 0; trim <= 12_000; trim += 700) {
        const check = applySafetyRails(trim, durationMs);
        if (!check.allowed) continue;
        // Whatever passes must satisfy all three rails simultaneously.
        expect(durationMs, `duration ${durationMs}`).toBeGreaterThanOrEqual(MIN_VIDEO_DURATION_MS);
        expect(trim, `trim ${trim}`).toBeLessThanOrEqual(MAX_TRIM_MS);
        expect(trim / durationMs, `ratio for ${trim}/${durationMs}`).toBeLessThanOrEqual(MAX_TRIM_RATIO);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Outro scoring
 * ------------------------------------------------------------------ */

function signals(overrides: Partial<OutroSignals> = {}): OutroSignals {
  const slices = 6;
  return {
    frameDeltas: Array.from({ length: slices }, () => 0.5),
    audioRms: Array.from({ length: slices }, () => 0.5),
    glyphScores: Array.from({ length: slices }, () => 0),
    colorUniformity: Array.from({ length: slices }, () => 0.2),
    sliceMs: 1_000,
    windowStartMs: 24_000,
    ...overrides,
  };
}

/** A convincing outro: still, silent, branded, flat — in the last 2 slices. */
function outroTail(slices = 6, tail = 2): Partial<OutroSignals> {
  const at = (i: number, outro: number, normal: number): number => (i >= slices - tail ? outro : normal);
  return {
    frameDeltas: Array.from({ length: slices }, (_, i) => at(i, 0.001, 0.4)),
    audioRms: Array.from({ length: slices }, (_, i) => at(i, 0.001, 0.4)),
    glyphScores: Array.from({ length: slices }, (_, i) => at(i, 0.95, 0.02)),
    colorUniformity: Array.from({ length: slices }, (_, i) => at(i, 0.95, 0.1)),
  };
}

describe('outro scoring', () => {
  it('finds a clear branded end card', () => {
    const score = scoreOutro(signals(outroTail()));
    expect(score.confidence).toBeGreaterThan(CONFIDENCE_THRESHOLD);
    // Window starts at 24s, 6 slices of 1s, outro in the last 2 -> cut at 28s.
    expect(score.cutAtMs).toBe(28_000);
  });

  it('ignores a still, quiet moment in the middle of the video', () => {
    // Everything an outro has except the glyph, and not at the end.
    const midVideo = signals({
      frameDeltas: [0.4, 0.001, 0.001, 0.4, 0.4, 0.4],
      audioRms: [0.4, 0.001, 0.001, 0.4, 0.4, 0.4],
      colorUniformity: [0.1, 0.9, 0.9, 0.1, 0.1, 0.1],
    });
    expect(scoreOutro(midVideo).cutAtMs).toBeNull();
  });

  it('does not trim on the ambient signals alone', () => {
    // A held final frame with silence is a legitimate ending, not an outro.
    const heldFrame = signals({
      frameDeltas: [0.4, 0.4, 0.4, 0.001, 0.001, 0.001],
      audioRms: [0.4, 0.4, 0.4, 0.001, 0.001, 0.001],
      colorUniformity: [0.1, 0.1, 0.1, 0.9, 0.9, 0.9],
      glyphScores: [0, 0, 0, 0, 0, 0],
    });
    const score = scoreOutro(heldFrame);
    // Without the TikTok glyph the weights cannot reach the threshold.
    expect(score.cutAtMs).toBeNull();
    expect(score.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('returns nothing for an empty window', () => {
    expect(scoreOutro(signals({ frameDeltas: [], audioRms: [], glyphScores: [], colorUniformity: [] })).cutAtMs).toBeNull();
  });
});

describe('outro decision', () => {
  it('trims a confident outro within the rails', () => {
    const decision = detectOutro({ signals: signals(outroTail()), durationMs: 30_000 });
    expect(decision.trim).toBe(true);
    expect(decision.cutAtMs).toBe(28_000);
    expect(decision.trimmedMs).toBe(2_000);
    expect(decision.blockedBy).toBeNull();
  });

  it('refuses on a short video even when the score is perfect', () => {
    const decision = detectOutro({ signals: signals(outroTail()), durationMs: 7_000 });
    expect(decision.trim).toBe(false);
    expect(decision.blockedBy).toBe('too-short');
    expect(decision.trimmedMs).toBe(0);
  });

  it('refuses when the proposed cut is too large a share', () => {
    // A 10s video with 4 outro slices: confident, but 40% of the runtime.
    const decision = detectOutro({
      signals: { ...signals(outroTail(6, 4)), windowStartMs: 4_000 },
      durationMs: 10_000,
    });
    expect(decision.trim).toBe(false);
    expect(decision.blockedBy).toBe('too-large-a-share');
  });

  it('refuses a low-confidence detection', () => {
    const decision = detectOutro({ signals: signals(), durationMs: 30_000 });
    expect(decision.trim).toBe(false);
    expect(decision.blockedBy).toBe('low-confidence');
  });

  it('never reports a trim without a cut point', () => {
    for (const durationMs of [5_000, 9_000, 30_000, 300_000]) {
      const decision = detectOutro({ signals: signals(outroTail()), durationMs });
      if (decision.trim) expect(decision.cutAtMs, `duration ${durationMs}`).not.toBeNull();
      else expect(decision.trimmedMs, `duration ${durationMs}`).toBe(0);
    }
  });

  it('analyses only the tail window the spec defines', () => {
    expect(ANALYSIS_WINDOW_MS).toBe(6_000);
  });
});

describe('trim planning', () => {
  it('stream-copies when a keyframe is within 250ms of the cut', () => {
    const plan = planTrim(28_000, [0, 10_000, 20_000, 27_900], false);
    expect(plan.mode).toBe('stream-copy');
    expect(plan.cutAtMs).toBe(27_900);
  });

  it('re-encodes for a frame-accurate cut only when already re-encoding', () => {
    const plan = planTrim(28_000, [0, 10_000, 20_000], true);
    expect(plan.mode).toBe('re-encode');
    expect(plan.cutAtMs).toBe(28_000);
  });

  it('trims slightly less rather than re-encoding a file that does not need it', () => {
    const plan = planTrim(28_000, [0, 10_000, 20_000], false);
    // Leaving a fraction of outro beats re-encoding the whole video for it.
    expect(plan.mode).toBe('stream-copy');
    expect(plan.cutAtMs).toBe(20_000);
  });

  it('copes with no keyframe before the cut', () => {
    expect(planTrim(5_000, [10_000], false).cutAtMs).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Filter graphs
 * ------------------------------------------------------------------ */

const box = (x: number, y: number) => ({ x, y, width: 300, height: 90 });

describe('filter graphs (LGPL only)', () => {
  it('never emits a GPL-gated filter', () => {
    const segments = [
      { startMs: 0, endMs: 3_000, box: box(700, 100) },
      { startMs: 3_000, endMs: 6_000, box: box(40, 1_600) },
    ];
    const graphs = [
      buildBlurGraph(segments),
      buildStaticBlurGraph([box(700, 100), box(40, 1_600)]),
      buildRemovelogoGraph(segments.map((s) => ({ ...s, maskPath: '/tmp/mask.pgm' }))),
    ];

    for (const graph of graphs) {
      // delogo and boxblur require --enable-gpl and are absent from the build
      // this product ships; emitting one would fail at runtime.
      expect(graph).not.toMatch(/\bdelogo\b/);
      expect(graph).not.toMatch(/\bboxblur\b/);
      expect(graph).not.toMatch(/\bsmartblur\b/);
    }
  });

  it('gates every segment to its own time window', () => {
    const graph = buildBlurGraph([
      { startMs: 0, endMs: 3_000, box: box(700, 100) },
      { startMs: 3_000, endMs: 6_000, box: box(40, 1_600) },
    ]);
    // A single static box would miss the mark half the time (section 2).
    expect(graph).toContain("enable='between(t,0.000,3.000)'");
    expect(graph).toContain("enable='between(t,3.000,6.000)'");
  });

  it('formats the enable expression in seconds', () => {
    expect(enableExpression(1_500, 4_250)).toBe("enable='between(t,1.500,4.250)'");
  });

  it('chains one removelogo instance per segment', () => {
    const graph = buildRemovelogoGraph([
      { startMs: 0, endMs: 3_000, box: box(700, 100), maskPath: '/tmp/a.pgm' },
      { startMs: 3_000, endMs: 6_000, box: box(40, 1_600), maskPath: '/tmp/b.pgm' },
    ]);
    expect(graph.match(/removelogo=/g)).toHaveLength(2);
    expect(graph).toContain('/tmp/a.pgm');
    expect(graph).toContain('/tmp/b.pgm');
  });

  it('escapes characters that would break filter argument parsing', () => {
    const graph = buildRemovelogoGraph([
      { startMs: 0, endMs: 1_000, box: box(0, 0), maskPath: 'C:\\Users\\me\\mask.pgm' },
    ]);
    expect(graph).toContain('C\\:/Users/me/mask.pgm');
  });

  it('isolates the region so the whole frame is not blurred', () => {
    const graph = buildBlurGraph([{ startMs: 0, endMs: 3_000, box: box(700, 100) }]);
    expect(graph).toContain('crop=300:90:700:100');
    expect(graph).toContain('gblur=sigma=');
    expect(graph).toContain('overlay=700:100');
  });

  it('splits into exactly as many branches as it consumes', () => {
    const segments = [
      { startMs: 0, endMs: 1_000, box: box(1, 1) },
      { startMs: 1_000, endMs: 2_000, box: box(2, 2) },
      { startMs: 2_000, endMs: 3_000, box: box(3, 3) },
    ];
    const graph = buildBlurGraph(segments);
    // One base plus one source per segment; a mismatch is an ffmpeg error.
    expect(graph).toContain('split=4[base][src0][src1][src2]');
    expect(graph).toContain('[vout]');
  });

  it('returns an empty graph when there is nothing to do', () => {
    expect(buildBlurGraph([])).toBe('');
    expect(buildRemovelogoGraph([])).toBe('');
    expect(buildStaticBlurGraph([])).toBe('');
  });

  it('covers every candidate region for the whole duration in the static tier', () => {
    const graph = buildStaticBlurGraph([box(700, 100), box(40, 1_600)]);
    expect(graph).toContain('overlay=700:100');
    expect(graph).toContain('overlay=40:1600');
    // No time gating: crude but never misses.
    expect(graph).not.toContain('enable=');
  });
});

describe('removelogo masks', () => {
  it('writes a valid PGM with the region marked white', () => {
    const mask = buildMaskPgm(10, 4, [{ x: 2, y: 1, width: 3, height: 2 }]);
    const expectedHeader = 'P5\n10 4\n255\n';
    expect(mask.subarray(0, expectedHeader.length).toString('ascii')).toBe(expectedHeader);

    const pixels = mask.subarray(expectedHeader.length);
    expect(pixels).toHaveLength(40);
    expect(pixels[0]).toBe(0);
    expect(pixels[1 * 10 + 2]).toBe(255);
    expect(pixels[2 * 10 + 4]).toBe(255);
    expect(pixels[3 * 10 + 2]).toBe(0);
  });

  it('clamps a region that overflows the frame', () => {
    const mask = buildMaskPgm(4, 4, [{ x: 3, y: 3, width: 100, height: 100 }]);
    expect(mask.subarray(mask.length - 16)).toHaveLength(16);
  });

  it('keeps the mask off the frame edge so there is something to interpolate from', () => {
    const inset = insetBoxFromEdges({ x: 0, y: 0, width: 100, height: 50 }, 1_080, 1_920);
    expect(inset.x).toBeGreaterThanOrEqual(2);
    expect(inset.y).toBeGreaterThanOrEqual(2);
    expect(inset.x + inset.width).toBeLessThan(1_080);
  });
});

/* ------------------------------------------------------------------ *
 * Encoder selection
 * ------------------------------------------------------------------ */

function capabilities(encoders: Record<string, boolean>): MediaCapabilities {
  return { probed: true, isGplBuild: false, filters: {}, encoders, missingRequired: [] };
}

describe('encoder selection (section 3)', () => {
  it('prefers hardware when it is available', () => {
    const choice = selectEncoder(capabilities({ h264_nvenc: true, libopenh264: true }));
    expect(choice.name).toBe('h264_nvenc');
    expect(choice.hardware).toBe(true);
  });

  it('falls back to libopenh264 when no hardware encoder exists', () => {
    const choice = selectEncoder(capabilities({ libopenh264: true }));
    expect(choice.name).toBe('libopenh264');
    expect(choice.hardware).toBe(false);
  });

  it('never selects a GPL encoder, even when the build offers one', () => {
    // A GPL build with libx264 available must still be refused.
    expect(() => selectEncoder(capabilities({ libx264: true, libx265: true }))).toThrow();
    for (const forbidden of FORBIDDEN_ENCODERS) {
      const choice = (): string => selectEncoder(capabilities({ [forbidden]: true, libopenh264: true })).name;
      expect(choice()).toBe('libopenh264');
    }
  });

  it('fails with an actionable message when nothing usable exists', () => {
    let detail = '';
    try {
      selectEncoder(capabilities({}));
    } catch (err) {
      detail = (err as { detail?: string }).detail ?? '';
    }
    expect(detail).toMatch(/libx264 cannot be used/i);
  });

  it('can be forced to software', () => {
    expect(selectEncoder(capabilities({ h264_nvenc: true, libopenh264: true }), false).name).toBe('libopenh264');
  });

  it('estimates hardware as faster than software', () => {
    const hw = estimateProcessingMs(30_000, selectEncoder(capabilities({ h264_nvenc: true })));
    const sw = estimateProcessingMs(30_000, selectEncoder(capabilities({ libopenh264: true })));
    expect(hw).toBeLessThan(sw);
  });
});

/* ------------------------------------------------------------------ *
 * Watermark detection
 * ------------------------------------------------------------------ */

function sample(timeMs: number, upper: number, lower: number): FrameSample {
  return { timeMs, regionScores: { upper, lower } };
}

describe('watermark segmentation', () => {
  it('splits the alternating cycle into separate segments', () => {
    const samples = [
      sample(0, 0.9, 0.1),
      sample(1_000, 0.9, 0.1),
      sample(2_000, 0.9, 0.1),
      sample(3_000, 0.1, 0.9),
      sample(4_000, 0.1, 0.9),
      sample(5_000, 0.1, 0.9),
    ];
    const segments = buildSegments(samples, 6_000, 1_080, 1_920);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.box).toEqual(toPixelBox(CANDIDATE_REGIONS[0]!, 1_080, 1_920));
    expect(segments[1]?.box).toEqual(toPixelBox(CANDIDATE_REGIONS[1]!, 1_080, 1_920));
    // Boundaries land between the samples that disagree.
    expect(segments[0]?.endMs).toBeCloseTo(2_500, 0);
    expect(segments[1]?.startMs).toBeCloseTo(2_500, 0);
  });

  it('ignores frames where nothing scores above the presence threshold', () => {
    const below = PRESENCE_THRESHOLD - 0.05;
    expect(buildSegments([sample(0, below, below), sample(1_000, below, below)], 2_000, 1_080, 1_920)).toEqual([]);
  });

  it('produces no zero-length segments', () => {
    const segments = buildSegments([sample(0, 0.9, 0.1)], 1_000, 1_080, 1_920);
    for (const segment of segments) expect(segment.endMs).toBeGreaterThan(segment.startMs);
  });
});

describe('watermark tier selection', () => {
  const confidentSamples = Array.from({ length: 8 }, (_, i) =>
    i < 4 ? sample(i * 1_000, 0.9, 0.05) : sample(i * 1_000, 0.05, 0.9),
  );

  it('uses removelogo when detection is confident and the filter exists', () => {
    const plan = detectWatermark({
      samples: confidentSamples,
      durationMs: 8_000,
      frameWidth: 1_080,
      frameHeight: 1_920,
      removelogoAvailable: true,
    });
    expect(plan.tier).toBe('removelogo');
    expect(plan.segments).toHaveLength(2);
  });

  it('falls back to blur when the build lacks removelogo', () => {
    const plan = detectWatermark({
      samples: confidentSamples,
      durationMs: 8_000,
      frameWidth: 1_080,
      frameHeight: 1_920,
      removelogoAvailable: false,
    });
    expect(plan.tier).toBe('blur');
  });

  it('drops to the static tier when confidence is low', () => {
    const unsure = Array.from({ length: 8 }, (_, i) => sample(i * 1_000, 0.58, 0.5));
    const plan = detectWatermark({
      samples: unsure,
      durationMs: 8_000,
      frameWidth: 1_080,
      frameHeight: 1_920,
      removelogoAvailable: true,
    });
    // A mis-timed filter leaves the watermark visible half the time, which is
    // worse than a crude blur that never misses.
    expect(plan.tier).toBe('static-blur');
    expect(plan.segments).toHaveLength(CANDIDATE_REGIONS.length);
    expect(plan.reason).toMatch(/too low to trust/i);
  });

  it('drops to the static tier when nothing is found at all', () => {
    const plan = detectWatermark({
      samples: [sample(0, 0.1, 0.1)],
      durationMs: 8_000,
      frameWidth: 1_080,
      frameHeight: 1_920,
      removelogoAvailable: true,
    });
    expect(plan.tier).toBe('static-blur');
  });

  it('refuses to trust too few samples, however strongly each one scored', () => {
    // One confident frame of a two-minute video says nothing about timing.
    const sparse = [sample(0, 0.95, 0.05)];
    const plan = detectWatermark({
      samples: sparse,
      durationMs: 120_000,
      frameWidth: 1_080,
      frameHeight: 1_920,
      removelogoAvailable: true,
    });
    expect(plan.tier).toBe('static-blur');
  });

  it('drops to the static tier when segments cover almost none of the video', () => {
    // Enough samples to segment, but they only find the mark in a brief burst
    // near the start of a long video, so the timing cannot be trusted.
    const burst = [
      sample(0, 0.95, 0.05),
      sample(500, 0.95, 0.05),
      sample(1_000, 0.1, 0.1),
      sample(60_000, 0.1, 0.1),
      sample(119_000, 0.1, 0.1),
    ];
    const plan = detectWatermark({
      samples: burst,
      durationMs: 120_000,
      frameWidth: 1_080,
      frameHeight: 1_920,
      removelogoAvailable: true,
    });
    expect(plan.tier).toBe('static-blur');
  });

  it('covers the whole duration in the static tier', () => {
    const plan = detectWatermark({
      samples: [],
      durationMs: 15_000,
      frameWidth: 1_080,
      frameHeight: 1_920,
      removelogoAvailable: true,
    });
    for (const segment of plan.segments) {
      expect(segment.startMs).toBe(0);
      expect(segment.endMs).toBe(15_000);
    }
  });
});

describe('region scoring', () => {
  it('scores a bright, high-contrast patch above flat video', () => {
    const size = 16;
    const flat = new Uint8Array(size * size).fill(90);

    const glyph = new Uint8Array(size * size).fill(60);
    // Alternating bright bars: hard edges plus near-white pixels.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x += 2) glyph[y * size + x] = 250;
    }

    expect(scoreRegionLuminance(glyph, size, size)).toBeGreaterThan(scoreRegionLuminance(flat, size, size));
  });

  it('returns 0 for degenerate input rather than throwing', () => {
    expect(scoreRegionLuminance(new Uint8Array(0), 0, 0)).toBe(0);
    expect(scoreRegionLuminance(new Uint8Array(4), 1, 1)).toBe(0);
  });

  it('stays within 0-1', () => {
    const extreme = new Uint8Array(64).map((_, i) => (i % 2 === 0 ? 255 : 0));
    const score = scoreRegionLuminance(extreme, 8, 8);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
