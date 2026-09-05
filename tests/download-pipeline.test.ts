import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectStream } from '@main/download/stream-selector';
import {
  previewTemplate,
  renderTemplate,
  resolveOutputDirectory,
  resolveOutputPath,
  sanitizeBasename,
} from '@main/download/filename';
import { verifyDownload } from '@main/download/verify';
import { checkSpace, formatBytes } from '@main/download/disk-space';
import { Ffprobe } from '@main/media/ffprobe';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';
import type { StreamCandidate, VideoMetadata } from '@main/resolve/types';

function stream(overrides: Partial<StreamCandidate>): StreamCandidate {
  return {
    id: 'play_addr',
    url: 'https://cdn/x.mp4',
    headers: {},
    watermarked: false,
    kind: 'video',
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: 2400,
    filesize: 1_000,
    ext: 'mp4',
    codec: 'h264',
    hasAudio: true,
    preference: 0,
    ...overrides,
  };
}

const metadata: VideoMetadata = {
  awemeId: '7123456789012345678',
  authorHandle: 'creator',
  authorName: 'Creator Name',
  caption: 'a caption with #tags',
  durationMs: 12_000,
  coverUrl: null,
  musicTitle: null,
  uploadedAt: Date.UTC(2026, 2, 14),
  hashtags: ['tags'],
  isPhotoPost: false,
  stats: { views: null, likes: null, comments: null, shares: null },
};

describe('stream selection (section 9 step 4)', () => {
  const options = { audioOnly: false, watermarkMode: 'auto' } as const;

  it('keeps higher resolution instead of discarding detail to avoid watermark processing', () => {
    const result = selectStream(
      [
        stream({ id: 'download_addr', watermarked: true, width: 1080, height: 1920 }),
        stream({ id: 'play_addr', watermarked: false, width: 480, height: 854 }),
      ],
      options,
    );

    expect(result.stream.id).toBe('download_addr');
    expect(result.strategy).toBe('raw');
  });

  it('takes the highest resolution TikTok offers, with no setting to lower it', () => {
    const result = selectStream(
      [
        stream({ id: 'low', width: 480, height: 854 }),
        stream({ id: 'high', width: 1080, height: 1920 }),
        stream({ id: 'mid', width: 720, height: 1280 }),
      ],
      options,
    );
    expect(result.stream.id).toBe('high');
  });

  it('falls back to a watermarked source when nothing clean exists', () => {
    const result = selectStream([stream({ id: 'download_addr', watermarked: true })], options);
    expect(result.strategy).toBe('raw');
    expect(result.reason).toMatch(/re-encoding/i);
  });

  it('treats the watermarked variant as first-class when the user wants it kept', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr', width: 480, height: 854 }),
        stream({ id: 'download_addr', watermarked: true, width: 1080, height: 1920 }),
      ],
      { ...options, watermarkMode: 'keep' },
    );
    expect(result.stream.id).toBe('download_addr');
  });

  it('picks the best audio stream when audio-only is requested', () => {
    const result = selectStream(
      [
        stream({ id: 'play_addr' }),
        stream({ id: 'audio-low', kind: 'audio', bitrate: 64 }),
        stream({ id: 'audio-high', kind: 'audio', bitrate: 192 }),
      ],
      { ...options, audioOnly: true },
    );
    expect(result.stream.id).toBe('audio-high');
  });

  it('fails clearly when there is nothing to download', () => {
    // The user-facing message comes from the taxonomy; the specifics live in
    // `detail`, so that is what identifies the cause.
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return (err as { code?: string }).code ?? '';
      }
      throw new Error('expected a throw');
    };

    const detailOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return (err as { detail?: string }).detail ?? '';
      }
      throw new Error('expected a throw');
    };

    expect(detailOf(() => selectStream([], options))).toMatch(/no streams/i);
    /**
     * Audio and no video is a photo post, and saying "no video streams" led
     * the taxonomy to render it as "Extractor out of date" — so a user with a
     * current extractor updated it, was told it was already current, and got
     * the same message again. The post was never a video.
     */
    expect(detailOf(() => selectStream([stream({ kind: 'audio' })], options))).toMatch(/photo slideshow/i);
    expect(codeOf(() => selectStream([stream({ kind: 'audio' })], options))).toBe('UNSUPPORTED_MEDIA');
  });
});

