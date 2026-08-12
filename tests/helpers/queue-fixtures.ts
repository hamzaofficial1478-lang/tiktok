import Database from 'better-sqlite3';
import pino from 'pino';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { QueueItemsRepository } from '@main/db/repositories/queue-items';
import { VideosRepository } from '@main/db/repositories/videos';
import { DownloadsRepository } from '@main/db/repositories/downloads';
import { UrlNormalizer } from '@main/resolve/url-normalizer';
import type { RedirectResolver } from '@main/resolve/redirect-resolver';
import type { Extractor, ResolvedVideo } from '@main/resolve/types';
import { RateLimiter } from '@main/queue/rate-limiter';
import { QueueEngine, type QueueEngineOptions } from '@main/queue/queue-engine';
import type { MediaPipeline, PipelineInput, PipelineResult, QueueEvent } from '@main/queue/types';
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config-schema';
import { AppError, type ErrorCode } from '@shared/errors';
import type { SourceStrategy } from '@shared/types';
import type { Clock } from '@main/clock';

export const silent = pino({ level: 'silent' });

/**
 * A clock whose sleeps resolve immediately but are recorded.
 *
 * The retry schedule is 2s/8s/30s and the rate limit is 1.5s between requests.
 * Waiting for those would make the suite take minutes and assert nothing useful;
 * recording them lets the tests assert the *schedule*, which is the actual
 * requirement.
 */
export class TestClock implements Clock {
  private current = 1_700_000_000_000;
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AppError('CANCELLED', 'sleep aborted');
    this.sleeps.push(ms);
    // Advance virtual time so rate-limit and throttle windows behave as if the
    // wait really happened.
    this.current += ms;
    await Promise.resolve();
    if (signal?.aborted) throw new AppError('CANCELLED', 'sleep aborted');
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export function makeUrl(index: number): string {
  return `https://www.tiktok.com/@user${index}/video/${7_000_000_000_000_000_000n + BigInt(index)}`;
}

export function awemeIdFor(index: number): string {
  return String(7_000_000_000_000_000_000n + BigInt(index));
}

export function resolvedVideo(awemeId: string, handle = 'user'): ResolvedVideo {
  return {
    extractor: 'fake',
    streams: [
      {
        id: 'play_addr',
        url: `https://cdn.example/${awemeId}.mp4`,
        watermarked: false,
        kind: 'video',
        width: 1080,
        height: 1920,
        fps: 30,
        bitrate: 2400,
        filesize: 1_000_000,
        ext: 'mp4',
        codec: 'h264',
        hasAudio: true,
        preference: 1_000_000,
      },
    ],
    metadata: {
      awemeId,
      authorHandle: handle,
      authorName: 'Test User',
      caption: `caption for ${awemeId}`,
      durationMs: 12_000,
      coverUrl: null,
      musicTitle: null,
      uploadedAt: 1_700_000_000_000,
      hashtags: [],
      isPhotoPost: false,
      stats: { views: null, likes: null, comments: null, shares: null },
    },
  };
}

/** Records which items it processed, in order, and can be told to fail. */
export class FakePipeline implements MediaPipeline {
  readonly processed: string[] = [];
  private failures = new Map<string, ErrorCode[]>();
  private hangs = new Set<string>();
  private strategies = new Map<string, { sourceStrategy: SourceStrategy; watermarkRemoved: boolean }>();

  /**
   * Shares the harness's virtual filesystem so a completed download actually
   * leaves a file behind. Without this, layer 3 would always see history
   * pointing at a missing file and silently re-download, which would make the
   * duplicate-decision tests pass for the wrong reason.
   */
  constructor(private readonly existingFiles: Set<string>) {}

  failFor(awemeId: string, codes: ErrorCode[]): void {
    this.failures.set(awemeId, [...codes]);
  }

  hangFor(awemeId: string): void {
    this.hangs.add(awemeId);
  }

  /**
   * A real crash loses whatever was making a download hang. The fake outlives
   * `restart()`, so a test simulating recovery must clear it explicitly or the
   * recovered item hangs a second time.
   */
  clearHangs(): void {
    this.hangs.clear();
  }

  /** Stands in for a video TikTok only offers with the watermark burnt in. */
  strategyFor(awemeId: string, sourceStrategy: SourceStrategy, watermarkRemoved: boolean): void {
    this.strategies.set(awemeId, { sourceStrategy, watermarkRemoved });
  }

  async process(input: PipelineInput): Promise<PipelineResult> {
    const awemeId = input.normalized.awemeId;

    if (this.hangs.has(awemeId)) {
      // Waits until cancelled, standing in for a long download.
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new AppError('CANCELLED', 'aborted')), { once: true });
      });
    }

    const queued = this.failures.get(awemeId);
    if (queued && queued.length > 0) {
      const code = queued.shift() as ErrorCode;
      throw new AppError(code, `fake pipeline failure for ${awemeId}`);
    }

    this.processed.push(awemeId);
    input.onProgress({ bytesDone: 1_000_000, bytesTotal: 1_000_000, speed: 1_000_000, etaMs: 0 });

    const filePath = `/out/${awemeId}${input.duplicateAction === 'redownload' ? ' (2)' : ''}.mp4`;
    this.existingFiles.add(filePath);

    return {
      filePath,
      fileSize: 1_000_000,
      sha256: `sha-${awemeId}`,
      phash: `phash-${awemeId}`,
      ...(this.strategies.get(awemeId) ?? { sourceStrategy: 'clean_source' as SourceStrategy, watermarkRemoved: true }),
      outroTrimmedMs: null,
    };
  }
}

