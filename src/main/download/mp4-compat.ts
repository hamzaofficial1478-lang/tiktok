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

/**
 * What an upload form will accept, which is a narrower thing than what plays.
 *
 * Facebook, Instagram and the rest all want the same shape and all report a
 * refusal the same unhelpful way — "we couldn't process your video", or an
 * upload that succeeds and then plays as a black rectangle. None of those
 * messages names a codec, so the checks have to be made here, before the file
 * is ever handed to one.
 */

/** The only video codec an upload form can be relied on to take. */
export const UPLOADABLE_VIDEO_CODEC = 'h264';

/**
 * And the only audio codec.
 *
 * TikTok serves AAC and the common path never touches it, so this almost never
 * fires — but yt-dlp merging a separate audio track can land Opus inside an
 * MP4, which is legal, plays everywhere locally, and is refused on upload. The
 * check costs nothing and the conversion costs one audio track.
 */
export const UPLOADABLE_AUDIO_CODECS = ['aac'];

/**
 * 8-bit 4:2:0, which is what "H.264 High profile" means in practice.
 *
 * A 10-bit or 4:4:4 H.264 stream is still H.264 and still refused — the same
 * failure as the wrong codec, from a file whose codec name looks correct, which
 * is exactly the kind of thing that costs an afternoon to work out.
 */
export const UPLOADABLE_PIXEL_FORMATS = ['yuv420p', 'yuvj420p'];

export interface CompatibilityVerdict {
  readonly needed: boolean;
  /** Move the index to the front. */
  readonly faststart: boolean;
  /** Relabel the H.265 stream as `hvc1`. */
  readonly retagHevc: boolean;
  /** One line for the log, saying what is wrong and therefore why this ran. */
  readonly reason: string;
}

export interface UploadabilityVerdict {
  /** Nothing about this file would get it refused by an upload form. */
  readonly ok: boolean;
  /** The video track is not H.264, or is H.264 in a form that is still refused. */
  readonly videoNeedsEncode: boolean;
  /** The audio track is not AAC. */
  readonly audioNeedsEncode: boolean;
  readonly reasons: readonly string[];
}

/**
 * Reads a probe and says whether a site would take the file.
 *
 * Pure, and separate from the fixing, because it is used twice: once to decide
 * what to do, and once afterwards on the result — which is the part that turns
 * "we tried to convert it" into "it is converted". Nothing else in the pipeline
 * checked its own work, and the silent failure this exists to catch is
 * specifically one where the attempt is made and does not happen.
 */
export function assessUploadability(probe: ProbeResult | null): UploadabilityVerdict {
  if (!probe) {
    // Nothing read the file, so nothing is claimed about it. Guessing in either
    // direction is worse than saying so.
    return { ok: true, videoNeedsEncode: false, audioNeedsEncode: false, reasons: [] };
  }

  const video = probe.streams.find((stream) => stream.codecType === 'video');
  const audio = probe.streams.find((stream) => stream.codecType === 'audio');
  const reasons: string[] = [];

  const codec = (video?.codecName ?? '').toLowerCase();
  const pixelFormat = (video?.pixelFormat ?? '').toLowerCase();

  let videoNeedsEncode = false;
  if (video && codec !== '' && codec !== UPLOADABLE_VIDEO_CODEC) {
    videoNeedsEncode = true;
    reasons.push(`its video is ${codec} rather than H.264`);
  } else if (video && pixelFormat !== '' && !UPLOADABLE_PIXEL_FORMATS.includes(pixelFormat)) {
    videoNeedsEncode = true;
    reasons.push(`its video is ${pixelFormat} rather than 8-bit 4:2:0`);
  }

  const audioCodec = (audio?.codecName ?? '').toLowerCase();
  const audioNeedsEncode = audio !== undefined && audioCodec !== '' && !UPLOADABLE_AUDIO_CODECS.includes(audioCodec);
  if (audioNeedsEncode) reasons.push(`its audio is ${audioCodec} rather than AAC`);

  return { ok: !videoNeedsEncode && !audioNeedsEncode, videoNeedsEncode, audioNeedsEncode, reasons };
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
   * Reads the file as it stands now, for deciding and for checking the result.
   *
   * The `probe` above was taken before the watermark pass, the caption pass and
   * anything else that rewrites the video, so by the time this runs it can be
   * describing bytes that no longer exist — which is a poor basis for deciding
   * whether the *current* file needs converting, and no basis at all for
   * confirming afterwards that it does not.
   *
   * Optional so the existing callers and tests that pass a probe and no prober
   * behave exactly as before.
   */
  readonly reprobe?: ((filePath: string) => Promise<ProbeResult | null>) | undefined;
  /**
   * Convert the video track to H.264, keeping every pixel of it.
   *
   * Absent means leave the codec alone. Present, it carries the encoders worth
   * trying, best first.
   *
   * A list rather than one encoder, because `ffmpeg -encoders` reports what the
   * build was compiled with and not what this machine can run: the LGPL builds
   * list NVENC, QuickSync, AMF and VAAPI on every computer, including ones with
   * none of that hardware. Committing to the first name and giving up when it
   * failed to start is how a video that needed converting stayed H.265 —
   * silently, because this whole pass is caught so that a filter cannot cost
   * somebody their download — and was then refused by every upload form.
   *
   * This exists at all because the alternative was so much worse. Wanting H.264
   * used to mean *downloading* H.264, and TikTok routinely publishes its top
   * resolution only as H.265 — so asking for compatibility silently fetched
   * 480p in place of a 1080p source, and no amount of processing afterwards
   * could put those pixels back. Converting costs one near-transparent encode
   * and some time, and keeps the picture.
   */
  readonly toH264?: { readonly encoders: readonly EncoderAttempt[] } | undefined;
  /** Told which encoder failed on a real video, so the next item skips it. */
  readonly onEncoderFailed?: ((name: string) => void) | undefined;
  /**
   * A video filter to apply, which forces a re-encode on its own.
   *
   * Sharpening lives here rather than in its own pass, and that placement is
   * the whole reason it is here: an H.265 file that also wants sharpening
   * would otherwise be decoded and encoded twice, for two generations of loss
   * where one will do. One pass, one encode, both jobs.
   */
  readonly videoFilter?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly log?: Logger | undefined;
}

