import { describe, expect, it, vi } from 'vitest';
import { YtDlpExtractor } from '@main/resolve/yt-dlp-extractor';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';
import {
  AWEME_ID,
  CLEAN_AND_WATERMARKED,
  NO_FORMATS,
  PHOTO_SLIDESHOW,
  SINGLE_FORMAT,
  SPARSE_METADATA,
  STDERR_SAMPLES,
  WATERMARKED_ONLY,
  WEB_API_VARIANT,
} from './fixtures/yt-dlp-payloads';

const CANONICAL = `https://www.tiktok.com/@charlie/video/${AWEME_ID}`;

function runner(result: Partial<ProcessResult>): ProcessRunner {
  return {
    run: vi.fn(
      async (): Promise<ProcessResult> => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        ...result,
      }),
    ),
  };
}

function extractorFor(payload: unknown, overrides: Partial<ProcessResult> = {}): YtDlpExtractor {
  return new YtDlpExtractor({
    binaryPath: '/fake/yt-dlp',
    runner: runner({ stdout: JSON.stringify(payload), ...overrides }),
  });
}

describe('YtDlpExtractor — stream classification', () => {
  it('marks play_addr clean and download_addr watermarked', async () => {
    const resolved = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);

    const byId = Object.fromEntries(resolved.streams.map((s) => [s.id, s]));
    expect(byId['play_addr']?.watermarked).toBe(false);
    expect(byId['play_addr_bytevc1']?.watermarked).toBe(false);
    expect(byId['download_addr']?.watermarked).toBe(true);
  });

  it('recognises the web-API format IDs too', async () => {
    const resolved = await extractorFor(WEB_API_VARIANT).resolve(CANONICAL);
    const byId = Object.fromEntries(resolved.streams.map((s) => [s.id, s]));
    expect(byId['play']?.watermarked).toBe(false);
    expect(byId['download']?.watermarked).toBe(true);
  });

  it('ranks every clean stream above every watermarked one', async () => {
    const resolved = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);
    const sorted = [...resolved.streams].sort((a, b) => b.preference - a.preference);

    const firstWatermarkedIndex = sorted.findIndex((s) => s.watermarked);
    const lastCleanIndex = sorted.map((s) => s.watermarked).lastIndexOf(false);
    // Otherwise a 1080p watermarked stream could outrank a 720p clean one, and
    // section 9's whole point is that clean beats a re-encode.
    expect(lastCleanIndex).toBeLessThan(firstWatermarkedIndex);
    expect(sorted[0]?.id).toBe('play_addr');
  });

  it('prefers higher resolution among clean streams', async () => {
    const resolved = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);
    const clean = resolved.streams.filter((s) => !s.watermarked && s.kind === 'video');
    const best = clean.reduce((a, b) => (a.preference >= b.preference ? a : b));
    expect(best.height).toBe(1920);
  });

  it('separates the audio-only stream, enabling the MP3 option of section 12', async () => {
    const resolved = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);
    const audio = resolved.streams.find((s) => s.id === 'audio');
    expect(audio?.kind).toBe('audio');
    expect(audio?.hasAudio).toBe(true);
    expect(resolved.streams.filter((s) => s.kind === 'video')).toHaveLength(3);
  });

  it('handles a video that only offers a watermarked stream', async () => {
    const resolved = await extractorFor(WATERMARKED_ONLY).resolve(CANONICAL);
    expect(resolved.streams).toHaveLength(1);
    expect(resolved.streams[0]?.watermarked).toBe(true);
  });

  it('accepts a legacy single-format response with no formats array', async () => {
    const resolved = await extractorFor(SINGLE_FORMAT).resolve(CANONICAL);
    expect(resolved.streams).toHaveLength(1);
    expect(resolved.streams[0]?.url).toBe('https://v16.tiktokcdn.com/single.mp4');
  });
});

