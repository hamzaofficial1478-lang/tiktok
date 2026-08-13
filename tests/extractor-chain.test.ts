import { describe, expect, it, vi } from 'vitest';
import { ExtractorChain } from '@main/resolve/extractor-chain';
import { classifyYtDlpFailure, isTerminalForChain } from '@main/resolve/yt-dlp-errors';
import { AppError, ERROR_CODES, type ErrorCode } from '@shared/errors';
import type { Extractor, ResolvedVideo } from '@main/resolve/types';
import { STDERR_SAMPLES } from './fixtures/yt-dlp-payloads';

const CANONICAL = 'https://www.tiktok.com/@charlie/video/7123456789012345678';

function resolved(name: string): ResolvedVideo {
  return {
    extractor: name,
    streams: [
      {
        id: 'play_addr',
        url: 'https://cdn/clean.mp4',
        watermarked: false,
        kind: 'video',
        width: 1080,
        height: 1920,
        fps: 30,
        bitrate: 2400,
        filesize: 1000,
        ext: 'mp4',
        codec: 'h264',
        headers: {},
        hasAudio: true,
        preference: 1_000_000,
      },
    ],
    metadata: {
      awemeId: '7123456789012345678',
      authorHandle: 'charlie',
      authorName: null,
      caption: null,
      durationMs: 1000,
      coverUrl: null,
      musicTitle: null,
      uploadedAt: null,
      hashtags: [],
      isPhotoPost: false,
      stats: { views: null, likes: null, comments: null, shares: null },
    },
  };
}

function working(name: string): Extractor {
  return { name, isAvailable: async () => true, resolve: vi.fn(async () => resolved(name)) };
}

function failing(name: string, code: ErrorCode): Extractor {
  return {
    name,
    isAvailable: async () => true,
    resolve: vi.fn(async () => {
      throw new AppError(code, `${name} failed`);
    }),
  };
}

function unavailable(name: string): Extractor {
  return { name, isAvailable: async () => false, resolve: vi.fn(async () => resolved(name)) };
}

