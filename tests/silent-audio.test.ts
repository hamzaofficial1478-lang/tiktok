import { describe, expect, it } from 'vitest';
import { selectStream, isHevc } from '@main/download/stream-selector';
import type { StreamCandidate } from '@main/resolve/types';
import { YtDlpExtractor } from '@main/resolve/yt-dlp-extractor';

/** The real extractor over a canned yt-dlp response. */
function extractorFor(payload: unknown): YtDlpExtractor {
  return new YtDlpExtractor({
    binaryPath: '/fake/yt-dlp',
    runner: { run: async () => ({ stdout: JSON.stringify(payload), stderr: '', exitCode: 0, timedOut: false }) },
  });
}

/**
 * The silent-download bug, and the black-screen one beside it.
 *
 * Some videos in a batch arrived with no sound. The cause was a single
 * expression in the extractor:
 *
 *     const hasAudio = format.acodec !== 'none' && format.acodec !== undefined
 *       ? format.acodec !== 'none'
 *       : true;
 *
 * which returns `true` for every input, `acodec: 'none'` included — exactly how
 * yt-dlp labels a video-only stream. The selector therefore believed the
 * highest-quality stream already had sound, never asked for the audio track to
 * be merged, and produced a perfect silent picture.
 */

function stream(overrides: Partial<StreamCandidate> & { id: string }): StreamCandidate {
  return {
    url: `https://cdn.example/${overrides.id}.mp4`,
    watermarked: false,
    kind: 'video',
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: 2_000,
    filesize: 1_000_000,
    ext: 'mp4',
    codec: 'h264',
    headers: {},
    hasAudio: false,
    preference: 0,
    ...overrides,
  };
}

const AUDIO = stream({ id: 'audio', kind: 'audio', hasAudio: true, width: null, height: null, codec: 'aac' });

describe('a video-only stream never arrives silent', () => {
  it('merges the separate audio track into the best picture', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr_1080', width: 1080, height: 1920, hasAudio: false }),
        stream({ id: 'play_addr_720', width: 720, height: 1280, hasAudio: true }),
        AUDIO,
      ],
      { audioOnly: false, watermarkMode: 'auto' },
    );

    // Best picture kept, sound restored, nothing traded.
    expect(result.stream.id).toBe('play_addr_1080');
    expect(result.audioStream?.id).toBe('audio');
    expect(result.formatId).toBe('play_addr_1080+audio');
  });

  it('drops to a muxed stream when there is no audio track to merge', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr_1080', width: 1080, height: 1920, hasAudio: false }),
        stream({ id: 'play_addr_720', width: 720, height: 1280, hasAudio: true }),
      ],
      { audioOnly: false, watermarkMode: 'auto' },
    );

    // Sound outranks resolution only when there is no way to have both.
    expect(result.stream.id).toBe('play_addr_720');
    expect(result.formatId).toBe('play_addr_720');
  });

  it('says so plainly when the post genuinely has no sound', () => {
    const result = selectStream([stream({ id: 'play_addr', hasAudio: false })], {
      audioOnly: false,
      watermarkMode: 'auto',
    });

    expect(result.formatId).toBe('play_addr');
    expect(result.reason).toMatch(/offers no audio/i);
  });
});

describe('without ffmpeg, a merge cannot be asked for', () => {
  it('takes the best stream that already carries its own sound', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr_1080', width: 1080, height: 1920, hasAudio: false }),
        stream({ id: 'play_addr_720', width: 720, height: 1280, hasAudio: true }),
        AUDIO,
      ],
      { audioOnly: false, watermarkMode: 'auto', canMerge: false },
    );

    // Asking for `1080+audio` with no ffmpeg does not produce a silent file,
    // it produces a failed download — so the smaller usable one wins.
    expect(result.stream.id).toBe('play_addr_720');
    expect(result.formatId).not.toContain('+');
    expect(result.reason).toMatch(/ffmpeg/i);
  });

  it('still merges when ffmpeg is there', () => {
    const result = selectStream(
      [stream({ id: 'play_addr_1080', hasAudio: false }), AUDIO],
      { audioOnly: false, watermarkMode: 'auto', canMerge: true },
    );
    expect(result.formatId).toBe('play_addr_1080+audio');
  });
});

