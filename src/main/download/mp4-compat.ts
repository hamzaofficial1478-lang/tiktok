import { closeSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
import { AppError } from '@shared/errors';
import type { ProbeResult } from '../media/ffprobe';
import type { ProcessRunner } from '../resolve/process-runner';

/**
 * Making the finished MP4 acceptable to things that are not a local player.
 *
 * A file that plays perfectly in VLC can still be refused by an upload form, or
 * accepted and then played back as a black rectangle. Both happened, to the
 * same user, with videos this app downloaded — while the same videos from
 * another downloader uploaded without complaint. Neither symptom says anything
 * useful about the cause, so both are worth stating plainly:
 *
 * ## Where the index sits
 *
 * An MP4 keeps its index — the `moov` box, holding durations, dimensions and
 * where every frame lives — either before the media data or after it. A local
 * player has the whole file and does not care. Anything that reads the start of
 * a file to find out what it is very much does, and an uploader that cannot
 * find the index in the first few hundred kilobytes reports something
 * unhelpfully generic. ffmpeg writes it at the end unless told otherwise; the
 * merge step is told otherwise now, but a file downloaded whole is whatever
 * TikTok wrote, and post-processing does not always run to correct it.
 *
 * ## How H.265 is labelled
 *
 * HEVC in an MP4 is tagged either `hvc1` or `hev1`. The video is identical.
 * The difference is where the decoder configuration lives: `hvc1` puts it in
 * the sample description, where players look for it before playing anything;
 * `hev1` allows it inline in the stream, so a player must start decoding to
 * discover how to decode. Apple's stack rejects `hev1` outright, and several
 * web transcoders show a black picture instead. TikTok writes `hev1`.
 *
 * Both are fixed by rewriting the container and copying the streams untouched —
 * no re-encode, no quality change, a second or two on a file of this size.
 */

/** One top-level box in an MP4, in file order. */
export interface Mp4Box {
  readonly type: string;
  readonly size: number;
}

/**
 * Reads the top-level box list without reading the file.
 *
 * Each box states its own length, so this seeks from one header to the next and
 * reads 16 bytes at each — a handful of reads regardless of how large the video
 * is. That matters because this runs on every download, and reading a hundred
 * megabytes to answer "where is the index" would cost more than the fix.
 */
export function readTopLevelBoxes(filePath: string, limit = 64): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  const total = statSync(filePath).size;
  const fd = openSync(filePath, 'r');

  try {
    const header = Buffer.alloc(16);
    let offset = 0;

    while (offset < total && boxes.length < limit) {
      const read = readSync(fd, header, 0, 16, offset);
      if (read < 8) break;

      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;

      if (size === 1) {
        // 64-bit length, carried in the eight bytes after the type.
        if (read < 16) break;
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(large);
        headerSize = 16;
      } else if (size === 0) {
        // "Runs to the end of the file" — always the last box.
        boxes.push({ type, size: total - offset });
        break;
      }

      if (size < headerSize) break;
      boxes.push({ type, size });
      offset += size;
    }
  } finally {
    closeSync(fd);
  }

  return boxes;
}

/**
 * True when the index comes after the media data.
 *
 * Absence of either box is not a complaint: a file this cannot parse is not one
 * to start rewriting on a guess.
 */
export function indexIsAtTheEnd(boxes: readonly Mp4Box[]): boolean {
  const moov = boxes.findIndex((box) => box.type === 'moov');
  const mdat = boxes.findIndex((box) => box.type === 'mdat');
  if (moov === -1 || mdat === -1) return false;
  return moov > mdat;
}

export interface CompatibilityVerdict {
  readonly needed: boolean;
  /** Move the index to the front. */
  readonly faststart: boolean;
  /** Relabel the H.265 stream as `hvc1`. */
  readonly retagHevc: boolean;
  /** One line for the log, saying what is wrong and therefore why this ran. */
  readonly reason: string;
}

/**
 * Decides whether the file needs rewriting, from what has already been read.
 *
 * Pure and separate from the doing, because the interesting part is the
 * judgement: rewriting every file unconditionally would work and would also
 * spend a full copy of every video on the majority that need nothing.
 */
export function assessCompatibility(input: {
  readonly boxes: readonly Mp4Box[];
  readonly probe: ProbeResult | null;
}): CompatibilityVerdict {
  const faststart = indexIsAtTheEnd(input.boxes);

  const video = input.probe?.streams.find((stream) => stream.codecType === 'video');
  const isHevc = (video?.codecName ?? '').toLowerCase() === 'hevc';
  const tag = (video?.codecTag ?? '').toLowerCase();
  // Only when the tag is known and wrong. An unknown tag on an HEVC stream is
  // not evidence of anything, and relabelling on a guess is how a working file
  // becomes a broken one.
  const retagHevc = isHevc && tag !== '' && tag !== 'hvc1';

  const reasons: string[] = [];
  if (faststart) reasons.push('its index is at the end of the file');
  if (retagHevc) reasons.push(`its H.265 stream is labelled ${tag} rather than hvc1`);

  return {
    needed: faststart || retagHevc,
    faststart,
    retagHevc,
    reason: reasons.join(' and '),
  };
}

