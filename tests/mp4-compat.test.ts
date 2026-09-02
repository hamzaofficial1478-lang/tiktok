import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessCompatibility,
  assessUploadability,
  indexIsAtTheEnd,
  makeUploadable,
  readTopLevelBoxes,
  type Mp4Box,
} from '@main/download/mp4-compat';
import type { ProbeResult, ProbedStream } from '@main/media/ffprobe';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';

/**
 * The upload that Facebook refused, and the black rectangle it played back.
 *
 * Neither symptom names a cause, and there were two: an MP4 whose index sits
 * after the media data, which anything reading the start of a file to identify
 * it cannot cope with; and an H.265 stream labelled `hev1` rather than `hvc1`,
 * which Apple's stack rejects outright and several web players show as black.
 * The same videos from another downloader worked, which is what made it look
 * like a fault in this app rather than in the file.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mp4-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A box header: 4-byte big-endian length, then the 4-character type. */
function box(type: string, payloadBytes: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payloadBytes + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
}

function writeMp4(name: string, order: readonly [string, number][]): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat(order.map(([type, size]) => box(type, size))));
  return path;
}

const stream = (patch: Partial<ProbedStream>): ProbedStream => ({
  codecType: 'video',
  codecName: 'h264',
  codecTag: 'avc1',
  pixelFormat: 'yuv420p',
  width: 1080,
  height: 1920,
  frameRate: 30,
  ...patch,
});

const probeOf = (...streams: ProbedStream[]): ProbeResult => ({
  durationMs: 12_000,
  sizeBytes: 4_096,
  bitrate: 1_000_000,
  formatName: 'mov,mp4,m4a',
  streams,
});

describe('reading the container without reading the file', () => {
  it('lists the top-level boxes in file order', () => {
    const path = writeMp4('a.mp4', [
      ['ftyp', 24],
      ['moov', 512],
      ['mdat', 2_048],
    ]);

    expect(readTopLevelBoxes(path).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
  });

  it('follows a 64-bit box length', () => {
    // `size == 1` means the real length is the next eight bytes — how a large
    // mdat is written, which is exactly the case that matters here.
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(BigInt(1_024 + 16), 8);

    const path = join(dir, 'big.mp4');
    writeFileSync(path, Buffer.concat([box('ftyp', 16), header, Buffer.alloc(1_024), box('moov', 64)]));

    expect(readTopLevelBoxes(path).map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
  });

  it('treats a zero length as "runs to the end", and stops there', () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0, 0);
    header.write('mdat', 4, 'latin1');

    const path = join(dir, 'zero.mp4');
    writeFileSync(path, Buffer.concat([box('ftyp', 16), header, Buffer.alloc(512)]));

    expect(readTopLevelBoxes(path).map((b) => b.type)).toEqual(['ftyp', 'mdat']);
  });

  it('gives up rather than looping on a nonsense length', () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(3, 0); // smaller than the header itself
    header.write('junk', 4, 'latin1');

    const path = join(dir, 'bad.mp4');
    writeFileSync(path, Buffer.concat([box('ftyp', 16), header, Buffer.alloc(64)]));

    expect(readTopLevelBoxes(path).map((b) => b.type)).toEqual(['ftyp']);
  });
});

describe('where the index sits', () => {
  const boxes = (...types: string[]): Mp4Box[] => types.map((type) => ({ type, size: 100 }));

  it('is at the end when moov follows mdat', () => {
    expect(indexIsAtTheEnd(boxes('ftyp', 'mdat', 'moov'))).toBe(true);
  });

  it('is at the front when moov precedes mdat', () => {
    expect(indexIsAtTheEnd(boxes('ftyp', 'moov', 'mdat'))).toBe(false);
  });

  it('says nothing about a file it could not parse', () => {
    // No claim either way. Rewriting a file on a guess about its structure is
    // how a working download becomes a broken one.
    expect(indexIsAtTheEnd(boxes('ftyp'))).toBe(false);
    expect(indexIsAtTheEnd([])).toBe(false);
  });
});

