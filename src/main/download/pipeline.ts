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
import { embedMetadata, saveThumbnail, writeSidecar } from './metadata-writer';
import { assertEnoughSpace } from './disk-space';

/**
 * The download pipeline — spec section 9 steps 4-11.
 *
 * Order is not arbitrary. The file is written to `{target}.part`, verified
 * while still named `.part`, and only then renamed into place. Anything that
 * fails leaves either a resumable `.part` or nothing at all, so the final
 * filename never appears over bytes that were not checked.
 *
 * Post-processing (watermark filtering, outro trimming) is phase 5. This
 * deliberately records `source_strategy` from stream selection alone, which is
 * accurate today: a clean source needs no work, and a watermarked one is
 * recorded as 'raw' until the filtering tiers exist to change it.
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
}

export class DownloadPipeline implements MediaPipeline {
  constructor(private readonly options: DownloadPipelineOptions) {}

  async process(input: PipelineInput): Promise<PipelineResult> {
    const config = this.options.config();
    const log = this.options.log.child({ awemeId: input.normalized.awemeId });

    // 1. Pick the stream. Clean beats watermarked before resolution is even
    //    considered (section 9 step 4).
    const selection = selectStream(input.resolved.streams, {
      qualityPreference: config.qualityPreference,
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

    // 7. Everything past this point is best-effort: the download has already
    //    succeeded and must not be failed by an optional extra.
    const ffmpegPath = this.options.ffmpegPath();

    if (config.saveMetadataSidecar) {
      writeSidecar({
        filePath: targetPath,
        metadata: input.resolved.metadata,
        canonicalUrl: input.normalized.canonicalUrl,
        rawUrl: input.item.raw_url,
        sourceStrategy: selection.strategy,
        extractor: input.resolved.extractor,
        log,
      });
    }

    if (config.saveThumbnail) {
      await saveThumbnail({
        filePath: targetPath,
        coverUrl: input.resolved.metadata.coverUrl,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        signal: input.signal,
        log,
      });
    }

    await embedMetadata({
      filePath: targetPath,
      metadata: input.resolved.metadata,
      canonicalUrl: input.normalized.canonicalUrl,
      ffmpegPath,
      runner: this.options.runner,
      log,
      signal: input.signal,
    });

    const [sha256, phash] = await Promise.all([
      sha256File(targetPath).catch(() => null),
      computePerceptualHash({
        filePath: targetPath,
        ffmpegPath,
        runner: this.options.runner,
        durationMs: input.resolved.metadata.durationMs,
        log,
        signal: input.signal,
      }),
    ]);

    const finalSize = existsSync(targetPath) ? verified.sizeBytes : null;

    log.info({ targetPath, strategy: selection.strategy, bytes: finalSize }, 'download complete');

    return {
      filePath: targetPath,
      fileSize: finalSize,
      sha256,
      phash,
      sourceStrategy: selection.strategy,
      // Nothing has been stripped yet; a clean source simply never had one.
      watermarkRemoved: selection.strategy === 'clean_source',
      outroTrimmedMs: null,
    };
  }
}

function pickExtension(streamExt: string | null, audioOnly: boolean): string {
  if (audioOnly) return streamExt && streamExt !== 'mp4' ? `.${streamExt}` : '.m4a';
  return streamExt ? `.${streamExt}` : '.mp4';
}

export { partPathFor };
