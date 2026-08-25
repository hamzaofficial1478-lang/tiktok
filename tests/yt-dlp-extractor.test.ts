import { describe, expect, it, vi } from 'vitest';
import { isTerminalForChain } from '@main/resolve/yt-dlp-errors';
import {
  YtDlpExtractor,
  ytDlpStrategies,
  sessionArgs,
  type YtDlpStrategy,
} from '@main/resolve/yt-dlp-extractor';
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

  /**
   * These used to be hard-coded empty, with the note "nothing consumes them".
   * That stopped being true when titles and descriptions started being written
   * from a video's own words: for a silent video with a short caption the tags
   * are often the only thing telling one post from the next, and their absence
   * is why a whole account came out with identical titles.
   */
  it('extracts the hashtags a creator wrote into the caption', async () => {
    const { metadata } = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);
    expect(metadata.hashtags).toEqual(['tags', 'more']);
  });

  it('reads them out of the full description, not the shortened title', async () => {
    // yt-dlp truncates `title` for display, which cut the tags off the end of
    // every caption — they usually sit there.
    const payload = {
      ...CLEAN_AND_WATERMARKED,
      title: 'a caption with #tags and…',
      description: 'a caption with #tags and #more #SourDough_2 at the end',
    };
    const { metadata } = await extractorFor(payload).resolve(CANONICAL);
    expect(metadata.hashtags).toEqual(['tags', 'more', 'sourdough_2']);
    expect(metadata.caption).toContain('at the end');
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

  /**
   * The commonest failure this app sees, and the cheapest place to survive it:
   *
   *   ERROR: [TikTok] …: Unable to download webpage: Failed to perform,
   *   curl: (56) Connection closed abruptly.
   *
   * Not a refusal and not a timeout — the other end hung up part-way through,
   * which a second attempt a moment later usually gets past. Without a retry
   * inside the route, one dropped connection abandoned that route instantly,
   * all three fell over the same way within seconds, and a hiccup cost the
   * video one of its four queue attempts and a trip to the back of the queue.
   */
  it('rides out a dropped connection inside the route rather than failing the item', async () => {
    const run = vi.fn<ProcessRunner['run']>(async () => ({
      stdout: JSON.stringify(CLEAN_AND_WATERMARKED),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    await new YtDlpExtractor({ binaryPath: '/fake/yt-dlp', runner: { run } }).resolve(CANONICAL);

    const args = run.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf('--extractor-retries') + 1]).toBe('3');
    expect(args[args.indexOf('--retries') + 1]).toBe('3');
  });

  it('caps the wait between those retries, so three cannot become a minute of silence', async () => {
    const run = vi.fn<ProcessRunner['run']>(async () => ({
      stdout: JSON.stringify(CLEAN_AND_WATERMARKED),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    await new YtDlpExtractor({ binaryPath: '/fake/yt-dlp', runner: { run } }).resolve(CANONICAL);

    const args = run.mock.calls[0]?.[1] as string[];
    const sleeps = args.filter((_arg, i) => args[i - 1] === '--retry-sleep');
    expect(sleeps).toContain('extractor:exp=1:8');
    expect(sleeps).toContain('http:exp=1:8');
  });
});

describe('failure diagnostics', () => {
  it('puts yt-dlp\'s own words in the log message, not just our guess at a code', async () => {
    const entries: { msg: string; data: Record<string, unknown> }[] = [];
    const log = {
      warn: (data: Record<string, unknown>, msg: string) => entries.push({ msg, data }),
      info: () => {},
      error: () => {},
      debug: () => {},
    };

    const extractor = new YtDlpExtractor({
      binaryPath: '/fake/yt-dlp',
      runner: {
        run: async () => ({
          stdout: '',
          stderr:
            'WARNING: [tiktok] Falling back to feed API\n' +
            'ERROR: [TikTok] 7123456789012345678: Unable to extract webpage video data\n',
          exitCode: 1,
          timedOut: false,
        }),
      },
      log: log as never,
    });

    await expect(
      extractor.resolve('https://www.tiktok.com/@a/video/7123456789012345678'),
      // A page served without its video data is TikTok refusing the request,
      // not a stale extractor — so it is retryable rather than terminal.
    ).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });

    const entry = entries[0];
    // The ERROR line wins over the WARNING noise above it.
    expect(entry?.msg).toContain('Unable to extract webpage video data');
    expect(entry?.msg).not.toContain('Falling back to feed API');
    // And the full text is retained for anyone reading the structured log.
    expect(String(entry?.data.stderr)).toContain('Unable to extract');
  });

  it('says so plainly when the process produced nothing at all', async () => {
    const entries: string[] = [];
    const extractor = new YtDlpExtractor({
      binaryPath: '/fake/yt-dlp',
      runner: {
        run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
      },
      log: {
        warn: (_data: unknown, msg: string) => entries.push(msg),
        info: () => {},
        error: () => {},
        debug: () => {},
      } as never,
    });

    await expect(
      extractor.resolve('https://www.tiktok.com/@a/video/7123456789012345678'),
    ).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });

    // An empty stderr must not produce a log line that says nothing.
    expect(entries[0]).toContain('no output');
  });
});

