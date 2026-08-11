import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPaths } from '@main/paths';
import { createServices, type AppServices } from '@main/services';
import { MIGRATIONS } from '@main/db/migrations';

/**
 * Boots the entire non-UI core the way the main process does.
 *
 * This is the test that proves the Electron-free architecture actually holds:
 * if anyone later reaches for `app.getPath()` or imports `electron` inside a
 * service, this file stops compiling or fails to import. It is also the
 * harness phase 3's queue engine will be driven from.
 */
let dir: string;
let services: AppServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'services-'));
});

afterEach(async () => {
  await services?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('service container', () => {
  it('starts with no prior state and creates everything it needs', async () => {
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));
    services = await createServices({ paths, isDev: false, appVersion: '0.1.0-test' });

    expect(services.database.migration.to).toBe(MIGRATIONS.length);
    expect(existsSync(paths.database)).toBe(true);
    expect(existsSync(paths.configFile)).toBe(true);
    expect(existsSync(paths.logs)).toBe(true);

    // Sidecars are genuinely absent in this environment; that must be reported
    // cleanly rather than throwing during startup.
    const status = services.getSidecarStatus();
    expect(status.sidecars.map((s) => s.name).sort()).toEqual(['ffmpeg', 'ffprobe', 'yt-dlp']);
    expect(status.sidecars.every((s) => s.present === false)).toBe(true);
    expect(status.capabilities.probed).toBe(false);

    // Startup was logged — this is what a support ticket relies on.
    expect(services.logging.tail(50).some((e) => e.msg === 'services ready')).toBe(true);
  });

  it('recovers a queue left mid-flight by an unclean shutdown', async () => {
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));

    const first = await createServices({ paths, isDev: false, appVersion: '0.1.0-test' });
    const items = first.repos.queueItems.enqueue([
      { batchId: 'b', rawUrl: 'https://www.tiktok.com/@a/video/1', awemeId: '1' },
      { batchId: 'b', rawUrl: 'https://www.tiktok.com/@a/video/2', awemeId: '2' },
      { batchId: 'b', rawUrl: 'https://www.tiktok.com/@a/video/3', awemeId: '3' },
    ]);
    first.repos.queueItems.update(items[0]?.id as number, { status: 'downloading', progress: 0.6 });
    first.repos.queueItems.update(items[1]?.id as number, { status: 'completed' });
    // Simulate a crash: close without a graceful shutdown path.
    first.database.close();
    await first.logging.close();

    services = await createServices({ paths, isDev: false, appVersion: '0.1.0-test' });
    const restored = services.repos.queueItems.listOrdered();

    expect(restored).toHaveLength(3);
    expect(restored.map((r) => r.raw_url)).toEqual([
      'https://www.tiktok.com/@a/video/1',
      'https://www.tiktok.com/@a/video/2',
      'https://www.tiktok.com/@a/video/3',
    ]);
    expect(restored[0]?.status).toBe('queued');
    expect(restored[0]?.progress).toBe(0);
    expect(restored[1]?.status).toBe('completed');
    expect(restored[2]?.status).toBe('queued');
  });

  it('reopens an existing library without re-running migrations or losing data', async () => {
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));

    const first = await createServices({ paths, isDev: false, appVersion: '0.1.0-test' });
    first.repos.videos.upsert({ awemeId: '7123456789012345678', canonicalUrl: 'https://t/1', caption: 'kept' });
    first.config.update({ concurrency: 3 });
    await first.shutdown();

    services = await createServices({ paths, isDev: false, appVersion: '0.1.0-test' });

    expect(services.database.migration.applied).toEqual([]);
    expect(services.repos.videos.findByAwemeId('7123456789012345678')?.caption).toBe('kept');
    expect(services.config.get().concurrency).toBe(3);
  });
});
