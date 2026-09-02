import { mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import type { Logger } from 'pino';
import type { AppPaths } from './paths';
import { createLogger, type LoggerHandle } from './logging/logger';
import { ConfigStore } from './settings/config';
import { openDatabase, type DatabaseHandle } from './db/database';
import { VideosRepository } from './db/repositories/videos';
import { DownloadsRepository } from './db/repositories/downloads';
import { QueueItemsRepository } from './db/repositories/queue-items';
import { CreatorsRepository } from './db/repositories/creators';
import { LinkLedgerRepository } from './db/repositories/link-ledger';
import { reconcileLedger } from './library/reconcile';
import { AppMetaRepository, EXTRACTOR_CHECKED_AT_KEY, QUEUE_RUNNING_KEY } from './db/repositories/app-meta';
import { SidecarResolver } from './media/sidecars';
import { ExtractorUpdater, shouldCheckExtractor } from './media/extractor-updater';
import { FfmpegInstaller, type InstallProgress } from './media/ffmpeg-installer';
import { probeCapabilities, EMPTY_CAPABILITIES } from './media/capabilities';
import { UrlNormalizer } from './resolve/url-normalizer';
import { ProfileExpander } from './resolve/profile-expander';
import { CreatorRunner, type CreatorRunProgress } from './creators/creator-runner';
import { WhisperTranscriber } from './captions/whisper';
import { WhisperInstaller, type WhisperInstallProgress } from './captions/whisper-installer';
import { HttpRedirectResolver } from './resolve/redirect-resolver';
import { QueueEngine } from './queue/queue-engine';
import { RateLimiter } from './queue/rate-limiter';
import { systemClock } from './clock';
import type { MediaPipeline } from './queue/types';
import { ChildProcessRunner } from './resolve/process-runner';
import { Impersonation } from './resolve/impersonation';
import { Ffprobe } from './media/ffprobe';
import { DownloadPipeline } from './download/pipeline';
import { PostProcessor } from './postprocess/processor';
import { EncoderProbe } from './postprocess/encoder-probe';
import { YtDlpExtractor, ytDlpStrategies } from './resolve/yt-dlp-extractor';
import { generateDeviceId, generateInstallId, isValidDeviceId } from './resolve/device-id';
import { ExtractorChain } from './resolve/extractor-chain';
import type { Extractor } from './resolve/types';
import type { MediaCapabilities, SidecarStatus } from '@shared/ipc/contract';

/**
 * The application's non-UI core, assembled in one place.
 *
 * Nothing here imports `electron`. That is the whole point: the engine can be
 * constructed in a test, in a CLI harness (which is how phase 3's queue engine
 * gets exercised), or in the Electron main process, and it behaves identically.
 * main/index.ts is the only file that knows Electron exists.
 */
export interface AppServices {
  readonly paths: AppPaths;
  readonly logging: LoggerHandle;
  readonly log: Logger;
  readonly config: ConfigStore;
  readonly database: DatabaseHandle;
  readonly repos: {
    readonly videos: VideosRepository;
    readonly downloads: DownloadsRepository;
    readonly queueItems: QueueItemsRepository;
    readonly creators: CreatorsRepository;
    /** Which videos are settled, keyed on TikTok's id rather than on a file. */
    readonly linkLedger: LinkLedgerRepository;
  };
  /** Works the saved creator list, one account at a time. */
  readonly creatorRunner: CreatorRunner;
  /** Set by the Electron shell so run progress reaches the window. */
  onCreatorProgress?: (progress: CreatorRunProgress) => void;
  readonly sidecars: SidecarResolver;
  /** Phase 2's resolution layer: URL canonicalisation and the extractor chain. */
  readonly resolution: {
    readonly normalizer: UrlNormalizer;
    readonly extractor: Extractor;
    /** Turns a profile link into that account's video links. */
    readonly profiles: ProfileExpander;
  };
  readonly queue: QueueEngine;
  /** Latest sidecar snapshot; refreshed on demand and after an extractor update. */
  readonly extractorUpdater: ExtractorUpdater;
  readonly ffmpegInstaller: FfmpegInstaller;
  /** Installs the offline transcriber on request; never on its own. */
  readonly whisperInstaller: WhisperInstaller;
  onWhisperProgress?: (progress: WhisperInstallProgress) => void;
  /** Set by the Electron shell so install progress reaches the window. */
  onInstallProgress?: (progress: SidecarInstallProgress) => void;
  getSidecarStatus(): { sidecars: SidecarStatus[]; capabilities: MediaCapabilities };
  refreshSidecars(): Promise<{ sidecars: SidecarStatus[]; capabilities: MediaCapabilities }>;
  shutdown(): Promise<void>;
}

export interface CreateServicesOptions {
  paths: AppPaths;
  isDev: boolean;
  /** Version string reported to the renderer and written into the startup log line. */
  appVersion: string;
  /** Overrides the real download pipeline; used by tests and the harness. */
  pipeline?: MediaPipeline;
  /**
   * Called when a background extractor update changes the sidecar picture, so
   * the Settings screen reflects the new version without a restart.
   */
  onSidecarsChanged?: (snapshot: { sidecars: SidecarStatus[]; capabilities: MediaCapabilities }) => void;
  /**
   * Permits the start-up extractor check to make a network request.
   *
   * Off by default so that tests, harnesses and any future embedding of these
   * services are hermetic — only the real app opts in. The user's own
   * `autoUpdateExtractor` setting still gates it on top of this.
   */
  allowBackgroundUpdates?: boolean;
}

export interface SidecarInstallProgress {
  readonly name: string;
  readonly phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'failed';
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly message: string | null;
}

export async function createServices(options: CreateServicesOptions): Promise<AppServices> {
  const { paths, isDev, onSidecarsChanged } = options;

  // Logging comes up first so that everything after it, including failures in
  // config or the database, lands in a file the user can send us.
  const logging = createLogger({
    directory: paths.logs,
    level: 'info',
    mirrorToStdout: isDev,
  });
  const log = logging.log.child({ scope: 'app' });

  const config = ConfigStore.load(paths.configFile, logging.log.child({ scope: 'config' }));
  logging.setLevel(config.get().logLevel);

  // First run: give downloads somewhere to go rather than failing the first
  // item with "no output folder has been chosen yet".
  if (config.get().outputDir === '') {
    try {
      mkdirSync(paths.defaultOutputDir, { recursive: true });
      config.update({ outputDir: paths.defaultOutputDir });
      log.info({ outputDir: paths.defaultOutputDir }, 'first run: chose a default output folder');
    } catch (err) {
      log.warn({ err: String(err) }, 'could not create the default output folder; the user must choose one');
    }
  }

  /**
   * The device identity the mobile-app route needs, minted once and then kept.
   *
   * Without it yt-dlp never takes its app-API path, and the alternative routes
   * collapse back onto the same web scrape as the default one — which is how
   * three routes and four attempts produced one error four times.
   */
  if (!isValidDeviceId(config.get().deviceId)) {
    config.update({ deviceId: generateDeviceId() });
    log.info('minted a device identity for the mobile app route');
  }
  /**
   * The install id, minted the same way and for the same reason.
   *
   * Separate from the device id rather than derived from it: TikTok is sent
   * both, and two values that are visibly related would describe a phone that
   * does not exist just as clearly as one missing value does.
   */
  if (!isValidDeviceId(config.get().installId)) {
    config.update({ installId: generateInstallId() });
    log.info('minted an install identity for the mobile app route');
  }
  const strategies = ytDlpStrategies(config.get().deviceId, config.get().installId);

  const database = openDatabase({ file: paths.database, log: logging.log.child({ scope: 'db' }) });

  // Crash recovery (section 8): anything left mid-flight by a hard exit goes
  // back to `queued`, in position order, with its .part file untouched.
  const queueItems = new QueueItemsRepository(database.db);
  const recovered = queueItems.resetInFlight();
  if (recovered > 0) log.info({ recovered }, 'reset in-flight queue items after unclean shutdown');

  const sidecars = new SidecarResolver({
    resourcesRoot: paths.resources,
    // Updates land in userData and win over the bundled copy, so an installed
    // app can update an extractor it has no permission to overwrite in place.
    overrideRoot: paths.userData,
    allowPathFallback: isDev,
    log: logging.log.child({ scope: 'sidecars' }),
  });

  let snapshot: { sidecars: SidecarStatus[]; capabilities: MediaCapabilities } = {
    sidecars: [],
    capabilities: EMPTY_CAPABILITIES,
  };

  const refreshSidecars = async (): Promise<typeof snapshot> => {
    const statuses = await sidecars.statusAll();
    const ffmpeg = statuses.find((s) => s.name === 'ffmpeg');
    const capabilities = await probeCapabilities({
      ffmpegPath: ffmpeg?.path ?? null,
      log: logging.log.child({ scope: 'ffmpeg' }),
    });
    snapshot = { sidecars: statuses, capabilities };
    return snapshot;
  };

  await refreshSidecars();

  /**
   * Keep the extractor current without being asked.
   *
   * yt-dlp versions are release dates, and TikTok breaks builds within weeks —
   * the failure it produces, "Unexpected response from webpage request", is
   * indistinguishable from a broken app to anyone who does not know to go and
   * press a button in Settings. Checking on start turns the most common cause
   * of "nothing downloads" into something that fixes itself.
   *
   * Deliberately not awaited: a slow or unreachable release server must not
   * delay the window, and a failed check is a logged warning, never a blocked
   * launch. The extractor path is read fresh on every resolve, so a mid-session
   * replacement is picked up by the next item without a restart.
   */
  /** True while a check is in flight, so evidence arriving in a burst asks once. */
  let extractorCheckInFlight = false;

  /**
   * @param reason `'scheduled'` obeys the age and interval rules; `'failing'`
   *   ignores both. The rules exist to avoid pestering the release server on
   *   every launch, and they are exactly wrong in the case that matters most:
   *   a build four days old that TikTok has already broken is "recent" by the
   *   calendar and useless in practice. Downloads failing is better evidence
   *   than a release date, so it overrides it.
   */
  const maybeUpdateExtractor = (reason: 'scheduled' | 'failing' = 'scheduled'): void => {
    if (!config.get().autoUpdateExtractor) return;
    if (extractorCheckInFlight) return;

    const current = snapshot.sidecars.find((s) => s.name === 'yt-dlp')?.version ?? null;
    const decision =
      reason === 'failing'
        ? ({ check: true, reason: 'downloads failing' } as const)
        : shouldCheckExtractor({
            autoUpdate: true,
            version: current,
            lastCheckedAt: appMeta.getNumber(EXTRACTOR_CHECKED_AT_KEY, 0),
            now: Date.now(),
          });

    if (!decision.check) {
      // Record the decision for a build that is simply recent, so a fresh
      // install does not re-evaluate this on every launch either.
      if (decision.reason === 'recent-build') appMeta.setNumber(EXTRACTOR_CHECKED_AT_KEY, Date.now());
      log.info({ version: current, reason: decision.reason }, 'skipping the extractor check');
      return;
    }

    extractorCheckInFlight = true;
    log.info({ version: current, reason: decision.reason }, 'checking for a newer extractor in the background');
    void extractorUpdater
      .update(current)
      .then(async (result) => {
        // Written on success only: a failed check must be retried next launch,
        // not suppressed for a day.
        appMeta.setNumber(EXTRACTOR_CHECKED_AT_KEY, Date.now());
        if (result.updated) {
          // A replaced extractor may gain or lose the ability to impersonate a
          // browser, so the cached answer is no longer about this binary.
          impersonation.reset();
          await refreshSidecars();
          onSidecarsChanged?.(snapshot);
        }
        log.info({ result: result.message }, 'background extractor check finished');
      })
      .catch((err: unknown) => {
        // Never fatal: a stale extractor still works for anything TikTok has
        // not changed yet, and the user can retry from Settings.
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'background extractor update failed');
      })
      .finally(() => {
        extractorCheckInFlight = false;
      });
  };

  /**
   * The extractor chain. yt-dlp is the only implementation today; section 2
   * requires the seam so a second one can be slotted in ahead of or behind it
   * when TikTok next changes, without touching the queue.
   *
   * The yt-dlp path is read fresh on every resolve rather than captured here,
   * so a "Update extractor" run mid-session takes effect immediately.
   */
  const processRunner = new ChildProcessRunner();

  const extractorUpdater = new ExtractorUpdater({
    overrideRoot: paths.userData,
    runner: processRunner,
    log: logging.log.child({ scope: 'extractor-update' }),
  });

  const whisperInstaller = new WhisperInstaller({
    root: paths.userData,
    runner: processRunner,
    onProgress: (progress) => services.onWhisperProgress?.(progress),
    log: logging.log.child({ scope: 'whisper' }),
  });

  /**
   * Reads its paths fresh on every video.
   *
   * Installing the transcriber mid-session should make the next download use
   * it, without a restart — and `available` is what the caption step checks
   * before deciding whether transcription is even an option.
   */
  const transcriber = new WhisperTranscriber({
    get binaryPath(): string | null {
      return whisperInstaller.status().binaryPath;
    },
    get modelPath(): string | null {
      return whisperInstaller.status().modelPath;
    },
    get ffmpegPath(): string | null {
      return sidecars.resolve('ffmpeg').path;
    },
    runner: processRunner,
    // Whisper is CPU-bound and scales close to linearly, but taking every core
    // makes the machine unusable while a batch runs.
    threads: Math.max(1, Math.floor(cpus().length / 2)),
    log: logging.log.child({ scope: 'whisper' }),
  });

  const ffmpegInstaller = new FfmpegInstaller({
    overrideRoot: paths.userData,
    runner: processRunner,
    log: logging.log.child({ scope: 'ffmpeg-install' }),
  });

  /**
   * One extractor per route, tried in order.
   *
   * A single route is a single point of failure, and it is the one that failed:
   * yt-dlp's web path returned "Unexpected response from webpage request" for
   * every link while the extractor itself was perfectly current. The mobile API
   * routes below hit different endpoints with a different response shape and
   * commonly work when the web page does not, which is the difference between
   * a downloader that survives a TikTok change and one that tells its users to
   * go and find a proxy.
   */
  /**
   * One probe, shared by resolution and the download.
   *
   * Both have to present the same TLS identity — resolving as a browser and
   * then transferring as something else is the split that produces a
   * successful resolve followed by a dropped connection — and asking twice
   * would spawn a process per video to re-learn something that only changes
   * when yt-dlp itself is replaced.
   */
  const impersonation = new Impersonation({
    binaryPath: () => sidecars.resolve('yt-dlp').path,
    runner: processRunner,
    log: logging.log.child({ scope: 'impersonation' }),
  });

  const extractor = new ExtractorChain(
    strategies.map(
      (strategy) =>
        new YtDlpExtractor({
          get binaryPath(): string | null {
            return sidecars.resolve('yt-dlp').path;
          },
          runner: processRunner,
          strategy,
          // Read fresh so a Settings change applies to the next item, not the
          // next restart.
          session: () => ({
            browserCookies: config.get().browserCookies,
            forceIpv4: config.get().forceIpv4,
          }),
          proxyUrl: () => config.get().proxyUrl || undefined,
          impersonate: () => impersonation.target(),
          log: logging.log.child({ scope: `yt-dlp/${strategy.label}` }),
        }),
    ),
    logging.log.child({ scope: 'extractor' }),
  );

  const normalizer = new UrlNormalizer({
    redirectResolver: new HttpRedirectResolver(),
  });

  const profiles = new ProfileExpander({
    get binaryPath(): string | null {
      return sidecars.resolve('yt-dlp').path;
    },
    runner: processRunner,
    session: () => ({
      browserCookies: config.get().browserCookies,
      forceIpv4: config.get().forceIpv4,
    }),
    proxyUrl: () => config.get().proxyUrl || undefined,
    // The listing runs on yt-dlp's own rotating device identity first; the
    // pinned routes are only a fallback. See profile-expander.ts.
    fallbackArgs: () => strategies.filter((s) => s.args.length > 0).map((s) => s.args),
    log: logging.log.child({ scope: 'profile' }),
  });

  const appMeta = new AppMetaRepository(database.db);

  const ffprobe = new Ffprobe({
    get binaryPath(): string | null {
      return sidecars.resolve('ffprobe').path;
    },
    runner: processRunner,
  });

  const postProcessor = new PostProcessor({
    ffmpegPath: () => sidecars.resolve('ffmpeg').path,
    runner: processRunner,
    ffprobe,
    log: logging.log.child({ scope: 'postprocess' }),
  });

  /**
   * Which H.264 encoder this machine can genuinely run.
   *
   * `capabilities` reports what ffmpeg was compiled with, and the LGPL builds
   * this app installs list NVENC, QuickSync, AMF and VAAPI on every computer
   * regardless of the hardware in it. Trusting that list is how a conversion to
   * H.264 was handed to an encoder that could not open its device, failed, and
   * left the video as H.265 for Facebook to refuse. This one finds out by
   * trying, once, and remembers the answer.
   */
  const encoderProbe = new EncoderProbe({
    ffmpegPath: () => sidecars.resolve('ffmpeg').path,
    runner: processRunner,
    log: logging.log.child({ scope: 'encoder' }),
  });

  const downloadPipeline =
    options.pipeline ??
    new DownloadPipeline({
      config: () => config.get(),
      runner: processRunner,
      ffprobe,
      // Read fresh each time so an extractor/ffmpeg update mid-session applies.
      ffmpegPath: () => sidecars.resolve('ffmpeg').path,
      // yt-dlp holds the TikTok session, so it performs the transfer.
      ytDlpPath: () => sidecars.resolve('yt-dlp').path,
      // The download re-extracts, so it needs the same routes resolution has.
      downloadStrategies: () => strategies,
      proxyUrl: () => config.get().proxyUrl || undefined,
      impersonate: () => impersonation.target(),
      log: logging.log.child({ scope: 'download' }),
      postProcessor,
      capabilities: () => snapshot.capabilities,
      encoderProbe,
      transcriber,
    });

  const creators = new CreatorsRepository(database.db);
  const downloadsRepo = new DownloadsRepository(database.db);
  const linkLedger = new LinkLedgerRepository(database.db);

  const queue = new QueueEngine({
    queueItems,
    videos: new VideosRepository(database.db),
    downloads: downloadsRepo,
    ledger: linkLedger,
    normalizer,
    extractor,
    pipeline: downloadPipeline,
    onRunStateChanged: (running) => appMeta.setBoolean(QUEUE_RUNNING_KEY, running),
    /**
     * Links failing the same way, one after another, is the app noticing that
     * its extractor has stopped working before the user has to.
     *
     * Only the real app acts on it — `allowBackgroundUpdates` keeps tests and
     * harnesses off the network — and the replacement is picked up by the next
     * item without a restart, because the binary path is read fresh on every
     * resolve. Which means a batch can heal itself part-way through.
     */
    onExtractorSuspect: ({ failures, lastCode }) => {
      log.warn({ failures, lastCode }, 'downloads are failing in a way that points at yt-dlp; checking for a newer one');
      if (options.allowBackgroundUpdates) maybeUpdateExtractor('failing');
    },
    rateLimiter: new RateLimiter({
      minIntervalMs: () => config.get().rateLimitMs,
      jitterMs: () => config.get().rateLimitJitterMs,
      clock: systemClock,
    }),
    clock: systemClock,
    config: () => config.get(),
    log: logging.log.child({ scope: 'queue' }),
  });

  // A retryable failure interrupted mid-backoff is left `failed` on disk;
  // startup is where it gets its remaining attempts back.
  queue.requeueInterruptedRetries();

  /**
   * And an item parked on a question that died with the previous window.
   *
   * `resetInFlight` above cannot see these — from the database's point of view
   * nothing was in flight — and the question itself only ever existed in
   * memory, so without this the row sits in `awaiting_user` for good. See
   * `recoverUnansweredQuestions`.
   */
  queue.recoverUnansweredQuestions();

  /**
   * And the batches themselves, which the engine only knows about because it
   * was the one that queued them. See `adoptUnfinishedBatches`: without this,
   * a queue picked up from disk finishes silently and its failed links never
   * get their end-of-run retry.
   */
  queue.adoptUnfinishedBatches();

  /**
   * Pick the batch back up automatically.
   *
   * The queue's rows, their order and their `.part` files all survived the
   * exit; what would otherwise be lost is the fact that the user had it
   * *running*. Restoring that here is what makes a shutdown mid-batch resume
   * from the exact link it stopped on instead of waiting to be told to start.
   *
   * Deliberately conditional: a queue the user paused before quitting stays
   * paused, because resuming it unbidden would be its own kind of surprise.
   */
  // Fired before any queue resume, so a stale extractor gets a chance to be
  // replaced before it fails the first item of a restored batch.
  if (options.allowBackgroundUpdates) maybeUpdateExtractor();

  const wasRunning = appMeta.getBoolean(QUEUE_RUNNING_KEY, false);
  const pending = queue.hasPendingWork();
  if (wasRunning && pending) {
    log.info('resuming the queue where it left off');
    queue.start();
  } else if (pending) {
    log.info('unfinished items are waiting, but the queue was not running at exit');
  }

  log.info(
    {
      version: options.appVersion,
      schema: database.migration.to,
      migrationsApplied: database.migration.applied,
      sidecars: Object.fromEntries(snapshot.sidecars.map((s) => [s.name, s.version ?? (s.present ? 'unknown' : null)])),
      ffmpegGpl: snapshot.capabilities.isGplBuild,
      missingCapabilities: snapshot.capabilities.missingRequired,
    },
    'services ready',
  );

  config.subscribe((next) => logging.setLevel(next.logLevel));

  /**
   * Built after the queue because it drives it, and given a mutable progress
   * hook so the Electron shell can forward run progress to the window without
   * this module knowing a window exists.
   */
  /**
   * The record of what has been downloaded, checked against the videos.
   *
   * Read fresh from config each time so it follows the output folder rather
   * than a path captured at start-up.
   */
  const reconcile = (): void => {
    reconcileLedger({
      outputDir: config.get().outputDir,
      ledger: linkLedger,
      log: logging.log.child({ scope: 'library' }),
    });
  };

  const creatorRunner = new CreatorRunner({
    creators,
    ledger: linkLedger,
    profiles,
    queue,
    reconcile,
    onProgress: (progress) => services.onCreatorProgress?.(progress),
    log: logging.log.child({ scope: 'creators' }),
  });

  /**
   * And once at start-up, off the critical path.
   *
   * A run does its own check, so this is not what makes the counts right — it
   * is what makes the Creators screen tell the truth *before* anybody presses
   * anything. A user who opens the app to "50 videos to download" over an
   * account they finished last night has no reason to believe the number that
   * appears after they press it either.
   *
   * Deferred so a large folder cannot delay the window opening, and its failure
   * is logged rather than thrown: an unreadable output folder is a problem for
   * the download that hits it, not a reason to refuse to start.
   */
  setTimeout(() => {
    try {
      reconcile();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'could not check the output folder against the download record at start-up',
      );
    }
  }, 0).unref?.();

  const services: AppServices = {
    paths,
    logging,
    log,
    config,
    database,
    repos: {
      videos: new VideosRepository(database.db),
      downloads: downloadsRepo,
      queueItems,
      creators,
      linkLedger,
    },
    creatorRunner,
    sidecars,
    extractorUpdater,
    ffmpegInstaller,
    whisperInstaller,
    resolution: { normalizer, extractor, profiles },
    queue,
    getSidecarStatus: () => snapshot,
    refreshSidecars,
    async shutdown(): Promise<void> {
      // Stop before closing the database, so no worker writes to a closed
      // handle and in-flight items get a clean `cancelled` rather than being
      // left for crash recovery.
      // The process is going down, not the user pausing: keep the run
      // state so the next launch resumes the batch.
      creatorRunner.cancel();
      await queue.stop({ keepRunState: true });
      database.close();
      await logging.close();
    },
  };

  return services;
}