describe('multiple routes to TikTok', () => {
  const url = 'https://www.tiktok.com/@a/video/7123456789012345678';

  function capturing(results: Partial<ProcessResult>[]): { runner: ProcessRunner; calls: string[][] } {
    const calls: string[][] = [];
    let index = 0;
    return {
      calls,
      runner: {
        run: async (_cmd, args) => {
          calls.push([...args]);
          const result = results[Math.min(index++, results.length - 1)] ?? {};
          return { stdout: '', stderr: '', exitCode: 1, timedOut: false, ...result };
        },
      },
    };
  }

  const DEVICE_ID = '7300000000000000000';

  it('names each route so the log says which one was used', () => {
    const names = ytDlpStrategies(DEVICE_ID).map(
      (strategy) => new YtDlpExtractor({ binaryPath: '/fake', runner: capturing([]).runner, strategy }).name,
    );

    // App API first, web last: the web page is the route TikTok gates with
    // bot detection, and leading with it made every video pay that lottery
    // before anything else was tried.
    expect(names).toEqual([
      'yt-dlp (mobile app api)',
      'yt-dlp (mobile app api (alt region))',
      'yt-dlp (web)',
    ]);
    // Distinct names matter: the chain logs which extractor failed, and three
    // identically named ones would make that log useless.
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The bug this pins: `api_hostname` alone does not select the mobile API.
   * yt-dlp only takes its app path when it has a device identity
   * (`_KNOWN_APP_INFO` is empty without `device_id` or `app_info`), so a route
   * carrying only a hostname renames an endpoint that is never contacted — and
   * all three routes scraped the same web page as each other.
   */
  it('gives the app routes a device identity, not just a hostname', async () => {
    for (const strategy of ytDlpStrategies(DEVICE_ID)) {
      const { runner, calls } = capturing([{ exitCode: 1, stderr: 'ERROR: nope' }]);
      const extractor = new YtDlpExtractor({ binaryPath: '/fake', runner, strategy });

      await extractor.resolve(url).catch(() => undefined);

      const args = calls[0] ?? [];
      if (strategy.label === 'web') {
        expect(args).not.toContain('--extractor-args');
      } else {
        expect(args).toContain('--extractor-args');
        const value = args[args.indexOf('--extractor-args') + 1] ?? '';
        expect(value).toContain(`device_id=${DEVICE_ID}`);
        expect(value).toContain('api_hostname=');
        // One `tiktok:` group, keys separated by `;` — the syntax yt-dlp parses.
        expect(value).toMatch(/^tiktok:[^:]+$/);
      }
      // Every route presents as a browser; a default agent is among the first
      // things a site filters on.
      expect(args).toContain('--user-agent');
      // The URL is always last, after every flag.
      expect(args[args.length - 1]).toBe(url);
    }
  });

  it('is exactly the failure the web route hit that the others exist for', async () => {
    // The real stderr from the user's machine, verbatim.
    const webFailure = {
      exitCode: 1,
      stderr:
        'ERROR: [TikTok] 7123456789012345678: Unexpected response from webpage request; please report this issue on https://github.com/yt-dlp/yt-dlp/issues',
    };

    const { runner } = capturing([webFailure]);
    const extractor = new YtDlpExtractor({
      binaryPath: '/fake',
      runner,
      strategy: ytDlpStrategies('7300000000000000000')[0] as YtDlpStrategy,
    });

    // EXTRACTOR_FAILED is deliberately not terminal for the chain, so the
    // mobile routes get their turn rather than the item failing outright.
    await expect(extractor.resolve(url)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
    expect(isTerminalForChain('EXTRACTOR_FAILED')).toBe(false);
  });
});

describe('CDN headers', () => {
  it('captures the headers TikTok requires on the stream URL', async () => {
    // Without these the CDN answers 403 even though extraction just succeeded
    // and the video is public — the failure that looked like a geo-block.
    const payload = {
      ...CLEAN_AND_WATERMARKED,
      formats: [
        {
          format_id: 'play_addr',
          url: 'https://v16.tiktokcdn.com/clean.mp4',
          ext: 'mp4',
          height: 1920,
          vcodec: 'h264',
          http_headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            Referer: 'https://www.tiktok.com/',
            Cookie: 'ttwid=1%7Cabcdef',
          },
        },
      ],
    };

    const resolved = await extractorFor(payload).resolve(CANONICAL);
    const headers = resolved.streams[0]?.headers ?? {};

    expect(headers['referer']).toBe('https://www.tiktok.com/');
    expect(headers['cookie']).toBe('ttwid=1%7Cabcdef');
    // Lowercased so the downloader's own defaults are overridden, not doubled.
    expect(headers['user-agent']).toContain('Mozilla/5.0');
  });

  it('drops headers that must not be replayed by a different HTTP client', async () => {
    const payload = {
      ...CLEAN_AND_WATERMARKED,
      formats: [
        {
          format_id: 'play_addr',
          url: 'https://v16.tiktokcdn.com/clean.mp4',
          vcodec: 'h264',
          http_headers: {
            Referer: 'https://www.tiktok.com/',
            // Our fetch negotiates its own encoding and sets its own Range when
            // resuming; replaying these corrupts the transfer.
            'Accept-Encoding': 'gzip, deflate',
            Range: 'bytes=0-100',
            Connection: 'keep-alive',
          },
        },
      ],
    };

    const headers = (await extractorFor(payload).resolve(CANONICAL)).streams[0]?.headers ?? {};

    expect(headers['referer']).toBe('https://www.tiktok.com/');
    expect(headers['accept-encoding']).toBeUndefined();
    expect(headers['range']).toBeUndefined();
    expect(headers['connection']).toBeUndefined();
  });

  it('yields an empty set rather than undefined when a format reports none', async () => {
    const resolved = await extractorFor(CLEAN_AND_WATERMARKED).resolve(CANONICAL);
    expect(resolved.streams[0]?.headers).toEqual({});
  });
});

describe('session arguments', () => {
  it('borrows browser cookies only when a browser is chosen', () => {
    expect(sessionArgs({ browserCookies: 'chrome' })).toEqual(['--cookies-from-browser', 'chrome']);
    // 'none' is the config's way of saying "do not touch a browser profile",
    // and must not become a literal browser name on the command line.
    expect(sessionArgs({ browserCookies: 'none' })).toEqual([]);
    expect(sessionArgs({})).toEqual([]);
  });

  it('forces IPv4 when asked', () => {
    expect(sessionArgs({ forceIpv4: true })).toEqual(['--force-ipv4']);
    expect(sessionArgs({ forceIpv4: false })).toEqual([]);
  });

  it('combines every session flag in a stable order', () => {
    expect(sessionArgs({ browserCookies: 'edge', forceIpv4: true, proxyUrl: 'socks5://127.0.0.1:9050' })).toEqual([
      '--cookies-from-browser',
      'edge',
      '--force-ipv4',
      '--proxy',
      'socks5://127.0.0.1:9050',
    ]);
  });

  it('passes the session to yt-dlp on the extraction call', async () => {
    const calls: string[][] = [];
    const extractor = new YtDlpExtractor({
      binaryPath: '/fake/yt-dlp',
      runner: {
        run: async (_cmd, args) => {
          calls.push([...args]);
          return { stdout: JSON.stringify(CLEAN_AND_WATERMARKED), stderr: '', exitCode: 0, timedOut: false };
        },
      },
      session: () => ({ browserCookies: 'chrome', forceIpv4: true }),
    });

    await extractor.resolve(CANONICAL);

    expect(calls[0]).toContain('--cookies-from-browser');
    expect(calls[0]).toContain('--force-ipv4');
  });

  it('carries the session into the download, not just the extraction', async () => {
    // Extracting with a browser session and downloading without it reproduces
    // the exact failure this was added to fix: a clean resolve, then a 403.
    const extractor = new YtDlpExtractor({
      binaryPath: '/fake/yt-dlp',
      runner: runner({ stdout: JSON.stringify(CLEAN_AND_WATERMARKED) }),
      strategy: ytDlpStrategies('7300000000000000000')[1] as YtDlpStrategy,
      session: () => ({ browserCookies: 'firefox', forceIpv4: true }),
    });

    const resolved = await extractor.resolve(CANONICAL);

    expect(resolved.extractorArgs).toContain('--cookies-from-browser');
    expect(resolved.extractorArgs).toContain('firefox');
    expect(resolved.extractorArgs).toContain('--force-ipv4');
    // The winning route is still carried alongside the session.
    expect(resolved.extractorArgs).toContain('--extractor-args');
  });
});