describe('filename templating (section 9 step 9)', () => {
  const context = { metadata, awemeId: metadata.awemeId, index: 3, extension: '.mp4' };

  it('renders every supported token', () => {
    expect(renderTemplate('{author}-{id}-{date}-{index}', context)).toBe(
      'creator-7123456789012345678-2026-03-14-3',
    );
  });

  it('truncates a caption to the requested length', () => {
    const long = { ...context, metadata: { ...metadata, caption: 'x'.repeat(100) } };
    expect(renderTemplate('{caption:20}', long)).toHaveLength(20);
  });

  it('strips characters Windows forbids while keeping spaces and hyphens', () => {
    const hostile = { ...context, metadata: { ...metadata, caption: 'a<b>c:d"e/f\\g|h?i*j - k' } };
    const result = renderTemplate('{caption:80}', hostile);
    for (const char of '<>:"/\\|?*') expect(result, char).not.toContain(char);
    expect(result).toContain(' - ');
  });

  it('keeps emoji and non-Latin scripts, which TikTok captions are full of', () => {
    const unicode = { ...context, metadata: { ...metadata, caption: '日本語 caption 🎬 ok' } };
    const result = renderTemplate('{caption:40}', unicode);
    expect(result).toContain('日本語');
    expect(result).toContain('🎬');
  });

  it('escapes Windows reserved device names', () => {
    expect(sanitizeBasename('CON')).toBe('_CON');
    expect(sanitizeBasename('nul')).toBe('_nul');
    expect(sanitizeBasename('COM1')).toBe('_COM1');
    expect(sanitizeBasename('console')).toBe('console');
  });

  it('removes trailing dots and spaces that Windows would silently drop', () => {
    expect(sanitizeBasename('name...')).toBe('name');
    expect(sanitizeBasename('name   ')).toBe('name');
  });

  it('caps the length so a long caption cannot break the path', () => {
    expect(sanitizeBasename('x'.repeat(400)).length).toBeLessThanOrEqual(180);
  });

  it('tidies dangling separators when a token renders empty', () => {
    const noCaption = { ...context, metadata: { ...metadata, caption: null } };
    // "creator - .mp4" would be an ugly thing to ship.
    expect(renderTemplate('{author} - {caption:40}', noCaption)).toBe('creator');
  });

  it('never produces an empty name', () => {
    expect(sanitizeBasename('***')).toBe('untitled');
  });

  it('leaves an unknown token visible instead of silently blanking it', () => {
    expect(renderTemplate('{author}-{nonsense}', context)).toBe('creator-{nonsense}');
  });

  it('previews a template for the Settings screen', () => {
    expect(previewTemplate('{author} - {id}')).toBe('creator - 7123456789012345678.mp4');
  });
});

describe('collision handling', () => {
  it('suffixes when the name is taken', () => {
    const taken = new Set([join('/out', 'video.mp4'), join('/out', 'video (2).mp4')]);
    const path = resolveOutputPath({
      directory: '/out',
      basename: 'video',
      extension: '.mp4',
      onCollision: 'suffix',
      exists: (p) => taken.has(p),
    });
    expect(path).toBe(join('/out', 'video (3).mp4'));
  });

  it('overwrites when the user chose Replace existing', () => {
    const path = resolveOutputPath({
      directory: '/out',
      basename: 'video',
      extension: '.mp4',
      onCollision: 'replace',
      exists: () => true,
    });
    expect(path).toBe(join('/out', 'video.mp4'));
  });
});