/** One encoder to try: its ffmpeg name and its quality arguments. */
export interface EncoderAttempt {
  readonly name: string;
  readonly args: readonly string[];
}

export interface MakeUploadableResult {
  readonly rewritten: boolean;
  readonly reason: string | null;
  /**
   * Whether the file, as it now stands, is one an upload form will take.
   *
   * The point of reporting it is that it is checked rather than assumed. This
   * pass cannot fail an item — losing a downloaded video because a filter chain
   * misbehaved would be far worse than keeping it — so before this, an attempted
   * conversion that did not happen looked exactly like one that did, and the
   * first anybody knew was a rejected upload days later.
   *
   * Null when nothing could read the file to say either way.
   */
  readonly uploadable: boolean | null;
  /** What is still wrong with it, when something is. */
  readonly problems: readonly string[];
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
  /**
   * The file as it is now, not as it was before post-processing.
   *
   * `input.probe` was taken from the `.part`, before the watermark pass and the
   * caption pass rewrote the video. Deciding from it means deciding about bytes
   * that may no longer exist — and confirming from it afterwards would be
   * meaningless. When a fresh read is available it wins; when it is not, the
   * old probe is still better than nothing.
   */
  const probe = (input.reprobe ? await input.reprobe(input.filePath).catch(() => null) : null) ?? input.probe;

  const verdict = assessCompatibility({ boxes: safeBoxes(input.filePath), probe });

  /**
   * What an upload form would say about it, which is a separate question from
   * how the container is written.
   *
   * This used to ask only "is it HEVC?", and that was too narrow twice over.
   * TikTok has begun serving AV1 for some videos, which is refused just as
   * readily; and a 10-bit H.264 stream passes a codec-name check and is refused
   * anyway, which is the most confusing possible version of this failure.
   */
  const uploadability = assessUploadability(probe);
  const convert = input.toH264 !== undefined && uploadability.videoNeedsEncode;
  const convertAudio = uploadability.audioNeedsEncode;
  const filter = input.videoFilter ?? null;
  // A filter cannot be applied to a copied stream, so asking for one is asking
  // for an encode whatever else is or is not wrong with the file.
  const encoding = convert || filter !== null;

  if (!verdict.needed && !encoding && !convertAudio) {
    return { rewritten: false, reason: null, uploadable: uploadability.ok, problems: uploadability.reasons };
  }

  const why = [
    verdict.reason,
    convert || convertAudio ? uploadability.reasons.join(' and ') : '',
    filter ? 'sharpening was asked for' : '',
  ]
    .filter(Boolean)
    .join(' and ');

  if (!input.ffmpegPath) {
    input.log?.warn(
      { reason: why },
      'the file may be refused by upload sites, and ffmpeg is not installed to correct it',
    );
    return { rewritten: false, reason: why, uploadable: uploadability.ok, problems: uploadability.reasons };
  }

  /**
   * The encoders to try, best first.
   *
   * More than one because the first can be a lie: the build lists NVENC on a
   * machine with no NVIDIA card, and it fails the instant it tries to open the
   * device. Falling through to the next one is the difference between a
   * converted file and an H.265 file nobody can upload.
   */
  const encoders: readonly EncoderAttempt[] = encoding
    ? (input.toH264?.encoders ?? [])
    : [];
  if (encoding && encoders.length === 0) {
    input.log?.warn(
      { reason: why },
      'this ffmpeg build offers no usable H.264 encoder, so the file is kept exactly as it was downloaded',
    );
    return { rewritten: false, reason: why, uploadable: uploadability.ok, problems: uploadability.reasons };
  }

