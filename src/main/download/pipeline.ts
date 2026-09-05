import { existsSync, rmSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
import { AppError, toAppError } from '@shared/errors';
import type { AppConfig } from '@shared/config-schema';
import type { ProcessRunner } from '../resolve/process-runner';
import type { Ffprobe, ProbeResult } from '../media/ffprobe';
import type { MediaPipeline, PipelineInput, PipelineResult } from '../queue/types';
import { selectStream } from './stream-selector';
import { commitPart, discardPart, downloadToPart, partPathFor } from './downloader';
import { downloadWithYtDlp } from './yt-dlp-downloader';
import { downloadPhotoPost } from './photo-post';
import type { YtDlpStrategy } from '../resolve/yt-dlp-extractor';
import { verifyDownload } from './verify';
import { makeUploadable } from './mp4-compat';
import { renderTemplate, resolveOutputPath, resolveOutputDirectory } from './filename';
import { computePerceptualHash, sha256File } from './hashing';
import { assertEnoughSpace } from './disk-space';
import type { PostProcessor } from '../postprocess/processor';
import type { MediaCapabilities } from '@shared/ipc/contract';
import { EMPTY_CAPABILITIES } from '../media/capabilities';
import { applyCaptions, type Transcriber } from '../captions/caption-step';
import { subtitleLanguages } from '../captions/tiktok-tracks';
import { workPathFor } from './yt-dlp-downloader';
import { writeSeoSidecar } from '../metadata/sidecar';
import { encoderCandidates, selectEncoder, type EncoderChoice } from '../postprocess/encoder';
import type { EncoderProbe } from '../postprocess/encoder-probe';
import { applyQuality, sharpenFilter } from '../postprocess/enhance';
import { measureColour, planColourCorrection } from '../postprocess/colour';
import { StageTracker } from './stage-tracker';

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
import { CAPTION_MODES, type CaptionMode } from '@shared/caption-schema';

export interface DownloadPipelineOptions {
  readonly config: () => AppConfig;
  readonly runner: ProcessRunner;
  readonly ffprobe: Ffprobe;
  readonly ffmpegPath: () => string | null;
  readonly log: Logger;
  readonly fetchImpl?: typeof fetch;
  /** yt-dlp path; when present it performs the transfer (see step 4). */
  readonly ytDlpPath?: () => string | null;
  /**
   * The routes the download may fall back to, read fresh so it uses the same
   * list resolution does. Empty means "only the route that resolved it".
   */
  readonly downloadStrategies?: () => readonly YtDlpStrategy[];
  readonly proxyUrl?: () => string | undefined;
  /**
   * The browser the transfer should look like at the TLS layer, or null.
   *
   * Must be the same answer the extraction used: TikTok checks the handshake,
   * and resolving as a browser then downloading as something else is the split
   * that produces a successful resolve followed by a dropped connection.
   */
  readonly impersonate?: () => Promise<string | null>;
  /** Overridable so tests can point at a temp directory. */
  readonly outputDir?: () => string;
  /** Phase 5. Absent means downloads are saved exactly as fetched. */
  readonly postProcessor?: PostProcessor;
  /** Probed ffmpeg capabilities, for encoder and filter availability. */
  readonly capabilities?: () => MediaCapabilities;
  /**
   * Which of those encoders this machine can actually run.
   *
   * `capabilities` reports what ffmpeg was *compiled* with, which on the LGPL
   * builds this app installs includes NVENC, QuickSync, AMF and VAAPI on every
   * computer regardless of the hardware in it. Absent, the pipeline falls back
   * to trusting that list, which is what the tests and the CLI harness do.
   */
  readonly encoderProbe?: EncoderProbe;
  /** Speech-to-text for videos TikTok published no caption track for. */
  readonly transcriber?: Transcriber;
  /** Section 9's "Ask on first detection" prompt; resolved by the UI. */
  readonly confirmOutro?: (proposal: {
    cutAtMs: number;
    trimmedMs: number;
    confidence: number;
  }) => Promise<boolean>;
}

/**
 * Routes for the download to try, best first.
 *
 * The route that resolved the video leads, since it is the one just proven to
 * work. The rest follow because the download re-extracts, and TikTok's web
 * path in particular can refuse the next request after answering the last one
 * — which is exactly how a resolve at 20:57:45 was followed by a download
 * failure at 20:57:55 on the same route.
 *
 * Session arguments already sit inside the resolved route, so they are carried
 * onto the alternatives rather than being dropped when one is tried.
 */
export function downloadRoutes(
  resolvedArgs: readonly string[] | undefined,
  strategies: readonly YtDlpStrategy[] = [],
): readonly (readonly string[])[] {
  const primary = resolvedArgs ?? [];
  // Whatever is not an --extractor-args pair is session state: cookies, IPv4.
  const session: string[] = [];
  for (let i = 0; i < primary.length; i++) {
    if (primary[i] === '--extractor-args') {
      i++;
      continue;
    }
    session.push(primary[i] as string);
  }

  const seen = new Set<string>([primary.join(' ')]);
  const routes: (readonly string[])[] = [primary];

  for (const strategy of strategies) {
    const candidate = [...strategy.args, ...session];
    const key = candidate.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(candidate);
  }
  return routes;
}

export class DownloadPipeline implements MediaPipeline {
  constructor(private readonly options: DownloadPipelineOptions) {}

  async process(input: PipelineInput): Promise<PipelineResult> {
    const config = this.options.config();
    const log = this.options.log.child({ awemeId: input.normalized.awemeId });

    // A slideshow the user agreed to take. Its own path, because there is no
    // stream to select, nothing to probe and no watermark to remove.
    if (input.photoPost) return this.processPhotoPost(input, config, log);

    /**
     * 0. Is the video already here from an attempt that fell over afterwards?
     *
     * Decided before anything else, because the answer changes what the rest of
     * this method does: a usable file means no transfer, no new filename, and
     * no repeat of the steps that already ran on it. An unusable one — or none
     * at all — means the note is thrown away wholesale rather than half-trusted,
     * so a fresh download does every step again instead of skipping the ones a
     * dead file's note claimed.
     */
    const resumed = await this.reopen(input, config, log);

    const stages = new StageTracker({
      resume: resumed ? input.resume : undefined,
      onStage: input.onStage,
      onResumable: input.onResumable,
    });

    // 1. Keep the best picture; prefer a clean source at equal resolution.
    const selection = selectStream(input.resolved.streams, {
      audioOnly: config.audioOnly,
      watermarkMode: config.watermarkMode,
      // Joining a video-only stream to its audio is ffmpeg's job, so without
      // ffmpeg the selector must not choose one it cannot assemble.
      canMerge: this.options.ffmpegPath() !== null,
      forceH264: config.forceH264,
    });
    log.info({ stream: selection.stream.id, strategy: selection.strategy }, selection.reason);

    const root = this.options.outputDir?.() ?? config.outputDir;
    if (!root) throw new AppError('PERMISSION_DENIED', 'no output folder has been chosen yet');

    /**
     * An account queued from a profile link gets its own folder.
     *
     * The name comes from a TikTok handle, which is remote input — so it goes
     * through the same sanitiser filenames do, and the result is checked to be
     * inside the output folder before anything is written. A handle of "../.."
     * is not a plausible accident, but "the path came from a remote response
     * and was joined without checking" is exactly the shape of a real one.
     */
    const directory = resolveOutputDirectory(root, subdirFor(input, config));

    // 2. Fail fast rather than part-way through (section 9 step 5).
    if (!resumed && selection.stream.filesize) assertEnoughSpace(directory, selection.stream.filesize);

    /**
     * 3. Work out the final name now, so the `.part` sits beside its
     *    destination and the atomic rename is a same-filesystem move.
     *
     * A resumed attempt keeps the name the file already has. Asking
     * `resolveOutputPath` again would find that very file, decide it was
     * somebody else's, and pick the next free name — which is the second half
     * of how one video ended up on disk twice.
     */
    const targetPath =
      resumed?.targetPath ??
      (() => {
        const extension = pickExtension(selection.stream.ext, config.audioOnly);
        const basename = renderTemplate(config.filenameTemplate, {
          metadata: input.resolved.metadata,
          awemeId: input.normalized.awemeId,
          index: input.item.position,
          batchIndex: input.item.batch_index,
          extension,
        });
        return resolveOutputPath({
          directory,
          basename,
          extension,
          // 'replace' is dedup layer 3's Replace existing; everything else must
          // not clobber a file that is already there.
          onCollision: input.duplicateAction === 'replace' ? 'replace' : 'suffix',
        });
      })();

    // 4. Download to `.part` — see `transfer` below.
    const progressSink = (progress: {
      bytesDone: number;
      bytesTotal: number | null;
      speed: number | null;
      etaMs: number | null;
    }): void =>
      input.onProgress({
        bytesDone: progress.bytesDone,
        bytesTotal: progress.bytesTotal,
        speed: progress.speed,
        etaMs: progress.etaMs,
      });

    /**
     * The transfer, and the check that gates the final filename.
     *
     * Both are skipped outright when a previous attempt already got this far:
     * they are the expensive half of the job, they are the half that talks to
     * TikTok, and repeating them for a file that is already on disk is the
     * literal definition of downloading the same video twice.
     */
    let verified: Awaited<ReturnType<typeof verifyDownload>>;
    let bytes: number;

    if (resumed) {
      stages.skip('download');
      stages.skip('verify');
      verified = resumed.verified;
      bytes = resumed.verified.sizeBytes;
      stages.committed(targetPath, bytes);
      // So the row does not drop back to 0% on a retry of a video that is
      // sitting there complete.
      input.onProgress({ bytesDone: bytes, bytesTotal: bytes, speed: null, etaMs: 0, processing: true });
      log.info({ targetPath, alreadyDone: input.resume?.done ?? [] }, 'picking up where the last attempt stopped');
    } else {
      stages.start('download');
      const outcome = await this.transfer(input, config, selection, targetPath, progressSink, log);
      input.signal.throwIfAborted();
      if (outcome.resumedFrom > 0) log.info({ resumedFrom: outcome.resumedFrom }, 'resumed an interrupted download');
      stages.done('download');

      // 5. Verify while it is still a `.part` (section 9 step 7).
      stages.start('verify');
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
        stages.failed('verify');
        throw toAppError(err, 'VERIFY_FAILED');
      }

      if (verified.degraded) {
        log.warn('ffprobe is unavailable; the file was saved with only a size check');
      }

      /**
       * The file arrived silent when it was supposed to have sound.
       *
       * This is the check that would have caught the silent downloads on the day
       * they started rather than several batches later: the selector believed the
       * chosen stream carried audio, and ffprobe — looking at the actual bytes —
       * disagrees. Not fatal, because the video is watchable and re-downloading
       * would not fix a stream TikTok served without sound, but it belongs in the
       * log where a pattern of it is visible.
       */
      if (!config.audioOnly && verified.hasAudio === false) {
        log.warn(
          {
            stream: selection.stream.id,
            codec: selection.stream.codec,
            expectedAudio: selection.stream.hasAudio || selection.audioStream !== undefined,
          },
          selection.stream.hasAudio || selection.audioStream
            ? 'the finished file has no audio track, although the chosen stream was expected to carry one'
            : 'the finished file has no audio track, as expected for this post',
        );
      }

      // 6. Only now does the final filename come into existence.
      input.signal.throwIfAborted();
      bytes = outcome.bytes;
      input.onProgress({ bytesDone: bytes, bytesTotal: bytes, speed: null, etaMs: 0, processing: true });
      commitPart(outcome.partPath, targetPath);

      /**
       * Announced before anything that can still fail.
       *
       * Everything below this line is improvement to a video that already
       * exists, and every one of those steps can throw. When one did, the item
       * failed, the queue retried it, and the retry picked the next free
       * filename and downloaded the whole thing again — one video, two files.
       */
      stages.committed(targetPath, bytes);
      input.onCommitted?.(targetPath);
      // Banked last, so the note the next attempt reads is only written once
      // the file it names is genuinely at that path.
      stages.done('verify');
    }

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
    let strategy = stages.carried.sourceStrategy ?? selection.strategy;
    let watermarkRemoved = stages.carried.watermarkRemoved ?? selection.strategy === 'clean_source';
    let outroTrimmedMs: number | null = stages.carried.outroTrimmedMs ?? null;
    /**
     * Sharpening, and which pass gets to carry it.
     *
     * Whichever encode happens anyway should do it. A watermarked video is
     * already being re-encoded downstairs, so the filter goes into that graph;
     * anything else picks it up in the finishing pass. Both would be two
     * generations of loss for one job.
     */
    const sharpen = config.audioOnly ? null : sharpenFilter(config.sharpen);
    let watermarkReEncoded = false;

    /**
     * Colour, measured before it is corrected.
     *
     * The measurement is what makes this safe to offer. A fixed lift would
     * ruin the half of TikTok that is already heavily graded, so the video is
     * sampled and only what is actually missing is restored — and a video that
     * needs nothing returns no filter, which means no re-encode either.
     *
     * Measured again on a resumed attempt rather than remembered, because it is
     * an input to the two passes below and one of them is why the attempt is
     * happening. It is skipped only when both of those passes are already done,
     * since then there is nothing left for the answer to feed.
     */
    let colour: string | null = null;
    const needsColour = !stages.isDone('watermark') || !stages.isDone('finish');
    if (config.colourCorrection !== 'off' && !config.audioOnly && needsColour) {
      const ffmpegPath = this.options.ffmpegPath();
      if (ffmpegPath) {
        stages.start('colour');
        const stats = await measureColour(targetPath, {
          ffmpegPath,
          runner: this.options.runner,
          ...(input.signal ? { signal: input.signal } : {}),
          log,
        });
        const plan = planColourCorrection(stats, config.colourCorrection === 'strong' ? 1.6 : 1);
        colour = plan.filter;
        log.info({ stats, correction: plan.filter }, `colour: ${plan.reason}`);
        // `measureColour` answers null rather than throwing when it cannot read
        // the video, and a video it could not read is one it cannot correct.
        if (stats === null) stages.failed('colour');
        else stages.done('colour');
      }
    }

    /** One chain, so one encode does every job that wants doing. */
    const enhanceFilter = [colour, sharpen].filter(Boolean).join(',') || null;
    input.signal.throwIfAborted();

    if (stages.isDone('watermark')) {
      stages.skip('watermark');
    } else if (this.options.postProcessor) {
      stages.start('watermark');
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
          // The ones this machine can genuinely run, so the watermark pass is
          // not handed an encoder that cannot open its device.
          encoders: await this.encoders(config),
          ...(enhanceFilter ? { sharpen: enhanceFilter } : {}),
          encodeQuality: config.encodeQuality,
          signal: input.signal,
          ...(this.options.confirmOutro ? { confirmOutro: this.options.confirmOutro } : {}),
          onEstimate: (estimatedMs) =>
            input.onProgress({
              bytesDone: bytes,
              bytesTotal: bytes,
              speed: null,
              etaMs: estimatedMs,
              processing: true,
            }),
        });

        strategy = processed.sourceStrategy;
        watermarkRemoved = processed.watermarkRemoved || watermarkRemoved;
        outroTrimmedMs = processed.outroTrimmedMs;
        watermarkReEncoded = processed.reEncoded;
        for (const note of processed.notes) log.info({ note }, 'post-processing');
        stages.done('watermark', { sourceStrategy: strategy, watermarkRemoved, outroTrimmedMs });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'post-processing failed; keeping the unprocessed file',
        );
        // Not banked: it did not happen, so a later attempt should try it
        // rather than skip it.
        stages.failed('watermark');
      }
    }

    /**
     * 8. Captions, and the title and description written from them.
     *
     * After post-processing, because burning captions onto a frame that is
     * about to be re-encoded for watermark removal would put them through a
     * second generation of compression for nothing.
     *
     * Like post-processing, a failure here does not fail the item: the video is
     * downloaded and watchable, and losing it because a filter chain misbehaved
     * would be the worse outcome by far.
     */
    /**
     * What is still wrong with the finished file, from the upload sites' point
     * of view. Empty when nothing is, which is the ordinary case.
     */
    let uploadProblems: readonly string[] = [];
    let captionNote: string | null = stages.carried.captionNote ?? null;
    let transcriptCues: readonly { startMs: number; endMs: number; lines: readonly string[] }[] = [];

    /**
     * The item's own caption choice wins over the app's.
     *
     * Set when a creator with an override queued this link; null for anything
     * pasted by hand, which then follows the app setting as before. Validated
     * against the known modes rather than trusted — it is a text column.
     */
    const captionSettings =
      input.item.caption_mode && (CAPTION_MODES as readonly string[]).includes(input.item.caption_mode)
        ? { ...config.captions, mode: input.item.caption_mode as CaptionMode }
        : config.captions;

    input.signal.throwIfAborted();
    if (stages.isDone('captions')) {
      stages.skip('captions');
    } else if (captionSettings.mode !== 'off' || config.seoMetadata) {
      stages.start('captions');
      let burned = true;
      try {
        const captions = await applyCaptions({
          filePath: targetPath,
          // The tracks yt-dlp wrote share the stem of the file it wrote to.
          mediaStemPath: workPathFor(targetPath),
          settings: captionSettings,
          frameWidth: selection.stream.width,
          frameHeight: selection.stream.height,
          durationMs: input.resolved.metadata.durationMs,
          ffmpegPath: this.options.ffmpegPath(),
          runner: this.options.runner,
          /**
           * Chosen from what this ffmpeg build actually contains.
           *
           * Hard-coding libx264 here would fail on the LGPL build the app
           * installs, which deliberately excludes it — the same encoder
           * selection watermark removal already uses is the right source of
           * truth, and it respects the hardware-acceleration setting too.
           */
          encoderArgs: (() => {
            const encoder = selectEncoder(
              this.options.capabilities?.() ?? EMPTY_CAPABILITIES,
              config.hardwareAcceleration,
            );
            return [encoder.name, ...encoder.args];
          })(),
          ...(this.options.transcriber ? { transcriber: this.options.transcriber } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          log,
        });

        transcriptCues = captions.cues;
        captionNote = captions.skipped;
        if (captions.applied) {
          log.info({ source: captions.source, cues: captions.cueCount }, 'captions added');
        } else if (captions.skipped && captionSettings.mode !== 'off') {
          log.info({ reason: captions.skipped }, 'no captions were added');
        }
      } catch (err) {
        burned = false;
        captionNote = err instanceof Error ? err.message : String(err);
        log.warn({ err: captionNote }, 'captioning failed; the video was kept without captions');
      }

      if (config.seoMetadata) {
        try {
          const written = writeSeoSidecar({
            videoPath: targetPath,
            cues: transcriptCues,
            metadata: input.resolved.metadata,
          });
          log.info({ sidecar: written.path, score: written.seo.score.total }, 'wrote a title and description');
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not write the title sidecar');
        }
      }

      if (burned) stages.done('captions', { captionNote });
      else stages.failed('captions');
    }

    /**
     * 9. Make the container acceptable to something other than a local player.
     *
     * Last, because it has to describe the file as it finally is: watermark
     * removal and burned-in captions both rewrite it, and a check run before
     * them would be answering about bytes that no longer exist.
     *
     * Nothing here re-encodes and nothing here can fail the item — see
     * mp4-compat.ts for what it looks at and why. It usually does nothing at
     * all: a video ffmpeg has already rewritten comes out correct, and this is
     * for the common case where nothing needed processing and the file is
     * exactly as TikTok served it.
     */
    input.signal.throwIfAborted();
    if (stages.isDone('finish')) {
      stages.skip('finish');
    } else if (!config.audioOnly) {
      stages.start('finish');
      try {
        const compat = await makeUploadable({
          filePath: targetPath,
          probe: verified.probe,
          ffmpegPath: this.options.ffmpegPath(),
          runner: this.options.runner,
          /**
           * Convert the codec, having already downloaded the best picture.
           *
           * Asking for H.264 used to mean asking for a smaller stream, because
           * TikTok publishes its top resolution only as H.265 for plenty of
           * videos. The conversion happens here instead, at the resolution
           * that was downloaded, with the same near-transparent encoder the
           * watermark path uses.
           */
          ...(config.forceH264 || (enhanceFilter !== null && !watermarkReEncoded)
            ? {
                toH264: {
                  encoders: (await this.encoders(config)).map((encoder) => ({
                    name: encoder.name,
                    args: applyQuality(encoder.args, config.encodeQuality),
                  })),
                },
              }
            : {}),
          /**
           * Read the file again, here and after the rewrite.
           *
           * `verified.probe` describes the `.part` from before the watermark
           * and caption passes touched it, so it is the wrong thing to decide
           * from and no basis at all for confirming the result.
           */
          reprobe: (path) => this.probeOrNull(path, input.signal),
          onEncoderFailed: (name) => this.options.encoderProbe?.reject(name),
          /**
           * Sharpening rides in this pass rather than one of its own.
           *
           * An H.265 file that also wants sharpening would otherwise be
           * decoded and encoded twice, and two generations of loss to do what
           * one pass can do is exactly the kind of quiet quality cost this
           * program has already been bitten by.
           *
           * A watermarked video never reaches here needing it: that path is
           * already re-encoding, so the filter goes into its graph instead.
           */
          ...(enhanceFilter !== null && !watermarkReEncoded ? { videoFilter: enhanceFilter } : {}),
          signal: input.signal,
          log,
        });
        if (compat.rewritten) log.info({ reason: compat.reason }, 'container rewritten for compatibility');

        /**
         * A file that is still in a form upload sites refuse is a failed step,
         * even though the download itself succeeded.
         *
         * This is the whole reason the check exists. The pass is caught so that
         * a misbehaving filter cannot cost somebody a video that downloaded
         * perfectly well — but the cost of that safety was that a conversion
         * which did not happen looked exactly like one that did, and the first
         * anybody knew was an upload refused days later with a message naming
         * nothing. Saying so on the row is the difference between "Facebook is
         * broken" and "the finishing pass could not convert this one".
         */
        if (enhanceFilter !== null && !watermarkReEncoded && !compat.rewritten) {
          log.warn({ reason: compat.reason }, 'enhancement could not be applied; the original video was kept');
          stages.failed('finish');
        } else if (compat.uploadable === false) {
          log.warn(
            { problems: compat.problems },
            'this video is still in a form upload sites refuse; see the finishing step on the row',
          );
          uploadProblems = compat.problems;
          stages.failed('finish');
        } else {
          stages.done('finish');
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'the compatibility pass failed; the download is kept as it is',
        );
        stages.failed('finish');
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
    /**
     * Past this point nothing may throw, and the reason is not tidiness.
     *
     * The file now exists under its final name. Throwing here fails the item,
     * the queue retries it, and the retry's `resolveOutputPath` sees the
     * committed file and picks the next free name — so a failure after the
     * bytes have landed does not produce an error, it produces a second copy of
     * the video. That is precisely how one download became three files on disk,
     * and the naming bug that triggered it is only the cheaper half of the fix:
     * anything that can fail after `commitPart` has to degrade to a null column
     * instead. Both hashes are optional metadata; neither is worth a duplicate.
     */
    stages.start('record');
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
        }).catch((err: unknown) => {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'perceptual hashing failed; the file is saved without one',
          );
          return null;
        })
      : null;

    const finalSize = existsSync(targetPath) ? statSync(targetPath).size : null;

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
      /**
       * Why captions were not applied, when they were asked for.
       *
       * This was computed and then thrown away — `void captionNote` — so a
       * video that came out without the captions someone had turned on gave no
       * reason anywhere a user would look. It rides back with the result now.
       */
      ...(captionNote ? { captionNote } : {}),
      ...(uploadProblems.length > 0
        ? { uploadNote: `Upload sites are likely to refuse this file: ${uploadProblems.join(', ')}.` }
        : {}),
    };
  }

  /**
   * The H.264 encoders worth trying on this machine, best first.
   *
   * A list rather than one choice, because the first can be a lie: an encoder
   * that is compiled into the build but has no hardware behind it fails the
   * moment it opens its device, and a single-choice API turned that into a
   * video that silently stayed H.265 and was refused by every upload form.
   *
   * With a probe it is the verified list. Without one — tests, the CLI harness
   * — it is the build's own answer, which is the behaviour that was there
   * before, and an empty list when the build has no H.264 encoder at all rather
   * than a throw that would take the download with it.
   */
  private async encoders(config: AppConfig): Promise<readonly EncoderChoice[]> {
    const capabilities = this.options.capabilities?.() ?? EMPTY_CAPABILITIES;

    if (this.options.encoderProbe) {
      return this.options.encoderProbe.usable(capabilities, config.hardwareAcceleration);
    }
    return encoderCandidates(capabilities, config.hardwareAcceleration);
  }

  /** ffprobe, or null — never a throw, since every caller degrades gracefully. */
  private async probeOrNull(filePath: string, signal?: AbortSignal): Promise<ProbeResult | null> {
    if (!this.options.ffprobe.isAvailable) return null;
    try {
      return await this.options.ffprobe.probe(filePath, signal);
    } catch {
      return null;
    }
  }

  /**
   * Reopens the file a previous attempt left, or decides there is not one.
   *
   * The note on the queue row says where the bytes are; this checks that the
   * claim is still true. A file that has been moved or deleted, or that no
   * longer reads as a video, means the note is worthless — and a worthless note
   * must be discarded whole, because half-believing it would skip the watermark
   * and caption passes on a video that is about to be downloaded fresh.
   */
  private async reopen(
    input: PipelineInput,
    config: AppConfig,
    log: Logger,
  ): Promise<{ targetPath: string; verified: Awaited<ReturnType<typeof verifyDownload>> } | null> {
    const resume = input.resume;
    if (!resume) return null;

    if (!existsSync(resume.filePath)) {
      log.warn({ filePath: resume.filePath }, 'the file the last attempt left is gone; downloading it again');
      return null;
    }

    try {
      /**
       * Duration is deliberately not re-checked.
       *
       * The check exists to catch a truncated transfer, and this file already
       * passed it once. Since then the outro trim may legitimately have made it
       * shorter than TikTok reported, so re-applying the original tolerance
       * would reject a correctly processed video as corrupt.
       */
      const verified = await verifyDownload({
        filePath: resume.filePath,
        expectedDurationMs: null,
        audioOnly: config.audioOnly,
        ffprobe: this.options.ffprobe,
        signal: input.signal,
      });
      return { targetPath: resume.filePath, verified };
    } catch (err) {
      // An abort is not a verdict on the file — it is the queue stopping — so
      // it must not be answered by deleting the file and starting over.
      if (input.signal.aborted) throw err;

      log.warn(
        { filePath: resume.filePath, err: err instanceof Error ? err.message : String(err) },
        'the file the last attempt left will not read; discarding it and downloading again',
      );
      // Removed rather than left: it is unreadable, this app wrote it minutes
      // ago, and leaving it would make the fresh download pick a second name
      // and sit beside a file nothing can play.
      rmSync(resume.filePath, { force: true });
      return null;
    }
  }

  /**
   * The transfer itself — yt-dlp performing it, not our own HTTP client.
   *
   * TikTok's CDN authenticates against the cookiejar yt-dlp builds while
   * solving the challenge during extraction — `_set_cookie(hostname, 'sid_tt',
   * …)` in its TikTok extractor — and that session is never serialised into the
   * JSON we parse. Fetching the stream URL ourselves, even replaying every
   * header the payload reports, is refused with 403. Handing the transfer to the
   * process that holds the session is the only way short of reimplementing
   * TikTok's challenge flow.
   *
   * The second branch is unreachable as the app ships today: yt-dlp is what
   * resolves the video, so an absent yt-dlp fails at extraction and never
   * arrives here. It is kept because section 2's extractor seam exists for a
   * second implementation, and that one may well hand back a URL needing no
   * session — but nothing currently exercises it outside its own tests.
   *
   * Worth stating because it has already misled a diagnosis: an error carrying
   * downloadToPart's wording ("the CDN refused the download with 403") cannot
   * have come from a run where yt-dlp was installed, and is therefore evidence
   * about which build produced a log, not about TikTok.
   *
   * It lives in its own method so the resume branch above reads as the single
   * decision it is: transfer, or do not.
   */
  private async transfer(
    input: PipelineInput,
    config: AppConfig,
    selection: ReturnType<typeof selectStream>,
    targetPath: string,
    onProgress: (progress: {
      bytesDone: number;
      bytesTotal: number | null;
      speed: number | null;
      etaMs: number | null;
    }) => void,
    log: Logger,
  ): ReturnType<typeof downloadToPart> {
    const ytDlpPath = this.options.ytDlpPath?.() ?? null;
    if (!ytDlpPath) {
      return downloadToPart({
        url: selection.stream.url,
        targetPath,
        signal: input.signal,
        expectedBytes: selection.stream.filesize,
        skipSpaceCheck: true,
        headers: selection.stream.headers,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        onProgress,
      });
    }

    return downloadWithYtDlp({
      binaryPath: ytDlpPath,
      runner: this.options.runner,
      url: input.normalized.canonicalUrl,
      formatId: selection.formatId,
      ffmpegPath: this.options.ffmpegPath(),
      routes: downloadRoutes(input.resolved.extractorArgs, this.options.downloadStrategies?.() ?? []),
      targetPath,
      signal: input.signal,
      onProgress,
      proxyUrl: this.options.proxyUrl?.(),
      impersonate: (await this.options.impersonate?.()) ?? null,
      // Caption tracks ride along with the transfer rather than costing a
      // second extraction; see captions/tiktok-tracks.ts.
      ...(config.captions.mode === 'off'
        ? {}
        : { subtitleLangs: subtitleLanguages(config.captions.targetLanguage) }),
      log,
    });
  }

  /**
   * A photo slideshow, into a folder of its own.
   *
   * Everything the video path does after the transfer is skipped rather than
   * disabled: there is no container for ffprobe to read, no watermark filter
   * that applies to a still image, no outro on a picture, and nothing to
   * caption. What is left is the part that matters — the images land
   * somewhere predictable and the library gets one path to record.
   *
   * `sourceStrategy: 'raw'` because that is the truth: the files are exactly
   * as TikTok served them, and claiming a clean source would put a
   * watermark-free badge on images nobody inspected.
   */
  private async processPhotoPost(
    input: PipelineInput,
    config: AppConfig,
    log: Logger,
  ): Promise<PipelineResult> {
    const root = this.options.outputDir?.() ?? config.outputDir;
    if (!root) throw new AppError('PERMISSION_DENIED', 'no output folder has been chosen yet');

    const parent = resolveOutputDirectory(root, subdirFor(input, config));

    // The same template the videos use, so a slideshow sorts among them in the
    // order it was pasted instead of drifting to one end of the folder.
    const basename = renderTemplate(config.filenameTemplate, {
      metadata: input.resolved.metadata,
      awemeId: input.normalized.awemeId,
      index: input.item.position,
      batchIndex: input.item.batch_index,
      extension: '',
    });
    const directory = resolveOutputPath({
      directory: parent,
      basename,
      // No extension: this is a folder, and a folder called "…mp4" would be a
      // small lie that costs someone a confused minute.
      extension: '',
      onCollision: input.duplicateAction === 'replace' ? 'replace' : 'suffix',
    });

    log.info({ directory }, 'downloading a photo slideshow');

    /**
     * Two steps rather than seven, and said out loud rather than left blank.
     *
     * A slideshow genuinely has nothing to verify, no watermark to remove and
     * nothing to caption, so the row would otherwise show a ladder of steps
     * that never move — which reads as stuck rather than as not applicable.
     */
    input.onStage?.('download', 'started');
    for (const step of ['verify', 'colour', 'watermark', 'captions', 'finish'] as const) {
      input.onStage?.(step, 'skipped');
    }

    const result = await downloadPhotoPost({
      binaryPath: this.options.ytDlpPath?.() ?? null,
      runner: this.options.runner,
      url: input.normalized.canonicalUrl,
      routes: downloadRoutes(input.resolved.extractorArgs, this.options.downloadStrategies?.() ?? []),
      directory,
      signal: input.signal,
      proxyUrl: this.options.proxyUrl?.(),
      log,
    });

    input.onStage?.('download', 'done');
    input.onProgress({ bytesDone: result.bytes, bytesTotal: result.bytes, speed: null, etaMs: 0 });
    log.info({ directory, files: result.files.length, bytes: result.bytes }, 'slideshow saved');

    return {
      filePath: result.directory,
      fileSize: result.bytes,
      // Hashing a folder is not a thing, and a repost badge on a slideshow
      // would be comparing pictures to videos.
      sha256: null,
      phash: null,
      sourceStrategy: 'raw',
      watermarkRemoved: false,
      outroTrimmedMs: null,
    };
  }
}

/**
 * Which folder under the output directory this download belongs in.
 *
 * A whole account queued from a profile link already carried its handle on the
 * queue row, and its videos were filed together. A handful of links pasted by
 * hand carried nothing, so three creators' videos landed loose in one folder —
 * two paths to the same outcome producing different shapes on disk, with no
 * reason for the difference other than where the link came from.
 *
 * The row's own value still wins when it has one, because "these came from
 * @creator's profile" is a stronger statement than "this video says it is
 * @creator's": a repost keeps the account it was queued under.
 *
 * Null when there is no handle to use — the extractor could not name the
 * author — which files the video at the top level rather than inventing a
 * folder called "unknown".
 */
export function subdirFor(input: PipelineInput, config: AppConfig): string | null {
  if (input.item.output_subdir) return input.item.output_subdir;
  if (!config.groupByCreator) return null;
  return input.resolved.metadata.authorHandle ?? input.normalized.authorHandle ?? null;
}

function pickExtension(streamExt: string | null, audioOnly: boolean): string {
  if (audioOnly) return streamExt && streamExt !== 'mp4' ? `.${streamExt}` : '.m4a';
  return streamExt ? `.${streamExt}` : '.mp4';
}

export { partPathFor };