describe('deciding whether a file needs rewriting', () => {
  const boxes = (...types: string[]): Mp4Box[] => types.map((type) => ({ type, size: 100 }));

  it('leaves a well-formed H.264 file completely alone', () => {
    const verdict = assessCompatibility({
      boxes: boxes('ftyp', 'moov', 'mdat'),
      probe: probeOf(stream({})),
    });

    // The common case, and it must cost nothing: rewriting every download
    // unconditionally would spend a full copy of every video on the majority
    // that need none.
    expect(verdict.needed).toBe(false);
  });

  it('spots an index written after the media data', () => {
    const verdict = assessCompatibility({
      boxes: boxes('ftyp', 'mdat', 'moov'),
      probe: probeOf(stream({})),
    });

    expect(verdict.faststart).toBe(true);
    expect(verdict.needed).toBe(true);
    expect(verdict.reason).toMatch(/index is at the end/i);
  });

  it('spots H.265 labelled hev1', () => {
    const verdict = assessCompatibility({
      boxes: boxes('ftyp', 'moov', 'mdat'),
      probe: probeOf(stream({ codecName: 'hevc', codecTag: 'hev1' })),
    });

    expect(verdict.retagHevc).toBe(true);
    expect(verdict.reason).toMatch(/hev1 rather than hvc1/i);
  });

  it('leaves H.265 that is already labelled hvc1 alone', () => {
    const verdict = assessCompatibility({
      boxes: boxes('ftyp', 'moov', 'mdat'),
      probe: probeOf(stream({ codecName: 'hevc', codecTag: 'hvc1' })),
    });

    expect(verdict.needed).toBe(false);
  });

  it('does not relabel on a guess when the tag is unknown', () => {
    const verdict = assessCompatibility({
      boxes: boxes('ftyp', 'moov', 'mdat'),
      probe: probeOf(stream({ codecName: 'hevc', codecTag: null })),
    });

    expect(verdict.retagHevc).toBe(false);
  });

  it('never mistakes H.264 for something needing a tag', () => {
    const verdict = assessCompatibility({
      boxes: boxes('ftyp', 'moov', 'mdat'),
      probe: probeOf(stream({ codecName: 'h264', codecTag: 'avc1' })),
    });

    expect(verdict.retagHevc).toBe(false);
  });

  it('reports both faults at once when a file has both', () => {
    const verdict = assessCompatibility({
      boxes: boxes('ftyp', 'mdat', 'moov'),
      probe: probeOf(stream({ codecName: 'hevc', codecTag: 'hev1' })),
    });

    expect(verdict.faststart).toBe(true);
    expect(verdict.retagHevc).toBe(true);
  });

  it('makes no claim at all when nothing probed the file', () => {
    const verdict = assessCompatibility({ boxes: boxes('ftyp', 'moov', 'mdat'), probe: null });
    expect(verdict.needed).toBe(false);
  });
});

function runnerThat(behaviour: (args: readonly string[]) => void): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: async (_cmd, args): Promise<ProcessResult> => {
        calls.push([...args]);
        behaviour(args);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    },
  };
}

/** ffmpeg's output path is the last argument. */
const outputOf = (call: readonly string[]): string => call[call.length - 1] as string;

