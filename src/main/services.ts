import { mkdirSync } from 'node:fs';
import type { Logger } from 'pino';
import type { AppPaths } from './paths';
import { createLogger, type LoggerHandle } from './logging/logger';
import { ConfigStore } from './settings/config';
import { openDatabase, type DatabaseHandle } from './db/database';
import { VideosRepository } from './db/repositories/videos';
import { DownloadsRepository } from './db/repositories/downloads';
import { QueueItemsRepository } from './db/repositories/queue-items';
import { AppMetaRepository, EXTRACTOR_CHECKED_AT_KEY, QUEUE_RUNNING_KEY } from './db/repositories/app-meta';
import { SidecarResolver } from './media/sidecars';
import { ExtractorUpdater, shouldCheckExtractor } from './media/extractor-updater';
import { FfmpegInstaller, type InstallProgress } from './media/ffmpeg-installer';
import { probeCapabilities, EMPTY_CAPABILITIES } from './media/capabilities';
import { UrlNormalizer } from './resolve/url-normalizer';
import { HttpRedirectResolver } from './resolve/redirect-resolver';
import { QueueEngine } from './queue/queue-engine';
import { RateLimiter } from './queue/rate-limiter';
import { systemClock } from './clock';
import type { MediaPipeline } from './queue/types';
import { ChildProcessRunner } from './resolve/process-runner';
import { Ffprobe } from './media/ffprobe';
import { DownloadPipeline } from './download/pipeline';
import { PostProcessor } from './postprocess/processor';
import { YtDlpExtractor, YT_DLP_STRATEGIES } from './resolve/yt-dlp-extractor';
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
  };
  readonly sidecars: SidecarResolver;
  /** Phase 2's resolution layer: URL canonicalisation and the extractor chain. */
  readonly resolution: {
    readonly normalizer: UrlNormalizer;
    readonly extractor: Extractor;
  };
  readonly queue: QueueEngine;
  /** Latest sidecar snapshot; refreshed on demand and after an extractor update. */
  readonly extractorUpdater: ExtractorUpdater;
  readonly ffmpegInstaller: FfmpegInstaller;
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
  const maybeUpdateExtractor = (): void => {
    if (!config.get().autoUpdateExtractor) return;

    const current = snapshot.sidecars.find((s) => s.name === 'yt-dlp')?.version ?? null;
    const decision = shouldCheckExtractor({
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

    log.info({ version: current, reason: decision.reason }, 'checking for a newer extractor in the background');
    void extractorUpdater
      .update(current)
      .then(async (result) => {
        // Written on success only: a failed check must be retried next launch,
        // not suppressed for a day.
        appMeta.setNumber(EXTRACTOR_CHECKED_AT_KEY, Date.now());
        if (result.updated) {
          await refreshSidecars();
          onSidecarsChanged?.(snapshot);
        }
        log.info({ result: result.message }, 'background extractor check finished');
      })
      .catch((err: unknown) => {
        // Never fatal: a stale extractor still works for anything TikTok has
        // not changed yet, and the user can retry from Settings.
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'background extractor update failed');
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
  const extractor = new ExtractorChain(
    YT_DLP_STRATEGIES.map(
      (strategy) =>
        new YtDlpExtractor({
          get binaryPath(): string | null {
            return sidecars.resolve('yt-dlp').path;
          },
          runner: processRunner,
          strategy,
          proxyUrl: () => config.get().proxyUrl || undefined,
          log: logging.log.child({ scope: `yt-dlp/${strategy.label}` }),
        }),
    ),
    logging.log.child({ scope: 'extractor' }),
  );

  const normalizer = new UrlNormalizer({
    redirectResolver: new HttpRedirectResolver(),
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
      proxyUrl: () => config.get().proxyUrl || undefined,
      log: logging.log.child({ scope: 'download' }),
      postProcessor,
      capabilities: () => snapshot.capabilities,
    });

  const queue = new QueueEngine({
    queueItems,
    videos: new VideosRepository(database.db),
    downloads: new DownloadsRepository(database.db),
    normalizer,
    extractor,
    pipeline: downloadPipeline,
    onRunStateChanged: (running) => appMeta.setBoolean(QUEUE_RUNNING_KEY, running),
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

  return {
    paths,
    logging,
    log,
    config,
    database,
    repos: {
      videos: new VideosRepository(database.db),
      downloads: new DownloadsRepository(database.db),
      queueItems,
    },
    sidecars,
    extractorUpdater,
    ffmpegInstaller,
    resolution: { normalizer, extractor },
    queue,
    getSidecarStatus: () => snapshot,
    refreshSidecars,
    async shutdown(): Promise<void> {
      // Stop before closing the database, so no worker writes to a closed
      // handle and in-flight items get a clean `cancelled` rather than being
      // left for crash recovery.
      // The process is going down, not the user pausing: keep the run
      // state so the next launch resumes the batch.
      await queue.stop({ keepRunState: true });
      database.close();
      await logging.close();
    },
  };
}