export class FakeExtractor implements Extractor {
  readonly name = 'fake';
  readonly resolvedIds: string[] = [];
  private failures = new Map<string, ErrorCode[]>();

  failFor(awemeId: string, codes: ErrorCode[]): void {
    this.failures.set(awemeId, [...codes]);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async resolve(canonicalUrl: string): Promise<ResolvedVideo> {
    const awemeId = /\/(\d{15,21})/.exec(canonicalUrl)?.[1] ?? '';
    const queued = this.failures.get(awemeId);
    if (queued && queued.length > 0) {
      const code = queued.shift() as ErrorCode;
      throw new AppError(code, `fake extractor failure for ${awemeId}`);
    }
    this.resolvedIds.push(awemeId);
    const handle = /@([\w.-]+)\//.exec(canonicalUrl)?.[1] ?? 'user';
    return resolvedVideo(awemeId, handle);
  }
}

export interface Harness {
  engine: QueueEngine;
  /**
   * Simulates an app restart: resets in-flight rows exactly as createServices
   * does on startup, then builds a fresh engine over the same database. The
   * old engine's in-memory state — pending duplicates, batch choices, retry
   * timers — is deliberately discarded, since a crash would lose it too.
   */
  restart(): QueueEngine;
  readonly db: Database.Database;
  readonly queueItems: QueueItemsRepository;
  readonly videos: VideosRepository;
  readonly downloads: DownloadsRepository;
  readonly pipeline: FakePipeline;
  readonly extractor: FakeExtractor;
  readonly clock: TestClock;
  readonly events: QueueEvent[];
  readonly rateLimiter: RateLimiter;
  setConfig(patch: Partial<AppConfig>): void;
  existingFiles: Set<string>;
  close(): void;
}

export function createHarness(
  options: {
    config?: Partial<AppConfig>;
    redirects?: Record<string, string>;
    engineOverrides?: Partial<QueueEngineOptions>;
  } = {},
): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);

  const queueItems = new QueueItemsRepository(db);
  const videos = new VideosRepository(db);
  const downloads = new DownloadsRepository(db);

  const redirectResolver: RedirectResolver = {
    resolve: async (url: string) => {
      const target = options.redirects?.[url];
      if (!target) throw new AppError('NETWORK_ERROR', `no redirect stub for ${url}`);
      return target;
    },
  };

  const normalizer = new UrlNormalizer({ redirectResolver });
  const existingFiles = new Set<string>();
  const pipeline = new FakePipeline(existingFiles);
  const extractor = new FakeExtractor();
  const clock = new TestClock();
  const events: QueueEvent[] = [];

  let config: AppConfig = { ...DEFAULT_CONFIG, ...options.config };

  const rateLimiter = new RateLimiter({
    minIntervalMs: () => config.rateLimitMs,
    jitterMs: () => config.rateLimitJitterMs,
    clock,
    random: () => 0.5,
  });

  const buildEngine = (): QueueEngine => {
    const next = new QueueEngine({
      queueItems,
      videos,
      downloads,
      normalizer,
      extractor,
      pipeline,
      rateLimiter,
      clock,
      config: () => config,
      log: silent,
      fileExists: (path) => existingFiles.has(path),
      random: () => 0.5,
      ...options.engineOverrides,
    });
    next.subscribe((event) => events.push(event));
    return next;
  };

  const harness = {
    engine: buildEngine(),
    restart(): QueueEngine {
      queueItems.resetInFlight();
      harness.engine = buildEngine();
      return harness.engine;
    },
    db,
    queueItems,
    videos,
    downloads,
    pipeline,
    extractor,
    clock,
    events,
    rateLimiter,
    setConfig: (patch) => {
      config = { ...config, ...patch };
    },
    existingFiles,
    close: () => db.close(),
  } satisfies Harness;

  return harness;
}

/** Seeds a completed download so layer 3 has history to find. */
export function seedHistory(
  harness: Harness,
  awemeId: string,
  filePath = `/out/${awemeId}.mp4`,
  caption = 'previously downloaded',
): void {
  const video = harness.videos.upsert({
    awemeId,
    canonicalUrl: `https://www.tiktok.com/@user/video/${awemeId}`,
    caption,
    authorHandle: 'user',
  });
  harness.downloads.insert({
    videoId: video.id,
    filePath,
    watermarkRemoved: true,
    sourceStrategy: 'clean_source',
    completedAt: 1_699_000_000_000,
  });
  harness.existingFiles.add(filePath);
}