describe('verification (section 9 step 7)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-'));
    filePath = join(dir, 'video.mp4');
    writeFileSync(filePath, Buffer.alloc(2_048, 7));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function ffprobeReturning(payload: unknown, exitCode = 0): Ffprobe {
    const runner: ProcessRunner = {
      run: vi.fn(
        async (): Promise<ProcessResult> => ({
          stdout: JSON.stringify(payload),
          stderr: exitCode === 0 ? '' : 'moov atom not found',
          exitCode,
          timedOut: false,
        }),
      ),
    };
    return new Ffprobe({ binaryPath: '/fake/ffprobe', runner });
  }

  const validProbe = {
    format: { duration: '12.0', size: '2048', bit_rate: '1000', format_name: 'mov,mp4' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30000/1001' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  };

  it('accepts a healthy file', async () => {
    const result = await verifyDownload({
      filePath,
      expectedDurationMs: 12_000,
      audioOnly: false,
      ffprobe: ffprobeReturning(validProbe),
    });
    expect(result.sizeBytes).toBe(2_048);
    expect(result.degraded).toBe(false);
    expect(result.probe?.streams).toHaveLength(2);
  });

  /**
   * The container's label for the stream, kept apart from the codec name.
   *
   * For HEVC the two tags describe identical video and are not treated
   * identically — `hvc1` is what players and upload sites expect, `hev1` is
   * what TikTok writes, and the difference is a refused upload or a black
   * picture. The compatibility pass cannot tell them apart without this.
   */
  it('reports the container tag alongside the codec name', async () => {
    const result = await verifyDownload({
      filePath,
      expectedDurationMs: 12_000,
      audioOnly: false,
      ffprobe: ffprobeReturning({
        format: { duration: '12.0', size: '2048' },
        streams: [{ codec_type: 'video', codec_name: 'hevc', codec_tag_string: 'hev1', width: 1080, height: 1920 }],
      }),
    });

    expect(result.probe?.streams[0]?.codecTag).toBe('hev1');
  });

  it('reads ffprobe\'s placeholder for an untagged stream as no tag at all', async () => {
    const result = await verifyDownload({
      filePath,
      expectedDurationMs: 12_000,
      audioOnly: false,
      ffprobe: ffprobeReturning({
        format: { duration: '12.0', size: '2048' },
        // What ffprobe prints when a stream carries no tag. Reading it as a
        // value would have the compatibility pass relabelling on a guess.
        streams: [{ codec_type: 'video', codec_name: 'h264', codec_tag_string: '[0][0][0][0]' }],
      }),
    });

    expect(result.probe?.streams[0]?.codecTag).toBeNull();
  });

  it('rejects an empty file', async () => {
    writeFileSync(filePath, '');
    await expect(
      verifyDownload({ filePath, expectedDurationMs: null, audioOnly: false, ffprobe: ffprobeReturning(validProbe) }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });

  it('rejects a file with no video stream, which is what a truncated MP4 looks like', async () => {
    const audioOnlyProbe = { ...validProbe, streams: [{ codec_type: 'audio', codec_name: 'aac' }] };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: 12_000, audioOnly: false, ffprobe: ffprobeReturning(audioOnlyProbe) }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });

  it('rejects a duration more than 10% off the metadata', async () => {
    const short = { ...validProbe, format: { ...validProbe.format, duration: '6.0' } };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: 12_000, audioOnly: false, ffprobe: ffprobeReturning(short) }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });

  it('accepts a duration within the tolerance', async () => {
    const slightlyOff = { ...validProbe, format: { ...validProbe.format, duration: '12.9' } };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: 12_000, audioOnly: false, ffprobe: ffprobeReturning(slightlyOff) }),
    ).resolves.toBeDefined();
  });

  it('skips the duration check on very short clips where the tolerance is noise', async () => {
    const tiny = { ...validProbe, format: { ...validProbe.format, duration: '1.4' } };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: 2_000, audioOnly: false, ffprobe: ffprobeReturning(tiny) }),
    ).resolves.toBeDefined();
  });

  /**
   * A real file that this check rejected.
   *
   * TikTok reported 6s, the container probed at 7s, and 10% of six seconds is
   * six tenths — so a perfectly watchable video was reported to the user as
   * corrupt. The percentage is smaller than the error in the number it is
   * compared against: TikTok rounds many durations to whole seconds, and the
   * container counts the last frame's display time.
   */
  it('accepts a whole second of rounding on a short video', async () => {
    const rounded = { ...validProbe, format: { ...validProbe.format, duration: '7.0' } };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: 6_000, audioOnly: false, ffprobe: ffprobeReturning(rounded) }),
    ).resolves.toBeDefined();
  });

  it('does not fail a file for being longer than expected', async () => {
    // Truncation makes a file shorter. A long one is a container quirk, and
    // refusing it throws away a video that plays correctly.
    const longer = { ...validProbe, format: { ...validProbe.format, duration: '20.0' } };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: 12_000, audioOnly: false, ffprobe: ffprobeReturning(longer) }),
    ).resolves.toBeDefined();
  });

  it('still catches the truncation the check exists for', async () => {
    // Half the video missing is not rounding.
    const truncated = { ...validProbe, format: { ...validProbe.format, duration: '3.0' } };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: 12_000, audioOnly: false, ffprobe: ffprobeReturning(truncated) }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });

  it('reports a corrupt file that ffprobe cannot read', async () => {
    await expect(
      verifyDownload({ filePath, expectedDurationMs: null, audioOnly: false, ffprobe: ffprobeReturning({}, 1) }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });

  it('degrades to a size check when ffprobe is not installed', async () => {
    const noProbe = new Ffprobe({ binaryPath: null, runner: { run: vi.fn() } as unknown as ProcessRunner });
    const result = await verifyDownload({
      filePath,
      expectedDurationMs: 12_000,
      audioOnly: false,
      ffprobe: noProbe,
    });
    // Refusing every download because a sidecar is missing would be worse.
    expect(result.degraded).toBe(true);
    expect(result.sizeBytes).toBe(2_048);
  });

  it('requires an audio stream when audio-only was requested', async () => {
    const videoOnly = { ...validProbe, streams: [{ codec_type: 'video', codec_name: 'h264' }] };
    await expect(
      verifyDownload({ filePath, expectedDurationMs: null, audioOnly: true, ffprobe: ffprobeReturning(videoOnly) }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });
});

describe('disk space (section 9 step 5)', () => {
  it('requires room for the file twice over plus headroom', () => {
    const check = checkSpace(tmpdir(), 1_000_000, 100);
    expect(check.requiredBytes).toBe(2_000_100);
  });

  it('does not block the download when free space cannot be determined', () => {
    expect(checkSpace('/definitely/not/a/mount', 1_000).ok).toBe(true);
  });

  it('formats sizes for the error message', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(1_536)).toBe('1.5KB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0GB');
  });
});

