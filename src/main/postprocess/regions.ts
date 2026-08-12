import type { Box } from './types';

/**
 * Candidate watermark regions.
 *
 * Section 2: the TikTok watermark "alternates between roughly two corner
 * positions on a cycle of a few seconds". These are the places to look.
 *
 * IMPORTANT, and stated plainly because it affects output quality: the
 * normalised coordinates below are starting values, not measured ones. They
 * were reasoned from where TikTok places its watermark, not calibrated against
 * real footage — which is not possible without sample videos. The detector is
 * built so this matters less than it might: it *measures* each candidate
 * region per frame and only acts where it actually finds something, rather
 * than trusting these boxes blindly. Calibrating them against real downloads
 * is a phase-5 follow-up on a machine with ffmpeg and real files.
 */

/** Fractions of frame width/height, so one definition covers every resolution. */
export interface NormalizedRegion {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly description: string;
}

export const CANDIDATE_REGIONS: readonly NormalizedRegion[] = [
  {
    id: 'upper',
    x: 0.62,
    y: 0.06,
    width: 0.34,
    height: 0.09,
    description: 'upper right, where the mark sits for the first part of the cycle',
  },
  {
    id: 'lower',
    x: 0.04,
    y: 0.82,
    width: 0.34,
    height: 0.09,
    description: 'lower left, where it moves to for the second part',
  },
];

/** Padding around the detected mark, as a fraction of the region. */
const PADDING = 0.04;

export function toPixelBox(region: NormalizedRegion, frameWidth: number, frameHeight: number): Box {
  const padX = region.width * frameWidth * PADDING;
  const padY = region.height * frameHeight * PADDING;
  return {
    x: Math.max(0, Math.round(region.x * frameWidth - padX)),
    y: Math.max(0, Math.round(region.y * frameHeight - padY)),
    width: Math.min(frameWidth, Math.round(region.width * frameWidth + padX * 2)),
    height: Math.min(frameHeight, Math.round(region.height * frameHeight + padY * 2)),
  };
}

export function allPixelBoxes(frameWidth: number, frameHeight: number): Box[] {
  return CANDIDATE_REGIONS.map((region) => toPixelBox(region, frameWidth, frameHeight));
}
