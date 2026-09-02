import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Logger } from 'pino';
import { AppError } from '@shared/errors';
import type { SourceStrategy, WatermarkMode, OutroMode, EncodeQuality } from '@shared/types';
import type { MediaCapabilities } from '@shared/ipc/contract';
import type { ProcessRunner } from '../resolve/process-runner';
import type { Ffprobe } from '../media/ffprobe';
import { detectWatermark } from './watermark-detector';
import { detectOutro, planTrim } from './outro-detector';
import { sampleOutroSignals, sampleWatermarkRegions } from './frame-sampler';
import { allPixelBoxes } from './regions';
import {
  buildBlurGraph,
  buildMaskPgm,
  buildRemovelogoGraph,
  buildStaticBlurGraph,
  insetBoxFromEdges,
} from './filter-graph';
import { estimateProcessingMs, selectEncoder, type EncoderChoice } from './encoder';
import { applyQuality } from './enhance';
import type { WatermarkPlan } from './types';

/**
 * Post-processing orchestration — spec section 9.
 *
 * The most important behaviour here is the one that does nothing: when the
 * download already came from a clean source, this returns immediately. Section
 * 9 is emphatic that fetching a watermark-free stream is the primary strategy
 * precisely because filtering costs a full re-encode and visible quality, so
 * the fast path is the common path and the filtering tiers are the exception.
 */

export interface PostProcessInput {
  readonly filePath: string;
  readonly durationMs: number | null;
  readonly frameWidth: number | null;
  readonly frameHeight: number | null;
  /** What stream selection produced; 'clean_source' short-circuits everything. */
  readonly sourceStrategy: SourceStrategy;
  readonly watermarkMode: WatermarkMode;
  readonly outroMode: OutroMode;
  readonly hardwareAcceleration: boolean;
  readonly capabilities: MediaCapabilities;
  /**
   * Encoders already known to run on this machine, best first.
   *
   * `capabilities` says what ffmpeg was compiled with, which is not the same
   * question: the LGPL builds list NVENC, QuickSync, AMF and VAAPI everywhere,
   * including on computers with none of that hardware. Taking the first name
   * off that list is how the watermark pass was handed an encoder that cannot
   * open its device and failed on every single video.
   *
   * Absent, this falls back to the build's own list, which is the behaviour
   * that was here before and what the tests exercise.
   */
  readonly encoders?: readonly EncoderChoice[];
  readonly signal?: AbortSignal;
  /**
   * Asked once per session on the first detection when outroMode is 'ask'
   * (section 9). Returning false leaves the video whole.
   */
  readonly confirmOutro?: (proposal: {
    cutAtMs: number;
    trimmedMs: number;
    confidence: number;
  }) => Promise<boolean>;
  readonly onEstimate?: (estimatedMs: number) => void;
  /**
   * A sharpening filter to fold into this pass, when one is wanted.
   *
   * Given here rather than applied afterwards because this path is already
   * decoding and encoding the video. Sharpening it in a second pass would cost
   * a second generation of loss to do work this one can do for free.
   */
  readonly sharpen?: string | undefined;
  /** Quality step for the encoder; see postprocess/enhance.ts. */
  readonly encodeQuality?: EncodeQuality | undefined;
}

export interface PostProcessResult {
  readonly sourceStrategy: SourceStrategy;
  readonly watermarkRemoved: boolean;
  readonly outroTrimmedMs: number | null;
  /** True when a fallback tier ran, so the UI can say so (section 9). */
  readonly usedStaticFallback: boolean;
  readonly reEncoded: boolean;
  readonly notes: readonly string[];
}

export interface ProcessorOptions {
  readonly ffmpegPath: () => string | null;
  readonly runner: ProcessRunner;
  readonly ffprobe: Ffprobe;
  readonly log: Logger;
}

export class PostProcessor {
  constructor(private readonly options: ProcessorOptions) {}

