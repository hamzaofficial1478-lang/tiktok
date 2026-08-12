import { existsSync } from 'node:fs';
import type { Logger } from 'pino';
import { AppError, toAppError } from '@shared/errors';
import type { AppConfig } from '@shared/config-schema';
import type { ProcessRunner } from '../resolve/process-runner';
import type { Ffprobe } from '../media/ffprobe';
import type { MediaPipeline, PipelineInput, PipelineResult } from '../queue/types';
import { selectStream } from './stream-selector';
import { commitPart, discardPart, downloadToPart, partPathFor } from './downloader';
import { verifyDownload } from './verify';
import { renderTemplate, resolveOutputPath } from './filename';
import { computePerceptualHash, sha256File } from './hashing';
import { assertEnoughSpace } from './disk-space';
import type { PostProcessor } from '../postprocess/processor';
import type { MediaCapabilities } from '@shared/ipc/contract';
import { EMPTY_CAPABILITIES } from '../media/capabilities';

/**
 * The download pipeline — spec section 9 steps 4-11.
 *
 * Order is not arbitrary. The file is written to `{target}.part`, verified
 * while still named `.part`, and only then renamed into place. Anything that
 * fails leaves either a resumable `.part` or nothing at all, so the final
 * filename never appears over bytes that were not checked.
 *
 * Post-processing runs after the file is in place but before hashing and
 * metadata, since it can rewrite the file. `source_strategy` records what
 * actually happened to the bytes, not what was hoped for.
 */
export interface DownloadPipelineOptions {
  readonly config: () => AppConfig;
  readonly runner: ProcessRunner;
  readonly ffprobe: Ffprobe;
  readonly ffmpegPath: () => string | null;
  readonly log: Logger;
  readonly fetchImpl?: typeof fetch;
  /** Overridable so tests can point at a temp directory. */
  readonly outputDir?: () => string;
  /** Phase 5. Absent means downloads are saved exactly as fetched. */
  readonly postProcessor?: PostProcessor;
  /** Probed ffmpeg capabilities, for encoder and filter availability. */
  readonly capabilities?: () => MediaCapabilities;
  /** Section 9's "Ask on first detection" prompt; resolved by the UI. */
  readonly confirmOutro?: (proposal: {
    cutAtMs: number;
    trimmedMs: number;
    confidence: number;
  }) => Promise<boolean>;
}

export class DownloadPipeline implements MediaPipeline {
  constructor(private readonly options: DownloadPipelineOptions) {}

