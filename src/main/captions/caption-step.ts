import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type { Logger } from 'pino';
import { AppError } from '@shared/errors';
import type { CaptionSettings } from '@shared/caption-schema';
import { translationIsSupported } from '@shared/caption-schema';
import type { ProcessRunner } from '../resolve/process-runner';
import { buildAss, fittedLineChars, fontSizeFor } from './ass';
import { planBurn, softSubtitlesLoseStyling, SUBTITLE_FILENAME } from './burn';
import { normaliseCues, parseSubtitles, type Cue } from './cues';
import { findTracks, pickTrack, readTrack } from './tiktok-tracks';

/**
 * Putting captions on a downloaded video.
 *
 * The order is the whole design: TikTok's own track first because it is free
 * and already correct, transcription second because it costs minutes of CPU,
 * and nothing at all rather than something wrong. Each step can decline, and
 * declining is reported rather than silently producing a video with no captions
 * on it and no explanation of why.
 *
 * A failure here never fails the download. The video is on disk and watchable;
 * losing it because a filter chain misbehaved would be a far worse outcome than
 * keeping it without captions.
 */

export interface Transcriber {
  readonly available: boolean;
  /** Returns cues, or null when it cannot handle this audio. */
  transcribe(input: {
    readonly filePath: string;
    readonly translateToEnglish: boolean;
    readonly signal?: AbortSignal;
  }): Promise<readonly Cue[] | null>;
}

export interface CaptionStepInput {
  readonly filePath: string;
  /** The path yt-dlp wrote to, whose stem any caption tracks share. */
  readonly mediaStemPath: string;
  readonly settings: CaptionSettings;
  readonly frameWidth: number | null;
  readonly frameHeight: number | null;
  readonly durationMs: number | null;
  readonly ffmpegPath: string | null;
  readonly runner: ProcessRunner;
  readonly encoderArgs?: readonly string[];
  readonly transcriber?: Transcriber;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
}

export interface CaptionStepResult {
  readonly applied: boolean;
  /** Where the words came from, for the queue row and the log. */
  readonly source: 'tiktok' | 'transcribed' | null;
  readonly language: string | null;
  readonly cueCount: number;
  /** Set when nothing was applied, saying which step declined and why. */
  readonly skipped: string | null;
  /** The cues themselves, so metadata generation can read the transcript. */
  readonly cues: readonly Cue[];
}

const NOTHING: CaptionStepResult = {
  applied: false,
  source: null,
  language: null,
  cueCount: 0,
  skipped: null,
  cues: [],
};

/**
 * Finds the words, in the order that costs least.
 *
 * Exported separately from the rendering because it is the half worth reusing:
 * the transcript is also what a title and description are written from, and
 * that should not require burning captions onto anything.
 */
