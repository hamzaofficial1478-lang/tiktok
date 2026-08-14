import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * TikTok's own caption tracks.
 *
 * A large share of TikTok videos already carry captions — yt-dlp's extractor
 * reads them from `auto_captions`, `cla_info.caption_infos` and the page's
 * `subtitleInfos`. They are free, instant, and written by whoever posted the
 * video or by TikTok's own transcription, which is trained on exactly this
 * material. Transcribing a video that already has a track would spend minutes
 * of CPU to produce something worse.
 *
 * ## Why this rides along with the download
 *
 * The obvious implementation is a second yt-dlp run asking for subtitles. That
 * costs a second extraction, a second challenge solve and a second set of
 * requests to TikTok for a video we are already downloading — and TikTok's
 * caption URLs need the same session the video does, so it cannot be a plain
 * fetch. Asking the run that is already happening to write the tracks out costs
 * one flag and no extra requests.
 */

/** Written by yt-dlp as `<basename>.<lang>.srt` beside the media file. */
const TRACK_FILE = /^(?<stem>.+)\.(?<lang>[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*(?:-orig)?)\.(?<ext>srt|vtt)$/;

export interface SubtitleTrack {
  readonly path: string;
  /** BCP-47-ish, as TikTok labels it: `en`, `es`, `pt-BR`, `en-orig`. */
  readonly language: string;
  readonly format: 'srt' | 'vtt';
}

/**
 * The languages to ask yt-dlp for, given what the user wants.
 *
 * `orig` is TikTok's label for the language actually spoken, and it leads
 * whenever no translation was asked for: a Spanish video captioned in Spanish
 * is right, and captioning it in English because English sorted first is not.
 * The wildcards are yt-dlp's own syntax and cost nothing when they match
 * nothing.
 */
export function subtitleLanguages(targetLanguage: string): string {
  if (targetLanguage === 'auto') return 'orig,en.*,en';
  return `${targetLanguage}.*,${targetLanguage},orig`;
}

/**
 * Finds the tracks a download wrote.
 *
 * Scans by name rather than trusting a path we predicted: yt-dlp decides the
 * language suffix, and which languages exist is only knowable after the fact.
 * The `mediaPath` is the file yt-dlp was told to write, whose stem the tracks
 * share.
 */
export function findTracks(mediaPath: string): readonly SubtitleTrack[] {
  const directory = dirname(mediaPath);
  const stem = basename(mediaPath);

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const tracks: SubtitleTrack[] = [];
  for (const entry of entries) {
    const match = TRACK_FILE.exec(entry);
    const groups = match?.groups;
    if (!groups) continue;
    // yt-dlp strips the media extension before appending the language, so both
    // "video.mp4.download" and "video" can be the stem it used.
    if (groups.stem !== stem && groups.stem !== stripExtension(stem)) continue;

    tracks.push({
      path: join(directory, entry),
      language: (groups.lang as string).toLowerCase(),
      format: groups.ext as 'srt' | 'vtt',
    });
  }
  return tracks;
}

/**
 * Chooses one track, and says whether it is the language that was asked for.
 *
 * The second half matters more than the first. If English captions were wanted
 * and only Spanish exists, silently burning Spanish onto the video is the worst
 * available outcome — it looks like the setting was ignored. Reporting the
 * mismatch lets the caller send the video for transcription-and-translation
 * instead, and fall back to this only if that is unavailable.
 */
export function pickTrack(
  tracks: readonly SubtitleTrack[],
  targetLanguage: string,
): { readonly track: SubtitleTrack; readonly matchesTarget: boolean } | null {
  if (tracks.length === 0) return null;

  const score = (track: SubtitleTrack): number => {
    const language = track.language.replace(/-orig$/, '');
    const isOriginal = track.language.endsWith('-orig') || track.language === 'orig';

    if (targetLanguage !== 'auto') {
      // An exact match beats a regional variant, which beats anything else.
      if (language === targetLanguage) return 100;
      if (language.startsWith(`${targetLanguage}-`)) return 90;
      return isOriginal ? 20 : 10;
    }
    // No target: the spoken language is the right one.
    return isOriginal ? 100 : 50;
  };

  // srt over vtt on a tie: both parse identically here, and srt is the one
  // yt-dlp converts to, so preferring it avoids keeping a redundant pair.
  const best = [...tracks].sort(
    (a, b) => score(b) - score(a) || (a.format === 'srt' ? -1 : 1),
  )[0] as SubtitleTrack;

  const language = best.language.replace(/-orig$/, '');
  const matchesTarget =
    targetLanguage === 'auto' || language === targetLanguage || language.startsWith(`${targetLanguage}-`);

  return { track: best, matchesTarget };
}

/** Reads a track, tolerating the BOM yt-dlp's converted output can carry. */
export function readTrack(track: SubtitleTrack): string {
  return readFileSync(track.path, 'utf8').replace(/^﻿/, '');
}

function stripExtension(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? name : name.slice(0, at);
}