describe('rewriting the container', () => {
  it('does nothing, and spawns nothing, for a file that is already fine', async () => {
    const path = writeMp4('fine.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat(() => undefined);

    const result = await makeUploadable({ filePath: path, probe: probeOf(stream({})), ffmpegPath: '/fake/ffmpeg', runner });

    expect(result.rewritten).toBe(false);
    expect(calls).toEqual([]);
  });

  it('copies the streams rather than re-encoding them', async () => {
    const path = writeMp4('slow.mp4', [
      ['ftyp', 16],
      ['mdat', 512],
      ['moov', 128],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(700)));

    await makeUploadable({ filePath: path, probe: probeOf(stream({})), ffmpegPath: '/fake/ffmpeg', runner });

    const call = calls[0] ?? [];
    // Byte-for-byte: this cannot change how the video looks or sounds.
    expect(call[call.indexOf('-c') + 1]).toBe('copy');
    expect(call[call.indexOf('-movflags') + 1]).toBe('+faststart');
    // Every stream, so a soft caption track added earlier survives.
    expect(call).toContain('-map');
  });

  it('relabels an hev1 stream as hvc1', async () => {
    const path = writeMp4('hevc.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(700)));

    await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc', codecTag: 'hev1' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
    });

    const call = calls[0] ?? [];
    expect(call[call.indexOf('-tag:v') + 1]).toBe('hvc1');
  });

  it('does not pass a video tag when the codec is H.264', async () => {
    const path = writeMp4('h264.mp4', [
      ['ftyp', 16],
      ['mdat', 512],
      ['moov', 128],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(700)));

    await makeUploadable({ filePath: path, probe: probeOf(stream({})), ffmpegPath: '/fake/ffmpeg', runner });

    expect(calls[0] ?? []).not.toContain('-tag:v');
  });

  it('puts the rewritten file in place of the original', async () => {
    const path = writeMp4('replace.mp4', [
      ['ftyp', 16],
      ['mdat', 512],
      ['moov', 128],
    ]);
    const { runner } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.from('rewritten')));

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({})),
      ffmpegPath: '/fake/ffmpeg',
      runner,
    });

    expect(result.rewritten).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('rewritten');
  });

  /**
   * Converting the codec instead of downloading less of the video.
   *
   * Asking for H.264 used to mean fetching an H.264 *stream*, and TikTok
   * publishes its top resolution only as H.265 for plenty of videos — so the
   * request quietly delivered 480p from a 1080p source. The picture is chosen
   * first now and the codec dealt with here, at whatever resolution arrived.
   */
  it('re-encodes an H.265 video to H.264 when asked, and only the video', async () => {
    const path = writeMp4('hevc-convert.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc', codecTag: 'hvc1' }), stream({ codecType: 'audio', codecName: 'aac' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'h264_nvenc', args: ['-cq', '19'] }] },
    });

    const call = calls[0] ?? [];
    expect(result.rewritten).toBe(true);
    expect(call[call.indexOf('-c:v') + 1]).toBe('h264_nvenc');
    // The audio is already AAC; a second generation of loss on it would buy
    // nothing at all.
    expect(call[call.indexOf('-c') + 1]).toBe('copy');
    // No scaling, no filters: converting exists to keep the picture.
    expect(call).not.toContain('-vf');
    expect(call).not.toContain('-s');
  });

  it('runs the conversion even when the container is otherwise perfect', async () => {
    // `assessCompatibility` only judges how the file is written. The codec
    // inside it is a separate question, and would have been skipped entirely.
    const path = writeMp4('hevc-tidy.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc', codecTag: 'hvc1' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'libopenh264', args: [] }] },
    });

    expect(calls).toHaveLength(1);
  });

  it('does not re-encode a video that is already H.264', async () => {
    const path = writeMp4('already-h264.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat(() => undefined);

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'h264', codecTag: 'avc1' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'h264_nvenc', args: [] }] },
    });

    // Nothing to convert and nothing wrong with the container, so no encode is
    // spent and no generation of quality is lost.
    expect(result.rewritten).toBe(false);
    expect(calls).toEqual([]);
  });

  /**
   * Sharpening rides in whichever encode is already happening.
   *
   * A file that needs both a codec conversion and a sharpen would otherwise be
   * decoded and encoded twice, and two generations of loss to do what one pass
   * can do is exactly the quiet quality cost this program has been bitten by
   * before.
   */
  it('applies a filter and the conversion in one pass', async () => {
    const path = writeMp4('both.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc', codecTag: 'hev1' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'h264_nvenc', args: ['-cq', '19'] }] },
      videoFilter: 'unsharp=5:5:0.9:5:5:0.0',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] ?? [];
    expect(call[call.indexOf('-vf') + 1]).toBe('unsharp=5:5:0.9:5:5:0.0');
    expect(call[call.indexOf('-c:v') + 1]).toBe('h264_nvenc');
  });

  it('re-encodes for a filter alone, on a file with nothing else wrong', async () => {
    const path = writeMp4('sharpen-only.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'h264', codecTag: 'avc1' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'libopenh264', args: [] }] },
      videoFilter: 'unsharp=5:5:0.5:5:5:0.0',
    });

    // A filter cannot be applied to a copied stream, so asking for one is
    // asking for an encode whatever else is or is not wrong with the file.
    expect(result.rewritten).toBe(true);
    expect(calls[0]).toContain('-vf');
    expect((calls[0] ?? []).indexOf('-c:v')).toBeGreaterThan(-1);
  });

  it('keeps the download exactly as it was when ffmpeg fails', async () => {
    const path = writeMp4('fail.mp4', [
      ['ftyp', 16],
      ['mdat', 512],
      ['moov', 128],
    ]);
    const original = readFileSync(path);
    const runner: ProcessRunner = {
      run: async () => ({ stdout: '', stderr: 'Invalid data', exitCode: 1, timedOut: false }),
    };

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({})),
      ffmpegPath: '/fake/ffmpeg',
      runner,
    });

    // A file with its index in the wrong place still plays locally. Losing it
    // to a failed remux would be a far worse outcome than keeping it.
    expect(result.rewritten).toBe(false);
    expect(readFileSync(path)).toEqual(original);
  });

  it('refuses an empty result rather than committing it', async () => {
    const path = writeMp4('empty.mp4', [
      ['ftyp', 16],
      ['mdat', 512],
      ['moov', 128],
    ]);
    const original = readFileSync(path);
    const { runner } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(0)));

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({})),
      ffmpegPath: '/fake/ffmpeg',
      runner,
    });

    expect(result.rewritten).toBe(false);
    expect(readFileSync(path)).toEqual(original);
  });

  it('says what is wrong when there is no ffmpeg to fix it', async () => {
    const path = writeMp4('noffmpeg.mp4', [
      ['ftyp', 16],
      ['mdat', 512],
      ['moov', 128],
    ]);

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({})),
      ffmpegPath: null,
      runner: { run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) },
    });

    expect(result.rewritten).toBe(false);
    expect(result.reason).toMatch(/index is at the end/i);
  });

  it('leaves no temporary file behind, either way', async () => {
    const path = writeMp4('tidy.mp4', [
      ['ftyp', 16],
      ['mdat', 512],
      ['moov', 128],
    ]);
    const runner: ProcessRunner = {
      run: async () => ({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }),
    };

    await makeUploadable({ filePath: path, probe: probeOf(stream({})), ffmpegPath: '/fake/ffmpeg', runner });

    expect(readFileSync(path).length).toBeGreaterThan(0);
    expect(() => readFileSync(`${path}.compat.mp4`)).toThrow();
  });
});

