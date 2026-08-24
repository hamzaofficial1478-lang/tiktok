import { AppError } from '@shared/errors';
import type { ProcessRunner } from '../resolve/process-runner';

/**
 * ffprobe wrapper.
 *
 * Takes an injected ProcessRunner for the same reason the extractor does: the
 * verification logic has to be testable without a real ffprobe binary, which
 * neither CI nor this development environment has.
 */

export interface ProbedStream {
  readonly codecType: 'video' | 'audio' | string;
  readonly codecName: string | null;
  /**
   * The four-character code the container labels this stream with, e.g. `avc1`
   * for H.264 or `hev1`/`hvc1` for H.265.
   *
   * Distinct from the codec name and worth having separately, because for HEVC
   * the two tags describe identical video and are not treated identically:
   * `hvc1` carries its parameter sets in the sample description where players
   * and uploaders look for them, `hev1` carries them inline in the stream.
   * TikTok writes `hev1`, and plenty of software — Apple's, and the transcoder
   * behind at least one large upload form — either refuses the file or shows a
   * black picture rather than saying what is wrong.
   */
  readonly codecTag: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
}

export interface ProbeResult {
  readonly durationMs: number | null;
  readonly sizeBytes: number | null;
  readonly bitrate: number | null;
  readonly formatName: string | null;
  readonly streams: readonly ProbedStream[];
}

export interface FfprobeOptions {
  readonly binaryPath: string | null;
  readonly runner: ProcessRunner;
  readonly timeoutMs?: number;
}

interface RawProbe {
  format?: { duration?: string; size?: string; bit_rate?: string; format_name?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    codec_tag_string?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    duration?: string;
  }[];
}

export class Ffprobe {
  constructor(private readonly options: FfprobeOptions) {}

  get isAvailable(): boolean {
    return this.options.binaryPath !== null;
  }

  async probe(filePath: string, signal?: AbortSignal): Promise<ProbeResult> {
    const binary = this.options.binaryPath;
    if (!binary) throw new AppError('FFMPEG_FAILED', 'ffprobe is not installed');

    const result = await this.options.runner.run(
      binary,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeoutMs: this.options.timeoutMs ?? 30_000, ...(signal ? { signal } : {}) },
    );

    if (result.exitCode !== 0) {
      throw new AppError('VERIFY_FAILED', `ffprobe could not read the file: ${result.stderr.trim() || 'no output'}`);
    }

    let raw: RawProbe;
    try {
      raw = JSON.parse(result.stdout) as RawProbe;
    } catch (err) {
      throw new AppError('VERIFY_FAILED', 'ffprobe returned unreadable output', { cause: err });
    }

    const streams: ProbedStream[] = (raw.streams ?? []).map((stream) => ({
      codecType: stream.codec_type ?? 'unknown',
      codecName: stream.codec_name ?? null,
      // ffprobe prints `[0][0][0][0]` for a stream with no tag at all, which is
      // a placeholder rather than a value and must not be read as one.
      codecTag: stream.codec_tag_string && !/^\[/.test(stream.codec_tag_string) ? stream.codec_tag_string : null,
      width: stream.width ?? null,
      height: stream.height ?? null,
      frameRate: parseFrameRate(stream.r_frame_rate),
    }));

    // Container duration is the reliable one; a stream-level duration is
    // absent often enough that relying on it produces false verification
    // failures on perfectly good files.
    const containerDuration = toNumber(raw.format?.duration);
    const streamDuration = (raw.streams ?? []).map((s) => toNumber(s.duration)).find((d) => d !== null) ?? null;
    const duration = containerDuration ?? streamDuration;

    return {
      durationMs: duration === null ? null : Math.round(duration * 1_000),
      sizeBytes: toNumber(raw.format?.size),
      bitrate: toNumber(raw.format?.bit_rate),
      formatName: raw.format?.format_name ?? null,
      streams,
    };
  }
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ffprobe reports frame rate as a fraction, e.g. "30000/1001". */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator as number) || !Number.isFinite(denominator as number)) return null;
  if (!denominator) return null;
  return (numerator as number) / (denominator as number);
}
