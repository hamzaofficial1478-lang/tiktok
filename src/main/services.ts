import type { Logger } from 'pino';
import { AppError } from '@shared/errors';
import type { AppPaths } from './paths';
import { createLogger, type LoggerHandle } from './logging/logger';
import { ConfigStore } from './settings/config';
import { openDatabase, type DatabaseHandle } from './db/database';
import { VideosRepository } from './db/repositories/videos';
import { DownloadsRepository } from './db/repositories/downloads';
import { QueueItemsRepository } from './db/repositories/queue-items';
import { SidecarResolver } from './media/sidecars';
import { probeCapabilities, EMPTY_CAPABILITIES } from './media/capabilities';
import { UrlNormalizer } from './resolve/url-normalizer';
import { HttpRedirectResolver } from './resolve/redirect-resolver';
import { QueueEngine } from './queue/queue-engine';
import { RateLimiter } from './queue/rate-limiter';
import { systemClock } from './clock';
import type { MediaPipeline } from './queue/types';
import { ChildProcessRunner } from './resolve/process-runner';
import { YtDlpExtractor } from './resolve/yt-dlp-extractor';
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
  getSidecarStatus(): { sidecars: SidecarStatus[]; capabilities: MediaCapabilities };
  refreshSidecars(): Promise<{ sidecars: SidecarStatus[]; capabilities: MediaCapabilities }>;
  shutdown(): Promise<void>;
}

export interface CreateServicesOptions {
  paths: AppPaths;
  isDev: boolean;
  /** Version string reported to the renderer and written into the startup log line. */
  appVersion: string;
  /**
   * The download pipeline. Phase 4 supplies the real implementation; until
   * then the queue engine is fully functional but has nothing to hand a
   * resolved video to, so a placeholder that fails loudly is injected rather
   * than pretending a download succeeded.
   */
  pipeline?: MediaPipeline;
}

/**
 * Placeholder until phase 4. Fails with a real taxonomy code rather than
 * returning a fabricated success, so an accidental run surfaces plainly
 * instead of writing phantom rows into the user's library.
 */
const notImplementedPipeline: MediaPipeline = {
  process: async () => {
    throw new AppError('INTERNAL_ERROR', 'the download pipeline is not implemented yet (phase 4)');
  },
};

export async function createServices(options: CreateServicesOptions): Promise<AppServices> {
  const { paths, isDev } = options;

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

  const database = openDatabase({ file: paths.database, log: logging.log.child({ scope: 'db' }) });

  // Crash recovery (section 8): anything left mid-flight by a hard exit goes
  // back to `queued`, in position order, with its .part file untouched.
  const queueItems = new QueueItemsRepository(database.db);
  const recovered = queueItems.resetInFlight();
  if (recovered > 0) log.info({ recovered }, 'reset in-flight queue items after unclean shutdown');

  const sidecars = new SidecarResolver({
    resourcesRoot: paths.resources,
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
   * The extractor chain. yt-dlp is the only implementation today; section 2
   * requires the seam so a second one can be slotted in ahead of or behind it
   * when TikTok next changes, without touching the queue.
   *
   * The yt-dlp path is read fresh on every resolve rather than captured here,
   * so a "Update extractor" run mid-session takes effect immediately.
   */
  const processRunner = new ChildProcessRunner();
  const extractor = new ExtractorChain(
    [
      new YtDlpExtractor({
        get binaryPath(): string | null {
          return sidecars.resolve('yt-dlp').path;
        },
        runner: processRunner,
        proxyUrl: () => config.get().proxyUrl || undefined,
        log: logging.log.child({ scope: 'yt-dlp' }),
      }),
    ],
    logging.log.child({ scope: 'extractor' }),
  );

  const normalizer = new UrlNormalizer({
    redirectResolver: new HttpRedirectResolver(),
  });

  const queue = new QueueEngine({
    queueItems,
    videos: new VideosRepository(database.db),
    downloads: new DownloadsRepository(database.db),
    normalizer,
    extractor,
    pipeline: options.pipeline ?? notImplementedPipeline,
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
    resolution: { normalizer, extractor },
    queue,
    getSidecarStatus: () => snapshot,
    refreshSidecars,
    async shutdown(): Promise<void> {
      // Stop before closing the database, so no worker writes to a closed
      // handle and in-flight items get a clean `cancelled` rather than being
      // left for crash recovery.
      await queue.stop();
      database.close();
      await logging.close();
    },
  };
}
