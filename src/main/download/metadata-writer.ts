import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Logger } from 'pino';
import type { ProcessRunner } from '../resolve/process-runner';
import type { VideoMetadata } from '../resolve/types';

/**
 * Metadata output — spec section 9 step 10: embed title/artist/comment/date
 * into MP4 tags, and optionally write a JSON sidecar plus a thumbnail.
 *
 * Tagging is a stream copy, never a re-encode. Re-encoding to attach a title
 * would undo the entire point of preferring a clean source, so if the remux
 * cannot be done losslessly it is skipped and the untagged file is kept.
 *
 * Every function here is best-effort by design: a failure to write a sidecar
 * must never fail a download that already succeeded.
 */

export interface EmbedOptions {
  readonly filePath: string;
  readonly metadata: VideoMetadata;
  readonly canonicalUrl: string;
  readonly ffmpegPath: string | null;
  readonly runner: ProcessRunner;
  readonly log?: Logger;
  readonly signal?: AbortSignal;
}

/** @returns true when tags were written. */
export async function embedMetadata(options: EmbedOptions): Promise<boolean> {
  const { ffmpegPath, metadata } = options;
  if (!ffmpegPath) return false;

  const extension = extname(options.filePath);
  // Tags are only meaningful in containers that carry them; anything exotic is
  // left alone rather than remuxed into a format the user did not ask for.
  if (!['.mp4', '.m4a', '.mov', '.m4v', '.mp3'].includes(extension.toLowerCase())) return false;

  const temporary = join(dirname(options.filePath), `.tagging-${Date.now()}${extension}`);
  const tags: string[] = [];
  const add = (key: string, value: string | null): void => {
    if (value && value.trim() !== '') tags.push('-metadata', `${key}=${value}`);
  };

  add('title', metadata.caption ?? metadata.awemeId);
  add('artist', metadata.authorName ?? metadata.authorHandle);
  add('album_artist', metadata.authorHandle);
  add('comment', options.canonicalUrl);
  if (metadata.uploadedAt !== null) add('date', new Date(metadata.uploadedAt).toISOString().slice(0, 10));
  if (metadata.musicTitle) add('composer', metadata.musicTitle);

  if (tags.length === 0) return false;

  try {
    const result = await options.runner.run(
      ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        options.filePath,
        '-map',
        '0',
        '-c',
        'copy',
        ...tags,
        '-movflags',
        // Puts the metadata atom at the front so players read it without
        // scanning the whole file.
        'use_metadata_tags+faststart',
        '-y',
        temporary,
      ],
      { timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) },
    );

    if (result.exitCode !== 0) {
      options.log?.warn({ stderr: result.stderr.slice(0, 300) }, 'could not embed metadata; keeping the untagged file');
      rmSync(temporary, { force: true });
      return false;
    }

    renameSync(temporary, options.filePath);
    return true;
  } catch (err) {
    options.log?.warn({ err: String(err) }, 'metadata embedding failed; keeping the untagged file');
    rmSync(temporary, { force: true });
    return false;
  }
}

export interface SidecarOptions {
  readonly filePath: string;
  readonly metadata: VideoMetadata;
  readonly canonicalUrl: string;
  readonly rawUrl: string;
  readonly sourceStrategy: string;
  readonly extractor: string;
  readonly log?: Logger;
}

/** Writes `<name>.json` beside the video (section 9 step 10, section 12). */
export function writeSidecar(options: SidecarOptions): string | null {
  const sidecarPath = options.filePath.replace(/\.[^.]+$/, '') + '.json';
  const payload = {
    awemeId: options.metadata.awemeId,
    canonicalUrl: options.canonicalUrl,
    sourceUrl: options.rawUrl,
    author: {
      handle: options.metadata.authorHandle,
      name: options.metadata.authorName,
    },
    caption: options.metadata.caption,
    hashtags: options.metadata.hashtags,
    music: options.metadata.musicTitle,
    durationMs: options.metadata.durationMs,
    uploadedAt: options.metadata.uploadedAt === null ? null : new Date(options.metadata.uploadedAt).toISOString(),
    // Explicitly a snapshot: these numbers keep moving after the download.
    statsAtDownload: options.metadata.stats,
    downloadedAt: new Date().toISOString(),
    sourceStrategy: options.sourceStrategy,
    extractor: options.extractor,
  };

  try {
    writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return sidecarPath;
  } catch (err) {
    options.log?.warn({ err: String(err) }, 'could not write the metadata sidecar');
    return null;
  }
}

export interface ThumbnailOptions {
  readonly filePath: string;
  readonly coverUrl: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
}

/** Saves the cover image beside the video (section 10 Settings, section 12). */
export async function saveThumbnail(options: ThumbnailOptions): Promise<string | null> {
  if (!options.coverUrl) return null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  try {
    const response = await fetchImpl(options.coverUrl, {
      ...(options.signal ? { signal: options.signal } : {}),
      redirect: 'follow',
    });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    const extension = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const thumbnailPath = options.filePath.replace(/\.[^.]+$/, '') + extension;
    writeFileSync(thumbnailPath, Buffer.from(await response.arrayBuffer()));
    return thumbnailPath;
  } catch (err) {
    options.log?.debug({ err: String(err) }, 'could not save the thumbnail');
    return null;
  }
}