export interface MakeUploadableInput {
  readonly filePath: string;
  readonly probe: ProbeResult | null;
  readonly ffmpegPath: string | null;
  readonly runner: ProcessRunner;
  /**
   * Convert an H.265 video track to H.264, keeping every pixel of it.
   *
   * Absent means leave the codec alone. Present, it carries the encoder and
   * its quality arguments, chosen from what this ffmpeg build actually has.
   *
   * This exists because the alternative was so much worse. Wanting H.264 used
   * to mean *downloading* H.264, and TikTok routinely publishes its top
   * resolution only as H.265 — so asking for compatibility silently fetched
   * 480p in place of a 1080p source, and no amount of processing afterwards
   * could put those pixels back. Converting costs one near-transparent encode
   * and some time, and keeps the picture.
   */
  readonly toH264?: { readonly encoderArgs: readonly string[] } | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly log?: Logger | undefined;
}

export interface MakeUploadableResult {
  readonly rewritten: boolean;
  readonly reason: string | null;
}

/**
 * Rewrites the container when it needs it, and does nothing at all when it does
 * not.
 *
 * `-c copy` throughout: every stream is carried across byte for byte, so this
 * cannot change how the video looks or sounds. The output is written beside the
 * original and renamed over it only on success, so a failure here leaves the
 * download exactly as it was — which is the right outcome, since a file with
 * its index in the wrong place still plays locally and is worth far more than
 * no file.
 */
export async function makeUploadable(input: MakeUploadableInput): Promise<MakeUploadableResult> {
  const verdict = assessCompatibility({ boxes: safeBoxes(input.filePath), probe: input.probe });

  /**
   * A conversion is work worth doing even when the container is otherwise fine.
   *
   * `assessCompatibility` only looks at how the file is written, and the codec
   * inside it is a separate question with a separate answer.
   */
  const video = input.probe?.streams.find((stream) => stream.codecType === 'video');
  const convert = input.toH264 !== undefined && (video?.codecName ?? '').toLowerCase() === 'hevc';

  if (!verdict.needed && !convert) return { rewritten: false, reason: null };

  const why = convert ? [verdict.reason, 'its video is H.265'].filter(Boolean).join(' and ') : verdict.reason;

  if (!input.ffmpegPath) {
    input.log?.warn(
      { reason: why },
      'the file may be refused by upload sites, and ffmpeg is not installed to correct it',
    );
    return { rewritten: false, reason: why };
  }

  const output = `${input.filePath}.compat.mp4`;
  rmSync(output, { force: true });

  const args = [
    '-y',
    '-v',
    'error',
    '-i',
    input.filePath,
    // Every stream, including a soft caption track added earlier.
    '-map',
    '0',
    /**
     * Copy unless a codec conversion was asked for, and even then only the
     * video: the audio is already AAC and re-encoding it would spend a second
     * generation of loss on a track nothing was complaining about.
     *
     * No scaling, no filters. The whole point of converting rather than
     * downloading a smaller stream is that the picture arrives intact, and the
     * fastest way to undo that would be to touch the frame size here.
     */
    '-c',
    'copy',
    ...(convert ? ['-c:v', ...(input.toH264?.encoderArgs ?? []), '-pix_fmt', 'yuv420p'] : []),
    '-movflags',
    '+faststart',
    ...(verdict.retagHevc ? ['-tag:v', 'hvc1'] : []),
    '-f',
    'mp4',
    output,
  ];

  try {
    const result = await input.runner.run(input.ffmpegPath, args, {
      timeoutMs: 5 * 60_000,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (result.exitCode !== 0) {
      throw new AppError('FFMPEG_FAILED', result.stderr.trim().split('\n').pop() ?? `ffmpeg exited ${result.exitCode}`);
    }
    if (statSync(output).size === 0) {
      throw new AppError('FFMPEG_FAILED', 'the rewritten file is empty');
    }

    renameSync(output, input.filePath);
    input.log?.info({ reason: verdict.reason }, 'rewrote the container so the file uploads and plays everywhere');
    return { rewritten: true, reason: verdict.reason };
  } catch (err) {
    rmSync(output, { force: true });
    input.log?.warn(
      { err: err instanceof Error ? err.message : String(err), reason: verdict.reason },
      'could not rewrite the container; the download is kept as it is',
    );
    return { rewritten: false, reason: verdict.reason };
  }
}

/** A file this cannot parse simply reports no boxes, rather than throwing. */
function safeBoxes(filePath: string): Mp4Box[] {
  try {
    return readTopLevelBoxes(filePath);
  } catch {
    return [];
  }
}
