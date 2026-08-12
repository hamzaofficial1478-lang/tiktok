import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostProcessor, type PostProcessInput } from '@main/postprocess/processor';
import { Ffprobe } from '@main/media/ffprobe';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';
import type { MediaCapabilities } from '@shared/ipc/contract';
import { computeRms, dominantShare, meanAbsoluteDifference } from '@main/postprocess/frame-sampler';

const silent = pino({ level: 'silent' });

const capabilities: MediaCapabilities = {
  probed: true,
  isGplBuild: false,
  filters: { removelogo: true, gblur: true, overlay: true, crop: true, split: true },
  encoders: { h264_nvenc: true, libopenh264: true },
  missingRequired: [],
};

/** Records every ffmpeg invocation so the tests can assert what did NOT run. */
function recordingRunner(): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    run: vi.fn(async (_command: string, args: readonly string[]): Promise<ProcessResult> => {
      calls.push([...args]);
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    }),
  };
  return { runner, calls };
}

function processorFor(runner: ProcessRunner, ffmpegPath: string | null = '/fake/ffmpeg'): PostProcessor {
  return new PostProcessor({
    ffmpegPath: () => ffmpegPath,
    runner,
    ffprobe: new Ffprobe({ binaryPath: '/fake/ffprobe', runner }),
    log: silent,
  });
}

function input(overrides: Partial<PostProcessInput> = {}): PostProcessInput {
  return {
    filePath: '/out/video.mp4',
    durationMs: 30_000,
    frameWidth: 1_080,
    frameHeight: 1_920,
    sourceStrategy: 'clean_source',
    watermarkMode: 'auto',
    outroMode: 'never',
    hardwareAcceleration: true,
    capabilities,
    ...overrides,
  };
}

describe('the fast path (section 9: clean source needs no processing)', () => {
  it('does no work at all for a clean source with outro trimming off', async () => {
    const { runner, calls } = recordingRunner();
    const result = await processorFor(runner).process(input());

    // The whole argument for preferring a clean stream is that it costs
    // nothing further. Any ffmpeg invocation here is a regression.
    expect(calls).toHaveLength(0);
    expect(result.watermarkRemoved).toBe(true);
    expect(result.reEncoded).toBe(false);
    expect(result.sourceStrategy).toBe('clean_source');
    expect(result.notes[0]).toMatch(/no processing needed/i);
  });

  it('never filters a clean source, even under Force removal', async () => {
    const { runner, calls } = recordingRunner();
    // There is no watermark on a clean stream, so "force" has nothing to do.
    const result = await processorFor(runner).process(
      input({ watermarkMode: 'force_removal', outroMode: 'never' }),
    );

    expect(calls).toHaveLength(0);
    expect(result.reEncoded).toBe(false);
  });

  it('does not run outro detection on a clean source', async () => {
    const { runner, calls } = recordingRunner();
    // Section 9: clean sources rarely carry an end card, and a false positive
    // there would cut real content for no benefit.
    await processorFor(runner).process(input({ outroMode: 'always' }));

    expect(calls).toHaveLength(0);
  });

  it('leaves a watermarked file alone when the user wants it kept', async () => {
    const { runner, calls } = recordingRunner();
    const result = await processorFor(runner).process(
      input({ sourceStrategy: 'raw', watermarkMode: 'keep', outroMode: 'never' }),
    );

    expect(calls).toHaveLength(0);
    expect(result.watermarkRemoved).toBe(false);
    expect(result.notes[0]).toMatch(/kept by preference/i);
  });
});