describe('YtDlpExtractor — metadata', () => {
  it('maps every field the library schema stores', async () => {
    const { metadata } = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);

    expect(metadata.awemeId).toBe(AWEME_ID);
    expect(metadata.authorHandle).toBe('charlie');
    expect(metadata.authorName).toBe('Charlie Example');
    expect(metadata.caption).toBe('a caption with #tags and #more');
    expect(metadata.durationMs).toBe(12_400);
    expect(metadata.coverUrl).toBe('https://p16.tiktokcdn.com/cover.jpeg');
    expect(metadata.musicTitle).toBe('original sound - charlie');
    expect(metadata.uploadedAt).toBe(1_700_000_000_000);
    expect(metadata.stats).toEqual({ views: 120_000, likes: 9_400, comments: 210, shares: 55 });
  });

  it('extracts unique hashtags from the caption', async () => {
    const { metadata } = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);
    expect(metadata.hashtags).toEqual(['tags', 'more']);
  });

  it('falls back to upload_date when no timestamp is present', async () => {
    const payload = { ...CLEAN_AND_WATERMARKED, timestamp: null, upload_date: '20231114' };
    const { metadata } = await extractorFor(payload).resolve(CANONICAL);
    expect(metadata.uploadedAt).toBe(Date.UTC(2023, 10, 14));
  });

  it('returns nulls rather than throwing when metadata is sparse', async () => {
    const { metadata } = await extractorFor(SPARSE_METADATA).resolve(CANONICAL);
    expect(metadata.awemeId).toBe(AWEME_ID);
    expect(metadata.authorHandle).toBeNull();
    expect(metadata.caption).toBeNull();
    expect(metadata.durationMs).toBeNull();
    expect(metadata.hashtags).toEqual([]);
    expect(metadata.stats.views).toBeNull();
  });
});

describe('YtDlpExtractor — failures', () => {
  it('rejects a photo slideshow with UNSUPPORTED_MEDIA instead of crashing', async () => {
    await expect(extractorFor(PHOTO_SLIDESHOW).resolve(CANONICAL)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA',
    });
  });

  it('does not mistake a short video for a slideshow', async () => {
    // A real video with a video format is never a photo post, whatever its duration.
    const shortVideo = { ...CLEAN_AND_WATERMARKED, duration: 0 };
    const resolved = await extractorFor(shortVideo).resolve(CANONICAL);
    expect(resolved.metadata.isPhotoPost).toBe(false);
  });

  it('reports an empty format list as an extractor problem', async () => {
    await expect(extractorFor(NO_FORMATS).resolve(CANONICAL)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
  });

  it('treats unparseable output as EXTRACTOR_FAILED, not a network error', async () => {
    const extractor = new YtDlpExtractor({
      binaryPath: '/fake/yt-dlp',
      runner: runner({ stdout: '<!DOCTYPE html><html>blocked</html>', exitCode: 0 }),
    });
    await expect(extractor.resolve(CANONICAL)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
  });

  it('maps a non-zero exit through the stderr classifier', async () => {
    const cases = [
      [STDERR_SAMPLES.privatePost, 'VIDEO_PRIVATE'],
      [STDERR_SAMPLES.deleted, 'VIDEO_DELETED'],
      [STDERR_SAMPLES.ipBlocked, 'REGION_BLOCKED'],
      [STDERR_SAMPLES.rateLimited, 'RATE_LIMITED'],
      [STDERR_SAMPLES.extractorBroken, 'EXTRACTOR_FAILED'],
    ] as const;

    for (const [stderr, code] of cases) {
      const extractor = new YtDlpExtractor({
        binaryPath: '/fake/yt-dlp',
        runner: runner({ stdout: '', stderr, exitCode: 1 }),
      });
      await expect(extractor.resolve(CANONICAL), stderr).rejects.toMatchObject({ code });
    }
  });

  it('reports a missing binary as EXTRACTOR_FAILED and is not available', async () => {
    const extractor = new YtDlpExtractor({ binaryPath: null, runner: runner({}) });
    expect(await extractor.isAvailable()).toBe(false);
    await expect(extractor.resolve(CANONICAL)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
  });
});

describe('YtDlpExtractor — invocation', () => {
  it('never writes a file while reading metadata', async () => {
    const run = vi.fn<ProcessRunner['run']>(async () => ({
      stdout: JSON.stringify(CLEAN_AND_WATERMARKED),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    await new YtDlpExtractor({ binaryPath: '/fake/yt-dlp', runner: { run } }).resolve(CANONICAL);

    const args = run.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--dump-single-json');
    expect(args).toContain('--skip-download');
    expect(args).toContain('--no-playlist');
    expect(args[args.length - 1]).toBe(CANONICAL);
  });

  it('passes the configured proxy through to the sidecar', async () => {
    const run = vi.fn<ProcessRunner['run']>(async () => ({
      stdout: JSON.stringify(CLEAN_AND_WATERMARKED),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    await new YtDlpExtractor({
      binaryPath: '/fake/yt-dlp',
      runner: { run },
      proxyUrl: 'socks5://127.0.0.1:9050',
    }).resolve(CANONICAL);

    const args = run.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--proxy');
    expect(args[args.indexOf('--proxy') + 1]).toBe('socks5://127.0.0.1:9050');
  });

  it('reports a killed process as a network error rather than a broken extractor', async () => {
    const extractor = new YtDlpExtractor({
      binaryPath: '/fake/yt-dlp',
      runner: runner({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
    });
    await expect(extractor.resolve(CANONICAL)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
