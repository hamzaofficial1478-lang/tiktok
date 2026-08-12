/** Pixel-space rectangle within a frame. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A window of time during which the watermark sits in one place. */
export interface WatermarkSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly box: Box;
}

/**
 * The filtering tiers of section 9, named for the LGPL-safe filters this
 * project actually uses rather than the GPL ones the brief names:
 *
 *   removelogo    tier 1 — interpolates from the region border (replaces delogo)
 *   blur          tier 2 — time-segmented blur (replaces boxblur)
 *   static-blur   tier 3 — blur every candidate region for the whole duration
 */
export type FilterTier = 'removelogo' | 'blur' | 'static-blur';

export interface WatermarkPlan {
  readonly tier: FilterTier;
  readonly segments: readonly WatermarkSegment[];
  /** 0-1. Below the tier-3 threshold the plan degrades to static-blur. */
  readonly confidence: number;
  readonly reason: string;
}

export interface OutroDecision {
  readonly trim: boolean;
  /** Where the cut lands, in milliseconds from the start. */
  readonly cutAtMs: number | null;
  readonly trimmedMs: number;
  readonly confidence: number;
  readonly reason: string;
  /** Which safety rail refused the trim, when one did. */
  readonly blockedBy: 'too-short' | 'too-long' | 'too-large-a-share' | 'low-confidence' | null;
}

export interface TrimPlan {
  readonly mode: 'stream-copy' | 're-encode';
  readonly cutAtMs: number;
  readonly reason: string;
}