describe('CDN headers from the extractor', () => {
  it('carries the headers a stream says it needs', () => {
    // The exact shape yt-dlp reports on a TikTok format.
    const candidate = stream({
      headers: {
        'user-agent': 'Mozilla/5.0 …',
        referer: 'https://www.tiktok.com/',
        cookie: 'ttwid=1%7Cabc',
      },
    });

    expect(candidate.headers.referer).toBe('https://www.tiktok.com/');
    expect(candidate.headers.cookie).toContain('ttwid');
  });
});

describe('an account gets its own folder', () => {
  /**
   * Queued from a profile link, two hundred videos landing loose in the output
   * folder alongside everything else is not a result anyone wanted. The folder
   * they belong in has an obvious name — the account's.
   */
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'outdir-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates the folder and puts the videos in it', () => {
    const directory = resolveOutputDirectory(root, 'blackcloudmc');
    expect(directory).toBe(join(root, 'blackcloudmc'));
    expect(existsSync(directory)).toBe(true);
  });

  it('leaves individually pasted links in the output folder itself', () => {
    // They have no account in common and must not be filed under one.
    expect(resolveOutputDirectory(root, null)).toBe(root);
    expect(resolveOutputDirectory(root, '')).toBe(root);
  });

  /**
   * The handle arrives from a remote response, so it is a path this app did not
   * choose. Both guards are here on purpose: the sanitiser flattens it to one
   * segment, and the result is checked to resolve inside the output folder.
   */
  it('cannot be talked into writing outside the output folder', () => {
    expect(resolveOutputDirectory(root, '../../etc')).toBe(join(root, 'etc'));
    expect(resolveOutputDirectory(root, '..')).toBe(root);
    expect(resolveOutputDirectory(root, 'a/../../b')).toBe(join(root, 'a b'));
    expect(existsSync(join(root, '..', 'etc'))).toBe(false);
  });

  it('handles a name Windows would refuse', () => {
    // A reserved device name is not creatable whatever extension it carries.
    expect(resolveOutputDirectory(root, 'CON')).toBe(join(root, '_CON'));
    expect(resolveOutputDirectory(root, 'na:me?')).toBe(join(root, 'name'));
  });
});