describe('H.265, and the black picture it produces on Windows', () => {
  it('recognises every name the codec goes by', () => {
    expect(isHevc(stream({ id: 'a', codec: 'h265' }))).toBe(true);
    expect(isHevc(stream({ id: 'b', codec: 'hevc' }))).toBe(true);
    expect(isHevc(stream({ id: 'c', codec: 'hev1.1.6.L93.B0' }))).toBe(true);
    expect(isHevc(stream({ id: 'play_addr_bytevc1', codec: null }))).toBe(true);
    expect(isHevc(stream({ id: 'e', codec: 'h264' }))).toBe(false);
    expect(isHevc(stream({ id: 'f', codec: 'avc1.640028' }))).toBe(false);
  });

  it('prefers H.264 at the same resolution, which costs no quality at all', () => {
    const result = selectStream(
      [
        // The H.265 stream is given the higher bitrate deliberately: the old
        // tie-break was bitrate alone, so only the codec rule can pick the
        // H.264 one here. Otherwise the test passes without the fix.
        stream({ id: 'play_addr_bytevc1', codec: 'h265', bitrate: 2_400, hasAudio: true }),
        stream({ id: 'play_addr', codec: 'h264', bitrate: 1_400, hasAudio: true }),
      ],
      { audioOnly: false, watermarkMode: 'auto' },
    );

    expect(result.stream.id).toBe('play_addr');
  });

  it('still takes H.265 when it is genuinely the higher resolution, and warns', () => {
    // Quality is not traded for compatibility; the user is told instead.
    const result = selectStream(
      [
        stream({ id: 'play_addr_bytevc1', codec: 'h265', width: 1080, height: 1920, hasAudio: true }),
        stream({ id: 'play_addr', codec: 'h264', width: 720, height: 1280, hasAudio: true }),
      ],
      { audioOnly: false, watermarkMode: 'auto' },
    );

    expect(result.stream.id).toBe('play_addr_bytevc1');
    expect(result.reason).toMatch(/HEVC Video Extensions/i);
  });

  it('does not mention HEVC when H.264 won', () => {
    const result = selectStream([stream({ id: 'play_addr', codec: 'h264', hasAudio: true })], {
      audioOnly: false,
      watermarkMode: 'auto',
    });
    expect(result.reason).not.toMatch(/HEVC/i);
  });
});

describe('where the flag actually came from', () => {
  it('reads acodec: none as no audio, which the old expression could not', () => {
    // The one case that mattered, straight through the real extractor.
    const payload = {
      id: '7123456789012345678',
      formats: [
        { format_id: 'play_addr', url: 'https://cdn/v.mp4', vcodec: 'h264', acodec: 'none', height: 1920, width: 1080 },
        { format_id: 'audio', url: 'https://cdn/a.m4a', vcodec: 'none', acodec: 'mp4a.40.2' },
      ],
    };

    return extractorFor(payload)
      .resolve('https://www.tiktok.com/@a/video/7123456789012345678')
      .then((resolved) => {
        const video = resolved.streams.find((s) => s.id === 'play_addr');
        expect(video?.hasAudio).toBe(false);

        // And end to end: the selector now asks for the merge.
        const selection = selectStream(resolved.streams, { audioOnly: false, watermarkMode: 'auto' });
        expect(selection.formatId).toBe('play_addr+audio');
      });
  });

  it('still reads a real codec as audio present', async () => {
    const payload = {
      id: '7123456789012345678',
      formats: [
        { format_id: 'play_addr', url: 'https://cdn/v.mp4', vcodec: 'h264', acodec: 'mp4a.40.2', height: 1920 },
      ],
    };
    const resolved = await extractorFor(payload).resolve('https://www.tiktok.com/@a/video/7123456789012345678');
    expect(resolved.streams[0]?.hasAudio).toBe(true);
  });
});
