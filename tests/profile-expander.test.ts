import { describe, expect, it } from 'vitest';
import { parseProfile } from '@shared/url-parse';
import { ProfileExpander, collectVideoUrls } from '@main/resolve/profile-expander';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';

/**
 * Queueing a whole account from one paste.
 *
 * The two things that have to hold: a profile link is never confused with a
 * video link in either direction, and the listing does not pin a device ID —
 * yt-dlp's feed pagination can only recover from a stuck one while nobody has.
 */

describe('recognising a profile link', () => {
  it('accepts the forms an account is actually written in', () => {
    for (const input of [
      'https://www.tiktok.com/@blackcloudmc',
      'https://tiktok.com/@blackcloudmc/',
      'https://www.tiktok.com/@BlackCloudMC?lang=en',
      'tiktok.com/@blackcloudmc',
      '@blackcloudmc',
      '  https://www.tiktok.com/@blackcloudmc  ',
    ]) {
      expect(parseProfile(input)?.handle, input).toBe('blackcloudmc');
    }
  });

  it('never reads a video link as a request to queue the whole account', () => {
    // The expensive mistake: one video asked for, two hundred downloaded.
    for (const input of [
      'https://www.tiktok.com/@blackcloudmc/video/7671366241122012447',
      'https://www.tiktok.com/@blackcloudmc/photo/7671366241122012447',
      'https://vm.tiktok.com/ZMabcdef/',
      'https://www.tiktok.com/t/ZTabc123/',
    ]) {
      expect(parseProfile(input), input).toBeNull();
    }
  });

  it('rejects everything that is not a TikTok account', () => {
    for (const input of ['', 'blackcloudmc', 'https://youtube.com/@blackcloudmc', 'https://www.tiktok.com/tag/cats']) {
      expect(parseProfile(input), input).toBeNull();
    }
  });

  it('normalises the handle so two spellings queue one account', () => {
    expect(parseProfile('@BlackCloudMC')?.profileUrl).toBe('https://www.tiktok.com/@blackcloudmc');
  });
});

describe('reading the listing back', () => {
  it('canonicalises entries and drops duplicates, keeping TikTok\'s order', () => {
    const urls = collectVideoUrls({
      entries: [
        { webpage_url: 'https://www.tiktok.com/@creator/video/7111111111111111111' },
        { url: 'https://tiktok.com/@_/video/7222222222222222222' },
        // The same video again, in a different spelling.
        { webpage_url: 'https://www.tiktok.com/@CREATOR/video/7111111111111111111' },
        { id: '7333333333333333333' },
        // Not a video: a listing artefact that would fail later if queued.
        { url: 'https://www.tiktok.com/@creator' },
      ],
    });

    expect(urls).toEqual([
      'https://www.tiktok.com/@creator/video/7111111111111111111',
      'https://www.tiktok.com/@/video/7222222222222222222',
      'https://www.tiktok.com/@/video/7333333333333333333',
    ]);
  });
});

function runnerReturning(results: Partial<ProcessResult>[]): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    runner: {
      run: async (_cmd, args) => {
        calls.push([...args]);
        const result = results[Math.min(index++, results.length - 1)] ?? {};
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
      },
    },
  };
}

const listing = JSON.stringify({
  title: 'creator',
  entries: Array.from({ length: 3 }, (_, i) => ({
    webpage_url: `https://www.tiktok.com/@creator/video/711111111111111111${i}`,
  })),
});

describe('listing an account', () => {
  it('asks for a flat listing and does not pin a device ID', async () => {
    const { runner, calls } = runnerReturning([{ stdout: listing }]);
    const expander = new ProfileExpander({ binaryPath: '/fake/yt-dlp', runner });

    const result = await expander.expand('@creator');

    const args = calls[0] ?? [];
    expect(args).toContain('--flat-playlist');
    /**
     * yt-dlp resets its own device ID when TikTok's feed endpoint gets stuck
     * on a page, but only while none was supplied — "if self._KNOWN_DEVICE_ID:
     * raise ... Try again with a different device_id". Pinning ours would swap
     * a recoverable hiccup for a dead end.
     */
    expect(args.join(' ')).not.toContain('device_id');
    expect(args[args.length - 1]).toBe('https://www.tiktok.com/@creator');
    expect(result.urls).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it('asks for one more than the limit so "there are more" is observed', async () => {
    const many = JSON.stringify({
      entries: Array.from({ length: 4 }, (_, i) => ({
        webpage_url: `https://www.tiktok.com/@creator/video/71111111111111111${String(i).padStart(2, '0')}`,
      })),
    });
    const { runner, calls } = runnerReturning([{ stdout: many }]);
    const expander = new ProfileExpander({ binaryPath: '/fake/yt-dlp', runner });

    const result = await expander.expand('@creator', { limit: 3 });

    expect(calls[0]?.[(calls[0]?.indexOf('--playlist-items') ?? 0) + 1]).toBe('1:4');
    expect(result.urls).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('tries a fallback route when the default one cannot list', async () => {
    const { runner, calls } = runnerReturning([
      { exitCode: 1, stderr: 'ERROR: [TikTok] creator: Unable to extract sec_uid' },
      { stdout: listing },
    ]);
    const expander = new ProfileExpander({
      binaryPath: '/fake/yt-dlp',
      runner,
      fallbackArgs: () => [['--extractor-args', 'tiktok:device_id=7300000000000000000']],
    });

    const result = await expander.expand('@creator');

    expect(result.urls).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.join(' ')).toContain('device_id');
  });

  it('says plainly when an account has nothing public', async () => {
    const { runner } = runnerReturning([{ stdout: JSON.stringify({ entries: [] }) }]);
    const expander = new ProfileExpander({ binaryPath: '/fake/yt-dlp', runner });

    await expect(expander.expand('@creator')).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
  });

  it('refuses a video link rather than listing its author', async () => {
    const { runner, calls } = runnerReturning([{ stdout: listing }]);
    const expander = new ProfileExpander({ binaryPath: '/fake/yt-dlp', runner });

    await expect(
      expander.expand('https://www.tiktok.com/@creator/video/7111111111111111111'),
    ).rejects.toMatchObject({ code: 'NOT_A_TIKTOK_URL' });
    expect(calls).toHaveLength(0);
  });
});