describe('ExtractorChain', () => {
  it('uses the first available extractor and does not call the rest', async () => {
    const first = working('first');
    const second = working('second');

    const result = await new ExtractorChain([first, second]).resolve(CANONICAL);

    expect(result.extractor).toBe('first');
    expect(second.resolve).not.toHaveBeenCalled();
  });

  it('falls through to the next when one fails recoverably', async () => {
    const broken = failing('broken', 'EXTRACTOR_FAILED');
    const backup = working('backup');

    const result = await new ExtractorChain([broken, backup]).resolve(CANONICAL);

    expect(broken.resolve).toHaveBeenCalledOnce();
    expect(result.extractor).toBe('backup');
  });

  it('skips an uninstalled extractor without counting it as a failure', async () => {
    const missing = unavailable('missing');
    const backup = working('backup');

    const result = await new ExtractorChain([missing, backup]).resolve(CANONICAL);

    expect(missing.resolve).not.toHaveBeenCalled();
    expect(result.extractor).toBe('backup');
  });

  /**
   * The refinement that matters for the rate budget: a video that is deleted,
   * private, blocked or age-gated fails identically everywhere, so the chain
   * must not spend another outbound request confirming it.
   */
  it.each(['VIDEO_DELETED', 'VIDEO_PRIVATE', 'REGION_BLOCKED', 'AGE_RESTRICTED', 'UNSUPPORTED_MEDIA'] as const)(
    'stops immediately on %s instead of retrying other extractors',
    async (code) => {
      const first = failing('first', code);
      const second = working('second');

      await expect(new ExtractorChain([first, second]).resolve(CANONICAL)).rejects.toMatchObject({ code });
      expect(second.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(['EXTRACTOR_FAILED', 'NETWORK_ERROR', 'RATE_LIMITED', 'RESOLVE_FAILED'] as const)(
    'does try the next extractor after %s',
    async (code) => {
      const first = failing('first', code);
      const second = working('second');

      const result = await new ExtractorChain([first, second]).resolve(CANONICAL);
      expect(result.extractor).toBe('second');
    },
  );

  it('stops on cancellation rather than restarting work on the next extractor', async () => {
    const first = failing('first', 'CANCELLED');
    const second = working('second');

    await expect(new ExtractorChain([first, second]).resolve(CANONICAL)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(second.resolve).not.toHaveBeenCalled();
  });

  it('surfaces the last failure when every extractor fails', async () => {
    const chain = new ExtractorChain([failing('a', 'EXTRACTOR_FAILED'), failing('b', 'NETWORK_ERROR')]);
    await expect(chain.resolve(CANONICAL)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('says the extractor needs installing when none is available', async () => {
    const chain = new ExtractorChain([unavailable('a'), unavailable('b')]);
    await expect(chain.resolve(CANONICAL)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
    expect(await chain.isAvailable()).toBe(false);
  });

  it('fails cleanly when nothing is registered', async () => {
    await expect(new ExtractorChain([]).resolve(CANONICAL)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
  });

  it('survives an extractor whose isAvailable throws', async () => {
    const hostile: Extractor = {
      name: 'hostile',
      isAvailable: async () => {
        throw new Error('boom');
      },
      resolve: vi.fn(async () => resolved('hostile')),
    };
    const result = await new ExtractorChain([hostile, working('backup')]).resolve(CANONICAL);
    expect(result.extractor).toBe('backup');
  });

  it('converts a non-AppError throw into a typed failure', async () => {
    const sloppy: Extractor = {
      name: 'sloppy',
      isAvailable: async () => true,
      resolve: async () => {
        throw new TypeError('undefined is not a function');
      },
    };
    await expect(new ExtractorChain([sloppy]).resolve(CANONICAL)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
  });
});

describe('yt-dlp error classification', () => {
  it.each([
    ['privatePost', 'VIDEO_PRIVATE'],
    ['privateAccount', 'VIDEO_PRIVATE'],
    ['ipBlocked', 'REGION_BLOCKED'],
    ['deleted', 'VIDEO_DELETED'],
    ['removed', 'VIDEO_DELETED'],
    ['geoBlocked', 'REGION_BLOCKED'],
    ['ageGated', 'AGE_RESTRICTED'],
    ['rateLimited', 'RATE_LIMITED'],
    ['extractorBroken', 'EXTRACTOR_FAILED'],
    ['jsChallenge', 'EXTRACTOR_FAILED'],
    ['serverError', 'NETWORK_ERROR'],
    ['timeout', 'NETWORK_ERROR'],
    ['dnsFailure', 'NETWORK_ERROR'],
    ['connectionReset', 'NETWORK_ERROR'],
  ] as const)('classifies %s as %s', (sample, code) => {
    expect(classifyYtDlpFailure({ stderr: STDERR_SAMPLES[sample], exitCode: 1 }).code).toBe(code);
  });

  /**
   * "Unable to download webpage: HTTP Error 404" contains both a network
   * phrase and a 404. Getting the order wrong would spend three retries and
   * rate budget on a video that no longer exists.
   */
  it('prefers the specific status over the generic transport wording', () => {
    expect(classifyYtDlpFailure({ stderr: STDERR_SAMPLES.deleted }).code).toBe('VIDEO_DELETED');
    expect(classifyYtDlpFailure({ stderr: STDERR_SAMPLES.rateLimited }).code).toBe('RATE_LIMITED');
    expect(classifyYtDlpFailure({ stderr: STDERR_SAMPLES.serverError }).code).toBe('NETWORK_ERROR');
  });

  it('defaults an unrecognised failure to EXTRACTOR_FAILED, not a network error', () => {
    // Section 2: a stale extractor is the likeliest cause and must offer the
    // update action rather than a misleading "check your connection".
    const classified = classifyYtDlpFailure({ stderr: STDERR_SAMPLES.unknown, exitCode: 1 });
    expect(classified.code).toBe('EXTRACTOR_FAILED');
  });

  it('treats a timeout as a network error even with empty stderr', () => {
    expect(classifyYtDlpFailure({ stderr: '', timedOut: true }).code).toBe('NETWORK_ERROR');
  });

  it('only marks codes terminal when no other extractor could do better', () => {
    for (const code of ERROR_CODES) {
      if (['NETWORK_ERROR', 'RATE_LIMITED', 'EXTRACTOR_FAILED', 'RESOLVE_FAILED'].includes(code)) {
        expect(isTerminalForChain(code), code).toBe(false);
      }
    }
    expect(isTerminalForChain('VIDEO_DELETED')).toBe(true);
  });
});