  async process(input: PostProcessInput): Promise<PostProcessResult> {
    const notes: string[] = [];
    const log = this.options.log;

    const needsWatermarkWork =
      input.watermarkMode !== 'keep' &&
      input.sourceStrategy !== 'clean_source' &&
      (input.watermarkMode === 'force_removal' || input.sourceStrategy === 'raw');

    /**
     * The fast path, and the one that runs for the overwhelming majority of
     * downloads: a clean stream is already watermark-free, so there is nothing
     * to do and no re-encode to pay for.
     */
    if (!needsWatermarkWork && input.outroMode === 'never') {
      return {
        sourceStrategy: input.sourceStrategy,
        watermarkRemoved: input.sourceStrategy === 'clean_source',
        outroTrimmedMs: null,
        usedStaticFallback: false,
        reEncoded: false,
        notes: [
          input.sourceStrategy === 'clean_source'
            ? 'clean source; no processing needed'
            : 'watermark kept by preference',
        ],
      };
    }

    const ffmpegPath = this.options.ffmpegPath();
    if (!ffmpegPath) {
      // Missing ffmpeg is reported, not fatal: the file downloaded fine and is
      // more useful watermarked than discarded.
      log.warn('ffmpeg is unavailable; the file was saved without post-processing');
      return {
        sourceStrategy: input.sourceStrategy,
        watermarkRemoved: false,
        outroTrimmedMs: null,
        usedStaticFallback: false,
        reEncoded: false,
        notes: ['ffmpeg unavailable; saved unprocessed'],
      };
    }

    const durationMs = input.durationMs ?? 0;
    const frameWidth = input.frameWidth ?? 1_080;
    const frameHeight = input.frameHeight ?? 1_920;

    let watermarkPlan: WatermarkPlan | null = null;
    if (needsWatermarkWork) {
      const samples = await sampleWatermarkRegions(input.filePath, durationMs, {
        ffmpegPath,
        runner: this.options.runner,
        log,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      watermarkPlan = detectWatermark({
        samples,
        durationMs,
        frameWidth,
        frameHeight,
        removelogoAvailable: input.capabilities.filters['removelogo'] === true,
      });
      notes.push(watermarkPlan.reason);
      log.info({ tier: watermarkPlan.tier, segments: watermarkPlan.segments.length }, watermarkPlan.reason);
    }

    /**
     * Outro detection only runs on watermarked sources (section 9).
     *
     * The end card and the watermark come from the same place: TikTok's
     * `download_addr` variant, the one built for sharing. The clean
     * `play_addr` stream is the raw upload and carries neither, so trimming it
     * would mean decoding and re-encoding a file that is already correct, for
     * a cut that has nothing to remove — and every extra pass is another chance
     * to take three seconds of someone's actual video.
     */
    let outroTrimmedMs: number | null = null;
    let outroCutAtMs: number | null = null;

    if (input.outroMode !== 'never' && input.sourceStrategy === 'clean_source') {
      log.info('clean source: no end card to trim');
    }

    if (input.outroMode !== 'never' && input.sourceStrategy !== 'clean_source') {
      const signals = await sampleOutroSignals(input.filePath, durationMs, {
        ffmpegPath,
        runner: this.options.runner,
        log,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      if (signals) {
        const decision = detectOutro({ signals, durationMs });
        notes.push(decision.reason);

        if (decision.trim && decision.cutAtMs !== null) {
          const confirmed =
            input.outroMode === 'always' ||
            (await input.confirmOutro?.({
              cutAtMs: decision.cutAtMs,
              trimmedMs: decision.trimmedMs,
              confidence: decision.confidence,
            })) === true;

          if (confirmed) {
            outroCutAtMs = decision.cutAtMs;
            outroTrimmedMs = decision.trimmedMs;
          } else {
            notes.push('outro left in place by choice');
          }
        }
      }
    }

    if (!watermarkPlan && outroCutAtMs === null) {
      return {
        sourceStrategy: input.sourceStrategy,
        watermarkRemoved: input.sourceStrategy === 'clean_source',
        outroTrimmedMs: null,
        usedStaticFallback: false,
        reEncoded: false,
        notes,
      };
    }

    const reEncoding = watermarkPlan !== null;
    const encoder = reEncoding
      ? (input.encoders?.[0] ?? selectEncoder(input.capabilities, input.hardwareAcceleration))
      : null;
    if (encoder) {
      notes.push(encoder.reason);
      input.onEstimate?.(estimateProcessingMs(durationMs, encoder));
    }

    // Keyframes are only needed when a trim is actually happening.
    let trimPlan: ReturnType<typeof planTrim> | null = null;
    if (outroCutAtMs !== null) {
      const keyframes = await this.readKeyframes(input.filePath, ffmpegPath, input.signal);
      trimPlan = planTrim(outroCutAtMs, keyframes, reEncoding);
      notes.push(trimPlan.reason);
      outroTrimmedMs = Math.max(0, durationMs - trimPlan.cutAtMs);
    }

    await this.runFfmpeg({
      input,
      ffmpegPath,
      watermarkPlan,
      trimPlan,
      encoder,
      frameWidth,
      frameHeight,
    });

    return {
      sourceStrategy: watermarkPlan ? tierToStrategy(watermarkPlan) : input.sourceStrategy,
      watermarkRemoved: watermarkPlan !== null,
      outroTrimmedMs,
      usedStaticFallback: watermarkPlan?.tier === 'static-blur',
      reEncoded: reEncoding,
      notes,
    };
  }

  /** Keyframe timestamps in milliseconds, for a lossless cut point. */
  private async readKeyframes(filePath: string, ffmpegPath: string, signal?: AbortSignal): Promise<number[]> {
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (match) => match.replace('ffmpeg', 'ffprobe'));
    try {
      const result = await this.options.runner.run(
        ffprobePath,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-skip_frame', 'nokey',
          '-show_entries', 'frame=pts_time',
          '-of', 'csv=p=0',
          filePath,
        ],
        { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
      );
      if (result.exitCode !== 0) return [];
      return result.stdout
        .split('\n')
        .map((line) => Number(line.trim().replace(/,$/, '')))
        .filter((value) => Number.isFinite(value))
        .map((seconds) => Math.round(seconds * 1_000));
    } catch {
      // Without keyframes a lossless cut cannot be planned; planTrim handles
      // the empty list by declining to trim rather than guessing.
      return [];
    }
  }

  private async runFfmpeg(context: {
    input: PostProcessInput;
    ffmpegPath: string;
    watermarkPlan: WatermarkPlan | null;
    trimPlan: ReturnType<typeof planTrim> | null;
    encoder: ReturnType<typeof selectEncoder> | null;
    frameWidth: number;
    frameHeight: number;
  }): Promise<void> {
    const { input, watermarkPlan, trimPlan, encoder, frameWidth, frameHeight } = context;
    const extension = extname(input.filePath) || '.mp4';
    const outputPath = join(dirname(input.filePath), `.postprocess-${Date.now()}${extension}`);
    const maskPaths: string[] = [];

    const args = ['-v', 'error'];
    if (trimPlan && trimPlan.mode === 'stream-copy' && !watermarkPlan) {
      // Seeking before -i is faster and, for a keyframe-aligned copy, exact.
      args.push('-i', input.filePath, '-t', (trimPlan.cutAtMs / 1_000).toFixed(3), '-c', 'copy');
    } else {
      args.push('-i', input.filePath);

      if (watermarkPlan) {
        const graph = this.buildGraph(watermarkPlan, frameWidth, frameHeight, maskPaths, input.filePath);
        if (watermarkPlan.tier === 'removelogo') {
          // Sharpening chains onto the end, so it acts on the repaired frame
          // rather than on the watermark that is about to be painted over.
          args.push('-vf', input.sharpen ? `${graph},${input.sharpen}` : graph);
        } else {
          args.push(
            '-filter_complex',
            input.sharpen ? `${graph};[vout]${input.sharpen}[vsharp]` : graph,
            '-map',
            input.sharpen ? '[vsharp]' : '[vout]',
            '-map',
            '0:a?',
          );
        }
      }
      // Deliberately no `else` here. An encoder is only selected when there is
      // a watermark plan, so with no plan this pass is a stream copy — and a
      // filter on a copied stream is not a slower encode, it is an ffmpeg
      // error. Those videos are sharpened in the finishing pass instead, which
      // is encoding anyway.

      if (trimPlan) args.push('-t', (trimPlan.cutAtMs / 1_000).toFixed(3));

      if (encoder) {
        args.push('-c:v', encoder.name, ...applyQuality(encoder.args, input.encodeQuality ?? 'balanced'), '-c:a', 'copy');
      } else {
        args.push('-c', 'copy');
      }
    }

    args.push('-movflags', '+faststart', '-y', outputPath);

    try {
      const result = await this.options.runner.run(context.ffmpegPath, args, {
        timeoutMs: 15 * 60_000,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      if (result.exitCode !== 0) {
        rmSync(outputPath, { force: true });
        throw new AppError(
          'FFMPEG_FAILED',
          `post-processing failed: ${result.stderr.trim().slice(0, 400) || `exit ${result.exitCode}`}`,
        );
      }

      // A zero exit with no output is rare but real — a filter graph that
      // produces no frames, or a write that silently failed. Renaming here
      // would throw a raw ENOENT; this reports it as what it is.
      if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
        throw new AppError('FFMPEG_FAILED', 'post-processing reported success but produced no output file');
      }

      // Replace only after ffmpeg succeeded, so a failure leaves the original
      // intact rather than a half-written file under the user's filename.
      renameSync(outputPath, input.filePath);
    } finally {
      rmSync(outputPath, { force: true });
      for (const mask of maskPaths) rmSync(mask, { force: true });
    }
  }

  private buildGraph(
    plan: WatermarkPlan,
    frameWidth: number,
    frameHeight: number,
    maskPaths: string[],
    filePath: string,
  ): string {
    if (plan.tier === 'removelogo') {
      const segments = plan.segments.map((segment, index) => {
        const box = insetBoxFromEdges(segment.box, frameWidth, frameHeight);
        const maskPath = join(dirname(filePath), `.mask-${Date.now()}-${index}.pgm`);
        writeFileSync(maskPath, buildMaskPgm(frameWidth, frameHeight, [box]));
        maskPaths.push(maskPath);
        return { ...segment, box, maskPath };
      });
      return buildRemovelogoGraph(segments);
    }

    if (plan.tier === 'blur') return buildBlurGraph(plan.segments);
    return buildStaticBlurGraph(allPixelBoxes(frameWidth, frameHeight));
  }
}

function tierToStrategy(plan: WatermarkPlan): SourceStrategy {
  return plan.tier === 'removelogo' ? 'removelogo' : 'blur';
}