describe('degraded environments', () => {
  it('saves the file unprocessed rather than failing when ffmpeg is missing', async () => {
    const { runner, calls } = recordingRunner();
    const result = await processorFor(runner, null).process(input({ sourceStrategy: 'raw' }));

    expect(calls).toHaveLength(0);
    expect(result.watermarkRemoved).toBe(false);
    expect(result.notes.join(' ')).toMatch(/ffmpeg unavailable/i);
  });

  it('surfaces a failed ffmpeg run as FFMPEG_FAILED rather than claiming success', async () => {
    const runner: ProcessRunner = {
      run: vi.fn(async (): Promise<ProcessResult> => ({
        stdout: '',
        stderr: 'Error initializing filter graph',
        exitCode: 1,
        timedOut: false,
      })),
    };

    // Sampling fails first (so the plan degrades to static-blur), then the
    // filtering run fails too. Reporting the file as processed would be a lie.
    await expect(
      processorFor(runner).process(input({ sourceStrategy: 'raw', outroMode: 'never' })),
    ).rejects.toMatchObject({ code: 'FFMPEG_FAILED' });
  });

  it('chooses the static tier when no frames can be sampled', async () => {
    // Sampling fails, the filtering run succeeds: the crude fallback is used
    // and flagged, rather than the item being left watermarked.
    const dir = mkdtempSync(join(tmpdir(), 'postprocess-'));
    const filePath = join(dir, 'video.mp4');
    writeFileSync(filePath, Buffer.alloc(2_048, 1));

    let call = 0;
    const runner: ProcessRunner = {
      run: vi.fn(async (_command: string, args: readonly string[]): Promise<ProcessResult> => {
        call++;
        // First call is the frame sampling; fail it, succeed at everything else.
        if (call === 1) return { stdout: '', stderr: '', exitCode: 1, timedOut: false };
        // Stand in for ffmpeg actually writing its output file.
        const output = args[args.length - 1] as string;
        writeFileSync(output, Buffer.alloc(1_024, 2));
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      }),
    };

    const result = await processorFor(runner).process(
      input({ filePath, sourceStrategy: 'raw', outroMode: 'never' }),
    );

    expect(result.usedStaticFallback).toBe(true);
    expect(result.sourceStrategy).toBe('blur');
    expect(result.watermarkRemoved).toBe(true);
    // Section 9 requires the user to be told a fallback was used.
    expect(result.notes.join(' ')).toMatch(/no frames could be sampled/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a zero-exit run that produced no file rather than throwing ENOENT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postprocess-empty-'));
    const filePath = join(dir, 'video.mp4');
    writeFileSync(filePath, Buffer.alloc(1_024, 1));

    // Succeeds on every call but never writes an output file.
    const runner: ProcessRunner = {
      run: vi.fn(async (): Promise<ProcessResult> => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })),
    };

    await expect(
      processorFor(runner).process(input({ filePath, sourceStrategy: 'raw', outroMode: 'never' })),
    ).rejects.toMatchObject({ code: 'FFMPEG_FAILED' });

    // The original must survive a failed post-process.
    expect(statSync(filePath).size).toBe(1_024);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('signal helpers', () => {
  it('reports identical frames as no change and inverted frames as total change', () => {
    const a = new Uint8Array([0, 128, 255, 64]);
    const same = new Uint8Array([0, 128, 255, 64]);
    const inverted = new Uint8Array([255, 127, 0, 191]);

    expect(meanAbsoluteDifference(a, same)).toBe(0);
    expect(meanAbsoluteDifference(a, inverted)).toBeGreaterThan(0.6);
  });

  it('treats a missing comparison frame as fully changed, not as static', () => {
    // Reading an absent predecessor as "no change" would make the first slice
    // of every window look like a frozen end card.
    expect(meanAbsoluteDifference(new Uint8Array(0), new Uint8Array(0))).toBe(1);
  });

  it('scores a flat frame as fully uniform and a noisy one as not', () => {
    const flat = new Uint8Array(256).fill(30);
    const noisy = new Uint8Array(256).map((_, i) => (i * 7) % 256);

    expect(dominantShare(flat)).toBe(1);
    expect(dominantShare(noisy)).toBeLessThan(0.2);
  });

  it('computes silence and loudness from PCM', () => {
    const silence = Buffer.alloc(8_000 * 2);
    expect(computeRms(silence, 1, 1_000)[0]).toBe(0);

    const loud = Buffer.alloc(8_000 * 2);
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(20_000, i);
    expect(computeRms(loud, 1, 1_000)[0]).toBeGreaterThan(0.5);
  });

  it('reports slices with no audio as silent rather than crashing', () => {
    expect(computeRms(Buffer.alloc(0), 3, 1_000)).toEqual([0, 0, 0]);
  });
});
