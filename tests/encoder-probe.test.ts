import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { EncoderProbe } from '@main/postprocess/encoder-probe';
import { encoderCandidates } from '@main/postprocess/encoder';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';
import type { MediaCapabilities } from '@shared/ipc/contract';

const silent = pino({ level: 'silent' });

/** What `ffmpeg -encoders` reports: everything the build was compiled with. */
function capabilities(...names: readonly string[]): MediaCapabilities {
  return {
    ffmpeg: true,
    ffprobe: true,
    filters: {},
    encoders: Object.fromEntries(names.map((name) => [name, true])),
    missingRequired: [],
    isGplBuild: false,
  } as unknown as MediaCapabilities;
}

/** Succeeds for the named encoders, fails for every other one. */
function runnerWhere(working: readonly string[]): { runner: ProcessRunner; tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    runner: {
      run: async (_cmd, args): Promise<ProcessResult> => {
        const encoder = args[args.indexOf('-c:v') + 1] ?? '';
        tried.push(encoder);
        return working.includes(encoder)
          ? { stdout: '', stderr: '', exitCode: 0, timedOut: false }
          : { stdout: '', stderr: 'Cannot load nvcuda.dll', exitCode: 1, timedOut: false };
      },
    },
  };
}

const probeWith = (runner: ProcessRunner): EncoderProbe =>
  new EncoderProbe({ ffmpegPath: () => '/fake/ffmpeg', runner, log: silent });

/**
 * An encoder that is compiled in is not an encoder that runs.
 *
 * The LGPL ffmpeg builds this app installs are compiled with NVENC, QuickSync,
 * AMF and VAAPI support, so `ffmpeg -encoders` lists all four on a laptop with
 * none of that hardware. Taking the first name off that list and committing to
 * it is how a video that needed converting to H.264 was handed to an encoder
 * that cannot open its device: the encode failed, the failure was caught so
 * that a filter chain could not cost somebody their download, and the file
 * quietly stayed H.265. It plays locally. Facebook refuses it.
 */
describe('finding an encoder that actually works here', () => {
  it('skips past the ones this machine cannot run', async () => {
    const { runner } = runnerWhere(['libopenh264']);
    const usable = await probeWith(runner).usable(capabilities('h264_nvenc', 'h264_qsv', 'libopenh264'), true);

    expect(usable.map((encoder) => encoder.name)).toEqual(['libopenh264']);
  });

  it('keeps a hardware encoder that does work, and stops looking after it', async () => {
    const { runner, tried } = runnerWhere(['h264_qsv', 'libopenh264']);
    const usable = await probeWith(runner).usable(capabilities('h264_nvenc', 'h264_qsv', 'libopenh264'), true);

    // Hardware first, then the software fallback behind it as a safety net for
    // an encoder that starts on a test frame and fails on a real video.
    expect(usable.map((encoder) => encoder.name)).toEqual(['h264_qsv', 'libopenh264']);
    expect(tried).toEqual(['h264_nvenc', 'h264_qsv', 'libopenh264']);
  });

  it('tests each encoder once, however many videos there are', async () => {
    const { runner, tried } = runnerWhere(['libopenh264']);
    const probe = probeWith(runner);

    await probe.usable(capabilities('h264_nvenc', 'libopenh264'), true);
    await probe.usable(capabilities('h264_nvenc', 'libopenh264'), true);
    await probe.usable(capabilities('h264_nvenc', 'libopenh264'), true);

    // A spawn per encoder per video would be three hundred pointless processes
    // in a three-hundred-item batch.
    expect(tried).toEqual(['h264_nvenc', 'libopenh264']);
  });

  /**
   * The case the test frame cannot see: an encoder that opens fine on 64x64
   * black and falls over on a real 1080x1920 video — a busy GPU, a session
   * limit, a driver that only misbehaves under load.
   */
  it('drops an encoder that failed on a real video', async () => {
    const { runner } = runnerWhere(['h264_nvenc', 'libopenh264']);
    const probe = probeWith(runner);

    expect((await probe.usable(capabilities('h264_nvenc', 'libopenh264'), true))[0]?.name).toBe('h264_nvenc');

    probe.reject('h264_nvenc');
    expect((await probe.usable(capabilities('h264_nvenc', 'libopenh264'), true))[0]?.name).toBe('libopenh264');
  });

  it('reports nothing usable rather than throwing, when nothing is', async () => {
    const { runner } = runnerWhere([]);
    // The caller keeps the download exactly as it was downloaded, which for
    // most videos is already H.264 and uploads fine. Throwing here would take
    // a perfectly good download down with it.
    expect(await probeWith(runner).usable(capabilities('h264_nvenc'), true)).toEqual([]);
  });

  it('spawns nothing when ffmpeg is not installed', async () => {
    const { runner, tried } = runnerWhere(['libopenh264']);
    const probe = new EncoderProbe({ ffmpegPath: () => null, runner, log: silent });

    expect(await probe.usable(capabilities('libopenh264'), true)).toEqual([]);
    expect(tried).toEqual([]);
  });

  it('honours the software-only preference', async () => {
    const { runner, tried } = runnerWhere(['h264_nvenc', 'libopenh264']);
    const usable = await probeWith(runner).usable(capabilities('h264_nvenc', 'libopenh264'), false);

    expect(usable.map((encoder) => encoder.name)).toEqual(['libopenh264']);
    expect(tried).toEqual(['libopenh264']);
  });
});

describe('the candidate list', () => {
  it('offers no encoder that is not H.264', () => {
    /**
     * `mpeg4` used to be the last entry, as a "universally available" fallback.
     * It is MPEG-4 Part 2 — the DivX-era codec — and every upload form refuses
     * it, while its presence satisfied the check that says this build has an
     * H.264 encoder. A machine with no hardware encoder and no libopenh264
     * therefore believed it was fine and produced a library that plays locally
     * and uploads nowhere.
     */
    const all = encoderCandidates(capabilities('h264_nvenc', 'libopenh264', 'mpeg4'), true);
    expect(all.map((encoder) => encoder.name)).not.toContain('mpeg4');
    for (const encoder of all) expect(encoder.name).toMatch(/h264|openh264/);
  });
});