/**
 * What an upload form will take, which is narrower than what plays.
 *
 * The user's report was "the videos are not getting uploaded on Facebook", and
 * every symptom of that arrives useless: an upload that is refused with a
 * generic apology, or one that succeeds and plays as a black rectangle. Nothing
 * in either message names a codec, so the file has to be judged here before it
 * ever reaches a site.
 */
describe('judging whether a file will upload', () => {
  it('accepts the ordinary case', () => {
    const verdict = assessUploadability(
      probeOf(stream({ codecName: 'h264', pixelFormat: 'yuv420p' }), stream({ codecType: 'audio', codecName: 'aac' })),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('refuses H.265, which is what TikTok serves for its best streams', () => {
    const verdict = assessUploadability(probeOf(stream({ codecName: 'hevc', codecTag: 'hev1' })));
    expect(verdict.videoNeedsEncode).toBe(true);
    expect(verdict.reasons[0]).toMatch(/hevc/);
  });

  it('refuses AV1, which TikTok has begun serving too', () => {
    // The old check asked "is it HEVC?", which answered no here and let an
    // equally unacceptable file through.
    expect(assessUploadability(probeOf(stream({ codecName: 'av1' }))).videoNeedsEncode).toBe(true);
  });

  /**
   * The most confusing version of this failure: the codec name is right and the
   * upload is still refused, so every check that looks correct passes.
   */
  it('refuses 10-bit H.264, whose codec name looks perfectly fine', () => {
    const verdict = assessUploadability(probeOf(stream({ codecName: 'h264', pixelFormat: 'yuv420p10le' })));
    expect(verdict.videoNeedsEncode).toBe(true);
    expect(verdict.reasons[0]).toMatch(/8-bit/);
  });

  it('refuses Opus audio, which a merge can leave inside an MP4', () => {
    const verdict = assessUploadability(
      probeOf(stream({ codecName: 'h264' }), stream({ codecType: 'audio', codecName: 'opus' })),
    );
    expect(verdict.audioNeedsEncode).toBe(true);
    expect(verdict.videoNeedsEncode).toBe(false);
  });

  it('claims nothing about a file nothing could read', () => {
    // Guessing in either direction is worse than saying so: a false "needs
    // converting" spends an encode on a fine file, and a false "fine" is the
    // silence this whole thing exists to end.
    expect(assessUploadability(null)).toEqual({
      ok: true,
      videoNeedsEncode: false,
      audioNeedsEncode: false,
      reasons: [],
    });
  });
});

/**
 * An encoder that is compiled in is not an encoder that runs.
 *
 * `ffmpeg -encoders` lists NVENC, QuickSync, AMF and VAAPI on every one of the
 * LGPL builds this app installs, including on machines with none of that
 * hardware. Committing to the first name and giving up when it failed is how a
 * video that needed converting stayed H.265 — silently, because this pass is
 * caught so a filter cannot cost somebody their download — and was then refused
 * by Facebook days later.
 */
describe('falling through to an encoder that works', () => {
  /** Fails for the named encoders, succeeds for anything else. */
  function runnerFailing(broken: readonly string[]): { runner: ProcessRunner; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      runner: {
        run: async (_cmd, args): Promise<ProcessResult> => {
          calls.push([...args]);
          const encoder = args[args.indexOf('-c:v') + 1];
          if (encoder && broken.includes(encoder)) {
            return { stdout: '', stderr: 'Cannot load nvcuda.dll', exitCode: 1, timedOut: false };
          }
          writeFileSync(outputOf(args), Buffer.alloc(900));
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        },
      },
    };
  }

  const hevcFile = (name: string): string =>
    writeMp4(name, [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);

  it('tries the next encoder when the first cannot open its device', async () => {
    const path = hevcFile('fallback.mp4');
    const { runner, calls } = runnerFailing(['h264_nvenc']);

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: {
        encoders: [
          { name: 'h264_nvenc', args: ['-cq', '19'] },
          { name: 'libopenh264', args: ['-b:v', '10M'] },
        ],
      },
    });

    expect(result.rewritten).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[(calls[1]?.indexOf('-c:v') ?? 0) + 1]).toBe('libopenh264');
  });

  it('says which encoder failed, so the next video does not repeat it', async () => {
    const path = hevcFile('reject.mp4');
    const { runner } = runnerFailing(['h264_nvenc']);
    const rejected: string[] = [];

    await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: {
        encoders: [
          { name: 'h264_nvenc', args: [] },
          { name: 'libopenh264', args: [] },
        ],
      },
      onEncoderFailed: (name) => rejected.push(name),
    });

    expect(rejected).toEqual(['h264_nvenc']);
  });

  it('keeps the download untouched when no encoder on the machine works', async () => {
    const path = hevcFile('none.mp4');
    const before = readFileSync(path);
    const { runner } = runnerFailing(['h264_nvenc', 'libopenh264']);

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: {
        encoders: [
          { name: 'h264_nvenc', args: [] },
          { name: 'libopenh264', args: [] },
        ],
      },
    });

    // A video that cannot be converted is still a video. Losing it would be
    // very much worse than keeping one that some sites will not take.
    expect(result.rewritten).toBe(false);
    expect(readFileSync(path)).toEqual(before);
    // And it says so, which is the part that was missing.
    expect(result.uploadable).toBe(false);
    expect(result.problems[0]).toMatch(/hevc/);
  });

  it('does nothing at all when the build has no H.264 encoder', async () => {
    const path = hevcFile('no-encoder.mp4');
    const { runner, calls } = runnerFailing([]);

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [] },
    });

    // `mpeg4` used to sit at the end of the candidate list as a "last resort".
    // It is MPEG-4 Part 2, not H.264, and every upload form refuses it — so a
    // machine with no real encoder produced a library that plays locally and
    // uploads nowhere. Spawning nothing is the better answer.
    expect(calls).toEqual([]);
    expect(result.rewritten).toBe(false);
  });
});