export async function collectCues(input: CaptionStepInput): Promise<{
  readonly cues: readonly Cue[];
  readonly source: 'tiktok' | 'transcribed' | null;
  readonly language: string | null;
  readonly skipped: string | null;
}> {
  const { settings } = input;
  const wantsTranscription = settings.source !== 'tiktok';

  if (settings.source !== 'transcribe') {
    const picked = pickTrack(findTracks(input.mediaStemPath), settings.targetLanguage);

    if (picked) {
      /**
       * A track exists, but not in the language that was asked for.
       *
       * Burning it anyway is the worst outcome available: the user set English,
       * gets Spanish, and nothing says the setting was not honoured. It is only
       * used once transcription has been given its chance and declined.
       */
      if (picked.matchesTarget || !wantsTranscription || !input.transcriber?.available) {
        const cues = parseSubtitles(readTrack(picked.track));
        if (cues.length > 0) {
          return {
            cues,
            source: 'tiktok',
            language: picked.track.language,
            skipped:
              picked.matchesTarget || settings.targetLanguage === 'auto'
                ? null
                : `TikTok's captions are in ${picked.track.language}, not ${settings.targetLanguage}`,
          };
        }
      }
    }
  }

  if (!wantsTranscription) {
    return { cues: [], source: null, language: null, skipped: 'this video has no TikTok captions' };
  }

  if (!input.transcriber?.available) {
    return {
      cues: [],
      source: null,
      language: null,
      skipped: 'this video has no TikTok captions and the transcriber is not installed',
    };
  }

  // Only English is a translation this can honestly perform; the schema rejects
  // any other target, and this is the second gate on the same rule.
  if (!translationIsSupported(settings)) {
    return {
      cues: [],
      source: null,
      language: null,
      skipped: `captions cannot be translated into ${settings.targetLanguage}`,
    };
  }

  const cues = await input.transcriber.transcribe({
    filePath: input.filePath,
    translateToEnglish: settings.targetLanguage === 'en',
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!cues || cues.length === 0) {
    return { cues: [], source: null, language: null, skipped: 'no speech was found in this video' };
  }

  return {
    cues,
    source: 'transcribed',
    language: settings.targetLanguage === 'auto' ? null : settings.targetLanguage,
    skipped: null,
  };
}

export async function applyCaptions(input: CaptionStepInput): Promise<CaptionStepResult> {
  if (input.settings.mode === 'off') return NOTHING;

  const found = await collectCues(input);
  if (found.cues.length === 0) {
    return { ...NOTHING, skipped: found.skipped };
  }

  // Sizing needs a frame. Without one from the probe, a portrait 1080x1920 is
  // the right guess for TikTok, and being wrong costs a caption that is a few
  // percent off rather than one drawn at the wrong scale entirely.
  const frameWidth = input.frameWidth ?? 1080;
  const frameHeight = input.frameHeight ?? 1920;
  const { style } = input.settings;

  const cues = normaliseCues(found.cues, {
    // The setting is the user's ceiling; the frame's is the real one.
    maxLineChars: Math.min(style.maxLineChars, fittedLineChars(frameWidth, fontSizeFor(style, frameHeight))),
    maxLines: style.maxLines,
    uppercase: style.uppercase,
    durationMs: input.durationMs,
  });

  if (cues.length === 0) return { ...NOTHING, skipped: 'the caption track held no usable cues' };

  if (!input.ffmpegPath) {
    return { ...NOTHING, cues, skipped: 'ffmpeg is needed to add captions and is not installed' };
  }

  /**
   * The ASS goes in a temp directory of our own, not beside the video.
   *
   * ffmpeg is run from that directory so the filter can name the file without
   * escaping (see burn.ts), and the name is one this app chose — so the user's
   * output folder never gains a stray `.ass`, whatever happens next.
   */
  const workDir = mkdtempSync(join(tmpdir(), 'tiktok-caps-'));
  const extension = extname(input.filePath) || '.mp4';
  const outputPath = join(workDir, `captioned${extension}`);

  try {
    writeFileSync(join(workDir, SUBTITLE_FILENAME), buildAss(cues, style, { frameWidth, frameHeight }));

    const plan = planBurn({
      mode: input.settings.mode,
      subtitleDir: workDir,
      subtitlePath: join(workDir, SUBTITLE_FILENAME),
      outputExtension: extension,
    });

    const args = ['-v', 'error', '-i', input.filePath, ...plan.args];
    if (plan.videoFilter) args.push('-vf', plan.videoFilter);
    if (plan.reencodes) {
      args.push('-c:v', ...(input.encoderArgs ?? ['libx264', '-crf', '20', '-preset', 'veryfast']), '-c:a', 'copy');
    } else {
      args.push('-c:v', 'copy', '-c:a', 'copy');
    }
    args.push('-movflags', '+faststart', '-y', outputPath);

    const result = await input.runner.run(input.ffmpegPath, args, {
      // Burning in re-encodes the whole video, so this is a video-length job.
      timeoutMs: 15 * 60_000,
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (result.exitCode !== 0) {
      throw new AppError('FFMPEG_FAILED', result.stderr.trim().slice(0, 300) || `ffmpeg exited ${result.exitCode}`);
    }

    // Replaced only once ffmpeg has succeeded, so a failure leaves the original
    // exactly as it was rather than a half-written file under its name.
    replaceFile(outputPath, input.filePath);

    if (input.settings.mode === 'soft' && softSubtitlesLoseStyling(extension)) {
      input.log?.info('captions were added as a track; %s cannot carry the styling', extension);
    }

    return {
      applied: true,
      source: found.source,
      language: found.language,
      cueCount: cues.length,
      skipped: null,
      cues,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** A cross-device-safe move: rename first, copy only if the devices differ. */
export function replaceFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    // The temp directory is very often on a different filesystem from the
    // user's output folder, and rename cannot cross one.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}
