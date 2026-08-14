import { writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { VideoMetadata } from '../resolve/types';
import type { Cue } from '../captions/cues';
import { generateSeo, type SeoResult } from './seo';

/**
 * The title and description, written beside the video.
 *
 * A text file rather than a database row or an embedded tag, because of what it
 * is for: these are meant to be read and pasted somewhere else. A tag inside
 * the MP4 would need a full remux to write and a tool to read back, and a
 * database row would need the app open to see. A `.txt` next to the video opens
 * in anything and can be copied out in one selection.
 *
 * The scoring is included in the file on purpose. A title that scored 60 out of
 * 100 with a stated reason invites a five-second edit; a title with no reasons
 * attached is either trusted blindly or ignored.
 */

export interface SidecarInput {
  readonly videoPath: string;
  readonly cues: readonly Cue[];
  readonly metadata: VideoMetadata;
}

export interface SidecarResult {
  readonly path: string;
  readonly seo: SeoResult;
}

export function writeSeoSidecar(input: SidecarInput): SidecarResult {
  const seo = generateSeo({
    cues: input.cues,
    caption: input.metadata.caption,
    hashtags: input.metadata.hashtags,
    authorHandle: input.metadata.authorHandle,
    durationMs: input.metadata.durationMs,
  });

  const path = sidecarPathFor(input.videoPath);
  writeFileSync(path, renderSidecar(seo, input.metadata), 'utf8');
  return { path, seo };
}

/** `video.mp4` → `video.txt`, so the pair sorts together in any file browser. */
export function sidecarPathFor(videoPath: string): string {
  const extension = extname(videoPath);
  const stem = extension === '' ? basename(videoPath) : basename(videoPath, extension);
  return join(dirname(videoPath), `${stem}.txt`);
}

export function renderSidecar(seo: SeoResult, metadata: VideoMetadata): string {
  const failed = seo.score.checks.filter((check) => !check.passed);

  const lines = [
    'TITLE',
    seo.title,
    '',
    'DESCRIPTION',
    seo.description,
    '',
    `KEYWORDS  ${seo.keywords.join(', ') || '—'}`,
    metadata.hashtags.length > 0 ? `HASHTAGS  ${metadata.hashtags.map((tag) => `#${tag}`).join(' ')}` : null,
    '',
    // Said plainly: a title written from a transcript and one written from three
    // hashtags are not the same claim, and the file should not pretend they are.
    `Written from: ${
      seo.basis === 'transcript'
        ? 'what is said in the video'
        : seo.basis === 'caption'
          ? "the creator's caption (this video has no transcript)"
          : 'hashtags and video details only — there was little to work from'
    }`,
    `SEO score: ${seo.score.total}/100`,
    ...(failed.length > 0 ? ['', 'Worth a look before posting:'] : []),
    ...failed.map((check) => `  · ${check.note}`),
    '',
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}