describe('a downloaded video must not be silent', () => {
  /**
   * The reported failure: some videos in a batch had sound and some did not.
   *
   * TikTok's app API offers video-only formats alongside muxed ones, and they
   * are often the highest resolution on offer. Ranking by resolution alone
   * picked those and saved them exactly as served — silent, with nothing in
   * the UI to say why.
   */
  const options = { audioOnly: false, watermarkMode: 'auto' } as const;

  it('keeps the best picture and merges the sound into it', () => {
    // The first fix for this ranked audio above everything, which stopped the
    // silence and quietly cost resolution — TikTok's best format is often
    // video-only. There is no need to choose between them.
    const result = selectStream(
      [
        stream({ id: 'video-only-1080', width: 1080, height: 1920, hasAudio: false }),
        stream({ id: 'muxed-720', width: 720, height: 1280, hasAudio: true }),
        stream({ id: 'audio', kind: 'audio', bitrate: 128 }),
      ],
      options,
    );
    expect(result.stream.id).toBe('video-only-1080');
    expect(result.formatId).toBe('video-only-1080+audio');
  });

  it('takes sound over resolution only when there is no audio track to merge', () => {
    const result = selectStream(
      [
        stream({ id: 'video-only-1080', width: 1080, height: 1920, hasAudio: false }),
        stream({ id: 'muxed-720', width: 720, height: 1280, hasAudio: true }),
      ],
      options,
    );
    expect(result.stream.id).toBe('muxed-720');
    expect(result.formatId).toBe('muxed-720');
  });

  it('merges in the audio when every video track is silent', () => {
    const result = selectStream(
      [
        stream({ id: 'video-only-1080', width: 1080, height: 1920, hasAudio: false }),
        stream({ id: 'audio', kind: 'audio', bitrate: 128, hasAudio: true }),
      ],
      options,
    );
    // yt-dlp's own syntax for "download both and join them".
    expect(result.formatId).toBe('video-only-1080+audio');
    expect(result.audioStream?.id).toBe('audio');
    expect(result.reason).toMatch(/separate audio track is merged in/);
  });

  it('downloads a genuinely silent post, and says that is what it is', () => {
    // Plenty of TikToks have no sound at all; failing them would be wrong.
    const result = selectStream([stream({ id: 'only', hasAudio: false })], options);
    expect(result.stream.id).toBe('only');
    expect(result.formatId).toBe('only');
    expect(result.reason).toMatch(/TikTok offers no audio for this post/);
  });

  it('keeps the higher resolution and sound when a lower clean stream is silent', () => {
    const result = selectStream(
      [
        stream({ id: 'watermarked', watermarked: true, hasAudio: true, width: 1080, height: 1920 }),
        stream({ id: 'clean-silent', watermarked: false, hasAudio: false, width: 480, height: 854 }),
        stream({ id: 'audio', kind: 'audio', bitrate: 128 }),
      ],
      options,
    );
    expect(result.stream.id).toBe('watermarked');
    expect(result.formatId).toBe('watermarked');
  });
});