  async process(input: PipelineInput): Promise<PipelineResult> {
    const config = this.options.config();
    const log = this.options.log.child({ awemeId: input.normalized.awemeId });

    // 1. Pick the stream. Clean beats watermarked before resolution is even
    //    considered (section 9 step 4).
    const selection = selectStream(input.resolved.streams, {
      audioOnly: config.audioOnly,
      watermarkMode: config.watermarkMode,
    });
    log.info({ stream: selection.stream.id, strategy: selection.strategy }, selection.reason);

    const directory = this.options.outputDir?.() ?? config.outputDir;
    if (!directory) throw new AppError('PERMISSION_DENIED', 'no output folder has been chosen yet');

    // 2. Fail fast rather than part-way through (section 9 step 5).
    if (selection.stream.filesize) assertEnoughSpace(directory, selection.stream.filesize);

    // 3. Work out the final name now, so the `.part` sits beside its
    //    destination and the atomic rename is a same-filesystem move.
    const extension = pickExtension(selection.stream.ext, config.audioOnly);
    const basename = renderTemplate(config.filenameTemplate, {
      metadata: input.resolved.metadata,
      awemeId: input.normalized.awemeId,
      index: input.item.position,
      batchIndex: input.item.batch_index,
      extension,
    });
    const targetPath = resolveOutputPath({
      directory,
      basename,
      extension,
      // 'replace' is dedup layer 3's Replace existing; everything else must
      // not clobber a file that is already there.
      onCollision: input.duplicateAction === 'replace' ? 'replace' : 'suffix',
    });

    // 4. Download to `.part`.
    const outcome = await downloadToPart({
      url: selection.stream.url,
      targetPath,
      signal: input.signal,
      expectedBytes: selection.stream.filesize,
      skipSpaceCheck: true,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      onProgress: (progress) =>
        input.onProgress({
          bytesDone: progress.bytesDone,
          bytesTotal: progress.bytesTotal,
          speed: progress.speed,
          etaMs: progress.etaMs,
        }),
    });
    if (outcome.resumedFrom > 0) log.info({ resumedFrom: outcome.resumedFrom }, 'resumed an interrupted download');

    // 5. Verify while it is still a `.part` (section 9 step 7).
    let verified;
    try {
      verified = await verifyDownload({
        filePath: outcome.partPath,
        expectedDurationMs: input.resolved.metadata.durationMs,
        audioOnly: config.audioOnly,
        ffprobe: this.options.ffprobe,
        signal: input.signal,
      });
    } catch (err) {
      // A file that failed verification is worse than no file: discard it so a
      // retry starts clean instead of resuming corrupt bytes.
      discardPart(targetPath);
      throw toAppError(err, 'VERIFY_FAILED');
    }

    if (verified.degraded) {
      log.warn('ffprobe is unavailable; the file was saved with only a size check');
    }

    // 6. Only now does the final filename come into existence.
    input.onProgress({
      bytesDone: outcome.bytes,
      bytesTotal: outcome.bytes,
      speed: null,
      etaMs: 0,
      processing: true,
    });
    commitPart(outcome.partPath, targetPath);

    /**
     * 7. Post-processing (phase 5).
     *
     * Runs before hashing and metadata, because it can rewrite the file: a
     * SHA-256 taken beforehand would describe bytes that no longer exist, and
     * tags written beforehand would be discarded by the remux.
     *
     * A failure here does not fail the item. The download succeeded and the
     * file is watchable; losing it because a filter chain misbehaved would be
     * a worse outcome than keeping it with its watermark.
     */
    let strategy = selection.strategy;
    let watermarkRemoved = selection.strategy === 'clean_source';
    let outroTrimmedMs: number | null = null;

    if (this.options.postProcessor) {
      try {
        const processed = await this.options.postProcessor.process({
          filePath: targetPath,
          durationMs: input.resolved.metadata.durationMs,
          frameWidth: selection.stream.width,
          frameHeight: selection.stream.height,
          sourceStrategy: selection.strategy,
          watermarkMode: config.watermarkMode,
          outroMode: config.outroMode,
          hardwareAcceleration: config.hardwareAcceleration,
          capabilities: this.options.capabilities?.() ?? EMPTY_CAPABILITIES,
          signal: input.signal,
          ...(this.options.confirmOutro ? { confirmOutro: this.options.confirmOutro } : {}),
          onEstimate: (estimatedMs) =>
            input.onProgress({
              bytesDone: outcome.bytes,
              bytesTotal: outcome.bytes,
              speed: null,
              etaMs: estimatedMs,
              processing: true,
            }),
        });

        strategy = processed.sourceStrategy;
        watermarkRemoved = processed.watermarkRemoved || watermarkRemoved;
        outroTrimmedMs = processed.outroTrimmedMs;
        for (const note of processed.notes) log.info({ note }, 'post-processing');
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'post-processing failed; keeping the unprocessed file',
        );
      }
    }


    /**
     * Nothing else touches the file.
     *
     * Metadata tags, a JSON sidecar and a saved thumbnail were all removed:
     * tagging meant remuxing the entire file with ffmpeg and the thumbnail
     * meant a second HTTP request, both per video. Everything they carried is
     * already in the library database, so nothing is lost and the common path
     * now finishes the moment the bytes land.
     */
    // SHA-256 is a streaming read of bytes already on disk, so it is cheap.
    // The perceptual hash is not: it decodes the video again with ffmpeg, so
    // it only runs when repost detection is explicitly turned on.
    const sha256 = await sha256File(targetPath).catch(() => null);
    const phash = config.detectReposts
      ? await computePerceptualHash({
          filePath: targetPath,
          ffmpegPath: this.options.ffmpegPath(),
          runner: this.options.runner,
          durationMs: input.resolved.metadata.durationMs,
          log,
          signal: input.signal,
        })
      : null;

    const finalSize = existsSync(targetPath) ? verified.sizeBytes : null;

    log.info({ targetPath, strategy, watermarkRemoved, outroTrimmedMs, bytes: finalSize }, 'download complete');

    return {
      filePath: targetPath,
      fileSize: finalSize,
      sha256,
      phash,
      // Reflects what actually happened: 'clean_source' when nothing needed
      // doing, 'removelogo'/'blur' when a tier ran, 'raw' when the watermark
      // was kept by preference.
      sourceStrategy: strategy,
      watermarkRemoved,
      outroTrimmedMs,
    };
  }
}

function pickExtension(streamExt: string | null, audioOnly: boolean): string {
  if (audioOnly) return streamExt && streamExt !== 'mp4' ? `.${streamExt}` : '.m4a';
  return streamExt ? `.${streamExt}` : '.mp4';
}

export { partPathFor };
