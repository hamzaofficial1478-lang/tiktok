import { describe, expect, it } from 'vitest';
import { selectStream, isHevc } from '@main/download/stream-selector';
import type { StreamCandidate } from '@main/resolve/types';
import { DEFAULT_CONFIG } from '@shared/config-schema';
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

  /**
   * Wanting H.264 is not a reason to download less of the video.
   *
   * This used to filter every H.265 stream out, which is a reasonable-sounding
   * rule that did the worst thing in the program: TikTok routinely publishes
   * its top resolution *only* as H.265, so the filter left the best available
   * H.264 — 480p against a 1080p source. The download then succeeded, said
   * nothing, and produced a video good for nothing. Asking for compatibility
   * got a quarter of the picture, permanently, and no processing afterwards
   * could put those pixels back.
   *
   * The picture is chosen first and the codec is dealt with second, by
   * converting the file at the resolution that was downloaded.
   */
  it('takes the larger H.265 stream and converts it, rather than downloading a smaller one', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr_bytevc1', codec: 'h265', width: 1080, height: 1920, hasAudio: true }),
        stream({ id: 'play_addr', codec: 'h264', width: 480, height: 854, hasAudio: true }),
      ],
      { audioOnly: false, watermarkMode: 'auto', forceH264: true },
    );

    expect(result.stream.id).toBe('play_addr_bytevc1');
    expect(result.needsH264Transcode).toBe(true);
    expect(result.reason).toMatch(/converted to H\.264/i);
  });

  it('asks for no conversion when H.264 already is the best picture', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr_bytevc1', codec: 'h265', width: 720, height: 1280, hasAudio: true }),
        stream({ id: 'play_addr', codec: 'h264', width: 1080, height: 1920, hasAudio: true }),
      ],
      { audioOnly: false, watermarkMode: 'auto', forceH264: true },
    );

    // Nothing to convert, so nothing is re-encoded: the best stream is already
    // the compatible one.
    expect(result.stream.id).toBe('play_addr');
    expect(result.needsH264Transcode).toBeUndefined();
  });

  it('leaves H.265 alone when compatibility was not asked for', () => {
    const result = selectStream(
      [stream({ id: 'play_addr_bytevc1', codec: 'h265', width: 1080, height: 1920, hasAudio: true })],
      { audioOnly: false, watermarkMode: 'auto', forceH264: false },
    );

    expect(result.stream.id).toBe('play_addr_bytevc1');
    expect(result.needsH264Transcode).toBeUndefined();
    expect(result.reason).toMatch(/HEVC Video Extensions/i);
  });

  it('never costs resolution on a stock install', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr_bytevc1', codec: 'h265', width: 1080, height: 1920, hasAudio: true }),
        stream({ id: 'play_addr', codec: 'h264', width: 480, height: 854, hasAudio: true }),
      ],
      { audioOnly: false, watermarkMode: 'auto', forceH264: DEFAULT_CONFIG.forceH264 },
    );

    // The one that matters: whatever the defaults are, they must not hand
    // someone 480p from a 1080p source.
    expect(result.stream.width).toBe(1080);
  });
});
