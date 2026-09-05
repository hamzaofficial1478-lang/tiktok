import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { ChildProcessRunner } from '@main/resolve/process-runner';
import { YtDlpExtractor } from '@main/resolve/yt-dlp-extractor';
import { SidecarResolver } from '@main/media/sidecars';
import { Ffprobe } from '@main/media/ffprobe';
import { DownloadPipeline } from '@main/download/pipeline';
import { DEFAULT_CONFIG } from '@shared/config-schema';
import { createHarness } from '../helpers/queue-fixtures';

// Explicit opt-in: this transfers a real video, then removes the test output.
it.skipIf(process.env['LIVE_PROBE'] !== '1' || process.env['LIVE_DOWNLOAD'] !== '1')(
  'downloads a public video through the real queue and pipeline', async () => {
    const url = process.env['PROBE_URLS']?.split(',')[0];
    expect(url, 'set PROBE_URLS to a public TikTok video link').toBeTruthy();
    const directory = mkdtempSync(join(tmpdir(), 'tiktok-live-'));
    const sidecars = new SidecarResolver({ resourcesRoot: resolve('resources'), allowPathFallback: true });
    const runner = new ChildProcessRunner();
    const binary = sidecars.resolve('yt-dlp').path;
    const config = { ...DEFAULT_CONFIG, outputDir: directory, sharpen: 'off' as const,
      colourCorrection: 'off' as const, forceH264: false, seoMetadata: false,
      watermarkMode: 'keep' as const, captions: { ...DEFAULT_CONFIG.captions, mode: 'off' as const } };
    const pipeline = new DownloadPipeline({ config: () => config, runner,
      ffprobe: new Ffprobe({ binaryPath: sidecars.resolve('ffprobe').path, runner }),
      ffmpegPath: () => sidecars.resolve('ffmpeg').path, ytDlpPath: () => binary,
      log: pino({ level: 'silent' }),
    });
    const harness = createHarness({ engineOverrides: {
      extractor: new YtDlpExtractor({ binaryPath: binary, runner }), pipeline,
      fileExists: existsSync,
    } });
    try {
      harness.engine.addLinks([url!]);
      harness.engine.start();
      await harness.engine.whenIdle();
      expect(harness.engine.getSnapshot()[0]).toMatchObject({ status: 'completed', errorCode: null });
      const saved = harness.downloads.listLibrary().entries[0]!;
      expect(statSync(saved.file_path).size).toBeGreaterThan(1024);
      expect(harness.ledger.isSettled(saved.aweme_id)).toBe(true);
      harness.downloads.deleteAllRecords();
      harness.engine.removeFinished();
      harness.engine.addLinks([url!]);
      await harness.engine.whenIdle();
      expect(harness.engine.getSnapshot()[0]?.status).toBe('skipped');
    } finally {
      await harness.engine.stop();
      harness.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000,
);
