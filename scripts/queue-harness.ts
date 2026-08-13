/**
 * Headless CLI harness for the queue engine — spec section 15, phase 3:
 * "Headless, tested via a CLI harness."
 *
 *     npm run harness:queue
 *
 * Drives the real QueueEngine, the real UrlNormalizer, the real dedup layers,
 * the real retry policy and the real SQLite persistence against a fake
 * extractor and a fake download pipeline. The unit suite proves each behaviour
 * in isolation; this shows them interacting on one batch, in order, in a
 * terminal — including the thing that is hardest to believe from a test name:
 * that a duplicate question does not stall the queue behind it.
 *
 * It deliberately uses a real database file so the crash-recovery step is a
 * genuine reopen rather than a simulation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { QueueItemsRepository } from '@main/db/repositories/queue-items';
import { VideosRepository } from '@main/db/repositories/videos';
import { DownloadsRepository } from '@main/db/repositories/downloads';
import { UrlNormalizer } from '@main/resolve/url-normalizer';
import { QueueEngine } from '@main/queue/queue-engine';
import { RateLimiter } from '@main/queue/rate-limiter';
import type { MediaPipeline, PipelineInput, PipelineResult, QueueEvent } from '@main/queue/types';
import type { Extractor, ResolvedVideo } from '@main/resolve/types';
import { DEFAULT_CONFIG } from '@shared/config-schema';
import { AppError } from '@shared/errors';
import type { Clock } from '@main/clock';

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim('─'.repeat(text.length))}`);
}

const id = (n: number): string => String(7_000_000_000_000_000_000n + BigInt(n));
const url = (n: number): string => `https://www.tiktok.com/@creator${n}/video/${id(n)}`;

/** Compresses the retry backoff and rate limit so a demo run finishes quickly. */
const fastClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const scaled = Math.min(ms / 20, 250);
      const timer = setTimeout(resolve, scaled);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new AppError('CANCELLED', 'aborted'));
        },
        { once: true },
      );
    }),
};

class HarnessExtractor implements Extractor {
  readonly name = 'harness';
  constructor(private readonly deleted: Set<string>) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async resolve(canonicalUrl: string): Promise<ResolvedVideo> {
    const awemeId = /\/(\d{15,21})/.exec(canonicalUrl)?.[1] ?? '';
    if (this.deleted.has(awemeId)) throw new AppError('VIDEO_DELETED', 'no longer on TikTok');

    return {
      extractor: this.name,
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
          filesize: 3_000_000,
          ext: 'mp4',
          codec: 'h264',
          headers: {},
          hasAudio: true,
          preference: 1_000_000,
        },
      ],
      metadata: {
        awemeId,
        authorHandle: /@([\w.-]+)\//.exec(canonicalUrl)?.[1] ?? 'creator',
        authorName: 'Harness Creator',
        caption: `demo video ${awemeId.slice(-3)}`,
        durationMs: 12_000,
        coverUrl: null,
        musicTitle: null,
        uploadedAt: Date.now(),
        hashtags: [],
        isPhotoPost: false,
        stats: { views: null, likes: null, comments: null, shares: null },
      },
    };
  }
}

class HarnessPipeline implements MediaPipeline {
  private readonly flaky = new Map<string, number>();
  constructor(
    private readonly files: Set<string>,
    flakyIds: Record<string, number> = {},
  ) {
    for (const [key, count] of Object.entries(flakyIds)) this.flaky.set(key, count);
  }