  const output = `${input.filePath}.compat.mp4`;
  // One entry when nothing is being encoded, so the loop below covers both.
  const attempts: readonly (EncoderAttempt | null)[] = encoding ? encoders : [null];
  let lastError: string | null = null;

  for (const encoder of attempts) {
    rmSync(output, { force: true });

    const args = [
      '-y',
      '-v',
      'error',
      '-i',
      input.filePath,
      /**
       * Which streams come across, and why the answer differs by path.
       *
       * A straight copy takes everything — `-map 0` — because everything in the
       * file is worth keeping and none of it is being touched.
       *
       * An encode cannot say that. `-map 0` selects *every* video stream, and a
       * TikTok MP4 routinely carries a second one: a single-frame attached
       * picture for the cover art. With `-c:v` set, ffmpeg dutifully tries to
       * put that one frame through a hardware H.264 encoder and through the
       * filter chain, and the run fails — taking a download that had already
       * succeeded with it. `0:V:0` is the first *real* video stream,
       * attached pictures excluded, which is exactly the distinction wanted
       * here. Audio and subtitles follow with `?` so a file without them is not
       * an error.
       */
      ...(encoding ? ['-map', '0:V:0', '-map', '0:a?', '-map', '0:s?'] : ['-map', '0']),
      /**
       * Copy is the default and the overrides are added on top, so a track
       * nothing is wrong with is never re-encoded.
       *
       * No scaling, no resizing. The whole point of converting rather than
       * downloading a smaller stream is that the picture arrives intact, and
       * the fastest way to undo that would be to touch the frame size here.
       */
      '-c',
      'copy',
      ...(filter ? ['-vf', filter] : []),
      ...(encoder ? ['-c:v', encoder.name, ...encoder.args, '-pix_fmt', 'yuv420p'] : []),
      /**
       * Audio, only when it is not already AAC.
       *
       * TikTok serves AAC and this almost never fires, but yt-dlp merging a
       * separate audio track can land Opus inside an MP4 — legal, plays
       * everywhere locally, refused on upload. 192k is above transparent for a
       * source that was never better than that.
       */
      ...(convertAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
      '-movflags',
      '+faststart',
      // Only meaningful when the H.265 stream is being kept, which is the case
      // where no H.264 conversion was asked for.
      ...(verdict.retagHevc && !encoder ? ['-tag:v', 'hvc1'] : []),
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
        throw new AppError(
          'FFMPEG_FAILED',
          result.stderr.trim().split('\n').pop() ?? `ffmpeg exited ${result.exitCode}`,
        );
      }
      if (statSync(output).size === 0) {
        throw new AppError('FFMPEG_FAILED', 'the rewritten file is empty');
      }

      renameSync(output, input.filePath);

      /**
       * And then check the work, rather than assuming it.
       *
       * This is the assertion that would have caught the whole thing on the day
       * it started: an encoder that cannot open its device fails, the failure is
       * caught so the download survives, and the file quietly stays in the
       * format that gets refused. Reading the result turns that from a silent
       * outcome into a stated one.
       */
      const after = input.reprobe ? await input.reprobe(input.filePath).catch(() => null) : null;
      const check = after ? assessUploadability(after) : null;

      if (check && !check.ok) {
        input.log?.warn(
          { encoder: encoder?.name ?? null, problems: check.reasons },
          'the file was rewritten and is still in a form upload sites refuse',
        );
      } else {
        input.log?.info(
          { reason: why, encoder: encoder?.name ?? null },
          'rewrote the container so the file uploads and plays everywhere',
        );
      }

      return {
        rewritten: true,
        reason: verdict.reason,
        uploadable: check ? check.ok : null,
        problems: check ? check.reasons : [],
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      rmSync(output, { force: true });

      // An abort is the queue stopping, not this encoder being unusable.
      if (input.signal?.aborted) break;

      if (encoder) {
        input.onEncoderFailed?.(encoder.name);
        input.log?.warn(
          { encoder: encoder.name, err: lastError },
          attempts.indexOf(encoder) < attempts.length - 1
            ? 'this encoder could not run here; trying the next one'
            : 'no encoder on this machine could convert the video',
        );
      }
    }
  }

  input.log?.warn(
    { err: lastError, reason: verdict.reason },
    'could not rewrite the container; the download is kept as it is',
  );
  return {
    rewritten: false,
    reason: verdict.reason,
    uploadable: uploadability.ok,
    problems: uploadability.reasons,
  };
}

/** A file this cannot parse simply reports no boxes, rather than throwing. */
function safeBoxes(filePath: string): Mp4Box[] {
  try {
    return readTopLevelBoxes(filePath);
  } catch {
    return [];
  }
}