/**
 * Checking the work rather than assuming it.
 *
 * The pass is caught on purpose, so an attempted conversion that did not happen
 * used to look exactly like one that did. Reading the result is what turns that
 * into something the row can say.
 */
describe('confirming the result', () => {
  it('reports a file that came out still unacceptable', async () => {
    const path = writeMp4('still-wrong.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'h264_nvenc', args: [] }] },
      // ffmpeg claimed success and the file is still H.265 — which is what a
      // hardware encoder that silently produced nothing useful looks like.
      reprobe: async () => probeOf(stream({ codecName: 'hevc' })),
    });

    expect(result.rewritten).toBe(true);
    expect(result.uploadable).toBe(false);
  });

  it('confirms one that came out right', async () => {
    const path = writeMp4('now-fine.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    const result = await makeUploadable({
      filePath: path,
      probe: probeOf(stream({ codecName: 'hevc' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'h264_nvenc', args: [] }] },
      reprobe: async () => probeOf(stream({ codecName: 'h264', pixelFormat: 'yuv420p' })),
    });

    expect(result.uploadable).toBe(true);
    expect(result.problems).toEqual([]);
  });

  /**
   * The file as it is now, not as it was before post-processing.
   *
   * `probe` is taken from the `.part`, before the watermark and caption passes
   * rewrite the video, so deciding from it means deciding about bytes that may
   * no longer exist.
   */
  it('decides from a fresh read rather than the probe taken before processing', async () => {
    const path = writeMp4('already-converted.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    await makeUploadable({
      filePath: path,
      // The old probe says H.265...
      probe: probeOf(stream({ codecName: 'hevc' })),
      ffmpegPath: '/fake/ffmpeg',
      runner,
      toH264: { encoders: [{ name: 'h264_nvenc', args: [] }] },
      // ...but the watermark pass already converted it.
      reprobe: async () => probeOf(stream({ codecName: 'h264', pixelFormat: 'yuv420p' })),
    });

    // No second encode, and so no second generation of loss, on a file that was
    // already correct.
    expect(calls).toEqual([]);
  });
});

/** Audio a merge left in a form no upload form takes. */
describe('audio', () => {
  it('converts Opus to AAC and leaves the video alone', async () => {
    const path = writeMp4('opus.mp4', [
      ['ftyp', 16],
      ['moov', 128],
      ['mdat', 512],
    ]);
    const { runner, calls } = runnerThat((args) => writeFileSync(outputOf(args), Buffer.alloc(900)));

    await makeUploadable({
      filePath: path,
      probe: probeOf(
        stream({ codecName: 'h264', pixelFormat: 'yuv420p' }),
        stream({ codecType: 'audio', codecName: 'opus' }),
      ),
      ffmpegPath: '/fake/ffmpeg',
      runner,
    });

    const call = calls[0] ?? [];
    expect(call[call.indexOf('-c:a') + 1]).toBe('aac');
    // The video was fine, so it is copied rather than encoded again.
    expect(call).not.toContain('-c:v');
  });
});
