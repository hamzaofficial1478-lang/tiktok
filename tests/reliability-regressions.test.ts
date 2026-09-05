import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { awemeIdFor, createHarness, makeUrl, seedHistory, type Harness } from './helpers/queue-fixtures';
import type { PipelineInput } from '@main/queue/types';
import { DownloadPipeline } from '@main/download/pipeline';
import { Ffprobe } from '@main/media/ffprobe';
import { EMPTY_CAPABILITIES } from '@main/media/capabilities';
import { DEFAULT_CONFIG } from '@shared/config-schema';
import type { ProcessRunner } from '@main/resolve/process-runner';

let harness: Harness | undefined;
let directory: string | undefined;
afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
  harness = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('download reliability regressions', () => {
  it('applies skip-all only to duplicates, allowing new videos in the same batch', async () => {
    harness = createHarness();
    seedHistory(harness, awemeIdFor(1));
    harness.engine.addLinks([makeUrl(1)], 'same-batch');
    harness.engine.start();
    await harness.engine.whenIdle();
    harness.engine.pause();
    const duplicate = harness.engine.getPendingDuplicates()[0]!;
    harness.engine.resolveDuplicate(duplicate.itemId, 'skip', true);
    harness.engine.addLinks([makeUrl(2)], 'same-batch');
    harness.engine.resume();
    await harness.engine.whenIdle();
    expect(harness.engine.getSnapshot().map((i) => i.status)).toEqual(['skipped', 'completed']);
  });
  it('remembers a cleared library after restart even when its file was moved', async () => {
    harness = createHarness();
    seedHistory(harness, awemeIdFor(1));
    harness.downloads.deleteAllRecords();
    harness.existingFiles.clear();
    harness.restart();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();
    expect(harness.engine.getSnapshot().map((i) => i.status)).toEqual(['skipped', 'completed']);
    expect(harness.pipeline.transfers).toEqual([awemeIdFor(2)]);
  });

  it('frees a worker whose dependency ignores cancellation and rejects late callbacks', async () => {
    harness = createHarness({ engineOverrides: { itemDeadlineMs: 10_000, downloadStallMs: 30 } });
    const normal = harness.pipeline.process.bind(harness.pipeline);
    const abandoned: PipelineInput[] = [];
    vi.spyOn(harness.pipeline, 'process').mockImplementation((input) => {
      if (input.normalized.awemeId !== awemeIdFor(1)) return normal(input);
      abandoned.push(input);
      return new Promise(() => {});
    });
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness!.engine.getSnapshot()[1]?.status).toBe('completed'));
    await harness.engine.stop();
    const before = harness.engine.getSnapshot()[0];
    for (const input of abandoned) {
      input.onProgress({ bytesDone: 100, bytesTotal: 100, speed: null, etaMs: 0, processing: true });
      input.onCommitted?.('/late.mp4');
      input.onStage?.('finish', 'started');
    }
    expect(harness.engine.getSnapshot()[0]).toEqual(before);
    expect(harness.ledger.isSettled(awemeIdFor(1))).toBe(false);
  });

  it('does not time out a transfer that keeps making progress', async () => {
    harness = createHarness({ engineOverrides: { itemDeadlineMs: 5_000, downloadStallMs: 100 } });
    const normal = harness.pipeline.process.bind(harness.pipeline);
    vi.spyOn(harness.pipeline, 'process').mockImplementation(async (input) => {
      for (let bytes = 1; bytes <= 8; bytes++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        input.onProgress({ bytesDone: bytes, bytesTotal: 10, speed: 1, etaMs: 1 });
      }
      return normal(input);
    });
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    expect(harness.pipeline.attempts).toHaveLength(1);
  });

  it('passes the installed ffmpeg to yt-dlp and sharpens with compatibility disabled', async () => {
    directory = mkdtempSync(join(tmpdir(), 'reliability-'));
    const config = { ...DEFAULT_CONFIG, outputDir: directory, forceH264: false,
      sharpen: 'light' as const, colourCorrection: 'off' as const, encodeQuality: 'maximum' as const,
      seoMetadata: false, captions: { ...DEFAULT_CONFIG.captions, mode: 'off' as const } };
    const calls: { command: string; args: readonly string[] }[] = [];
    const runner: ProcessRunner = { run: async (command, args) => {
      calls.push({ command, args });
      const output = command === 'yt-dlp' ? args[args.indexOf('-o') + 1]! : args.at(-1)!;
      writeFileSync(output, Buffer.alloc(command === 'yt-dlp' ? 2048 : 4096));
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    } };
    const pipeline = new DownloadPipeline({ config: () => config, runner,
      ffprobe: new Ffprobe({ binaryPath: null, runner }), ffmpegPath: () => '/installed tools/ffmpeg.exe',
      ytDlpPath: () => 'yt-dlp', log: pino({ level: 'silent' }),
      capabilities: () => ({ ...EMPTY_CAPABILITIES, encoders: { libopenh264: true } }),
    });
    harness = createHarness({ engineOverrides: { pipeline } });
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    const download = calls.find((c) => c.command === 'yt-dlp')!.args;
    expect(download[download.indexOf('--ffmpeg-location') + 1]).toBe('/installed tools/ffmpeg.exe');
    expect(download).toContain('--ignore-config');
    expect(download).toContain('--progress');
    const finish = calls.find((c) => c.args.includes('-vf'))!.args;
    expect(finish[finish.indexOf('-vf') + 1]).toContain('unsharp=');
    expect(finish[finish.indexOf('-b:v') + 1]).toBe('18000000');
    expect(harness.downloads.listLibrary().entries[0]?.file_size).toBe(4096);
  });
});