  async process(input: PipelineInput): Promise<PipelineResult> {
    const awemeId = input.normalized.awemeId;
    const remaining = this.flaky.get(awemeId) ?? 0;
    if (remaining > 0) {
      this.flaky.set(awemeId, remaining - 1);
      throw new AppError('NETWORK_ERROR', 'connection reset by peer');
    }

    const total = 3_000_000;
    for (let done = 0; done <= total; done += total / 4) {
      input.onProgress({ bytesDone: done, bytesTotal: total, speed: 1_500_000, etaMs: 0 });
      await new Promise((r) => setTimeout(r, 8));
      if (input.signal.aborted) throw new AppError('CANCELLED', 'cancelled');
    }

    const filePath = `/library/${awemeId}${input.duplicateAction === 'redownload' ? ' (2)' : ''}.mp4`;
    this.files.add(filePath);
    return {
      filePath,
      fileSize: total,
      sha256: `sha256-${awemeId}`,
      phash: `phash-${awemeId}`,
      sourceStrategy: 'clean_source',
      watermarkRemoved: true,
      outroTrimmedMs: null,
    };
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'queue-harness-'));
  const dbFile = join(dir, 'library.db');
  const files = new Set<string>();

  const open = () => {
    const db = new Database(dbFile);
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  let db = open();
  let queueItems = new QueueItemsRepository(db);
  let videos = new VideosRepository(db);
  let downloads = new DownloadsRepository(db);

  const deleted = new Set([id(5)]);
  const pipeline = new HarnessPipeline(files, { [id(7)]: 2 });
  const extractor = new HarnessExtractor(deleted);
  const config = { ...DEFAULT_CONFIG, concurrency: 1, rateLimitMs: 1_500, rateLimitJitterMs: 400 };

  // A video already in the library, so layer 3 has something to find.
  const seeded = videos.upsert({
    awemeId: id(3),
    canonicalUrl: url(3),
    caption: 'downloaded last week',
    authorHandle: 'creator3',
  });
  downloads.insert({
    videoId: seeded.id,
    filePath: `/library/${id(3)}.mp4`,
    watermarkRemoved: true,
    sourceStrategy: 'clean_source',
    completedAt: Date.now() - 86_400_000,
  });
  files.add(`/library/${id(3)}.mp4`);

  const build = (): QueueEngine =>
    new QueueEngine({
      queueItems,
      videos,
      downloads,
      normalizer: new UrlNormalizer({
        redirectResolver: {
          resolve: async (short) => {
            await new Promise((r) => setTimeout(r, 20));
            return short.includes('ZMshort') ? url(2) : url(9);
          },
        },
      }),
      extractor,
      pipeline,
      rateLimiter: new RateLimiter({
        minIntervalMs: () => config.rateLimitMs,
        jitterMs: () => config.rateLimitJitterMs,
        clock: fastClock,
      }),
      clock: fastClock,
      config: () => config,
      log: pino({ level: 'silent' }),
      fileExists: (path) => files.has(path),
    });

  let engine = build();

  engine.subscribe((event: QueueEvent) => {
    if (event.type === 'item-updated') {
      const { position, status, awemeId, errorCode } = event.item;
      const label =
        status === 'completed'
          ? green(status)
          : status === 'failed'
            ? red(status)
            : status === 'awaiting_user' || status === 'skipped'
              ? yellow(status)
              : dim(status);
      // Only the interesting transitions, or the log becomes noise.
      if (status !== 'downloading' && status !== 'resolving') {
        console.log(`  #${String(position).padStart(3)} ${label.padEnd(20)} ${dim(awemeId ?? '—')} ${errorCode ? red(errorCode) : ''}`);
      }
    }
    if (event.type === 'duplicate-pending') {
      console.log(`  ${cyan('?')} duplicate: "${event.pending.caption}" already at ${event.pending.existingFilePath}`);
    }
    if (event.type === 'batch-complete') {
      const s = event.summary;
      console.log(
        `\n  ${bold('batch complete')} · ${green(`${s.completed} downloaded`)} · ${yellow(`${s.skipped} skipped`)} · ${red(`${s.failed} failed`)}`,
      );
    }
  });

  heading('1. Adding a messy paste');
  const pasted = [
    url(1),
    url(1), // duplicate within the paste
    `  ${url(2)}?is_from_webapp=1  `, // same video as the short link below
    'https://vm.tiktok.com/ZMshort/', // short link -> url(2)
    url(3), // already in the library
    'not a link at all',
    'https://www.youtube.com/watch?v=x',
    `https://www.tiktok.com/@creator4/photo/${id(4)}`, // photo carousel
    url(5), // deleted upstream
    url(6),
    url(7), // fails twice, then succeeds
    url(8),
  ];

  const added = engine.addLinks(pasted, 'demo-batch');
  console.log(`  ${added.totalFound} links found · ${added.duplicatesRemoved} duplicates removed · ${added.invalid.length} invalid`);
  for (const bad of added.invalid) console.log(`  ${red('✗')} ${dim(bad.rawUrl)} → ${bad.code}`);
  console.log(`  queued: ${bold(String(added.added))}`);

  heading('2. Processing in insertion order (concurrency 1)');
  engine.start();
  await engine.whenIdle();

  heading('3. Answering the duplicate question');
  for (const pending of engine.getPendingDuplicates()) {
    console.log(`  answering "Download again" for ${pending.awemeId}`);
    engine.resolveDuplicate(pending.itemId, 'redownload');
  }
  await engine.whenIdle();

  heading('4. Crash recovery');
  await engine.stop();

  // Represent what an unclean exit leaves behind: rows still marked in flight,
  // with no chance to run any shutdown code. Adding a fresh batch first so
  // there is genuinely unfinished work to recover.
  engine.addLinks([url(10), url(11), url(12)], 'crash-batch');
  const inFlight = engine.getSnapshot().filter((i) => i.status === 'queued').slice(0, 2);
  queueItems.update(inFlight[0]?.id as number, { status: 'downloading', progress: 0.42 });
  queueItems.update(inFlight[1]?.id as number, { status: 'processing', progress: 0.9 });
  console.log(`  simulating a hard exit with ${inFlight.length} item(s) in flight…`);
  db.close();

  db = open();
  queueItems = new QueueItemsRepository(db);
  videos = new VideosRepository(db);
  downloads = new DownloadsRepository(db);
  const recovered = queueItems.resetInFlight();
  engine = build();
  console.log(`  reopened: reset ${recovered} in-flight item(s) to queued, ${engine.getSnapshot().length} rows restored`);

  engine.start();
  await engine.whenIdle();
  for (const pending of engine.getPendingDuplicates()) engine.resolveDuplicate(pending.itemId, 'skip', true);
  await engine.whenIdle();

  heading('5. Final queue');
  for (const item of engine.getSnapshot()) {
    const status =
      item.status === 'completed'
        ? green('completed')
        : item.status === 'failed'
          ? red('failed   ')
          : yellow(item.status.padEnd(9));
    console.log(
      `  #${String(item.position).padStart(3)} ${status} ${dim((item.awemeId ?? '—').padEnd(20))} ` +
        `attempts=${item.attemptCount} ${item.errorCode ? red(item.errorCode) : ''}`,
    );
  }

  heading('6. Library');
  for (const row of db
    .prepare<[], { aweme_id: string; file_path: string; source_strategy: string }>(
      'SELECT v.aweme_id, d.file_path, d.source_strategy FROM downloads d JOIN videos v ON v.id = d.video_id ORDER BY d.id',
    )
    .all()) {
    console.log(`  ${dim(row.aweme_id)} ${row.file_path} ${cyan(row.source_strategy)}`);
  }

  const ordered = engine.getSnapshot().map((i) => i.position);
  const monotonic = ordered.every((p, i) => i === 0 || p > (ordered[i - 1] as number));
  console.log(`\n  positions strictly increasing: ${monotonic ? green('yes') : red('no')}`);
  console.log(`  unique positions: ${new Set(ordered).size === ordered.length ? green('yes') : red('no')}`);

  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(dim('\ndone\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
