import { describe, expect, it } from 'vitest';
import { UrlNormalizer } from '@main/resolve/url-normalizer';
import { HttpRedirectResolver } from '@main/resolve/redirect-resolver';
import { ChildProcessRunner } from '@main/resolve/process-runner';
import { YtDlpExtractor } from '@main/resolve/yt-dlp-extractor';
import { ExtractorChain } from '@main/resolve/extractor-chain';
import { SidecarResolver } from '@main/media/sidecars';
import { resolve as resolvePath } from 'node:path';

/**
 * Live probe — skipped unless LIVE_PROBE=1.
 *
 * Run it with `npm run probe:live`. It is not part of `npm test` and never
 * runs in CI, because it needs real network access to TikTok and a real yt-dlp
 * binary. Everything else in the suite is deterministic and offline.
 *
 * What it is for: the offline suite proves the *logic* is right — that a
 * play_addr format is classified clean, that a 404 maps to VIDEO_DELETED. It
 * cannot prove the *premise*: that TikTok still serves a watermark-free
 * play_addr at all, or that the field names have not been renamed upstream.
 * Only a real request answers that, so this prints what actually came back and
 * asserts the few invariants the download pipeline will depend on.
 *
 *   LIVE_PROBE=1 npm run probe:live
 *   LIVE_PROBE=1 PROBE_URLS="https://vm.tiktok.com/XXXX/,https://…" npm run probe:live
 */

const enabled = process.env['LIVE_PROBE'] === '1';

const DEFAULT_URLS = [
  // Replace with links you own, or pass PROBE_URLS. Section 3 of the appendix:
  // positioning this for creators downloading their own content is the safer
  // footing, and probing your own posts matches that.
  'https://www.tiktok.com/@tiktok/video/7106594312292453675',
];

const urls = (process.env['PROBE_URLS'] ?? '').split(',').filter(Boolean);
const targets = urls.length > 0 ? urls : DEFAULT_URLS;

describe.skipIf(!enabled)('live probe', () => {
  const sidecars = new SidecarResolver({
    resourcesRoot: resolvePath(process.cwd(), 'resources'),
    allowPathFallback: true,
  });

  it('reports the yt-dlp binary in use', async () => {
    const status = await sidecars.status('yt-dlp');
    console.log(`\nyt-dlp: ${status.path ?? 'NOT FOUND'} (version ${status.version ?? 'unknown'})`);
    expect(status.present, 'yt-dlp must be installed to run the live probe').toBe(true);
  });

  it.each(targets)('resolves %s end to end', async (input) => {
    const normalizer = new UrlNormalizer({ redirectResolver: new HttpRedirectResolver() });
    const extractor = new ExtractorChain([
      new YtDlpExtractor({
        binaryPath: sidecars.resolve('yt-dlp').path,
        runner: new ChildProcessRunner(),
        timeoutMs: 90_000,
      }),
    ]);

    const normalized = await normalizer.normalize(input);
    console.log(`\n  input      ${input}`);
    console.log(`  aweme_id   ${normalized.awemeId}`);
    console.log(`  canonical  ${normalized.canonicalUrl}`);
    console.log(`  via short  ${normalized.viaShortLink}`);

    const { streams, metadata } = await extractor.resolve(normalized.canonicalUrl);

    console.log(`  author     @${metadata.authorHandle ?? '?'} (${metadata.authorName ?? '?'})`);
    console.log(`  duration   ${metadata.durationMs ?? '?'} ms`);
    console.log(`  formats:`);
    for (const stream of [...streams].sort((a, b) => b.preference - a.preference)) {
      console.log(
        `    ${stream.watermarked ? 'WATERMARKED' : 'clean      '} ` +
          `${stream.id.padEnd(22)} ${String(stream.width ?? '?')}x${String(stream.height ?? '?')} ` +
          `${stream.ext ?? '?'} ${stream.codec ?? '?'}`,
      );
    }

    const clean = streams.filter((s) => !s.watermarked && s.kind === 'video');
    console.log(`  => ${clean.length} clean video stream(s) available\n`);

    // The premise of section 9's primary strategy. If this ever fails on a
    // normal public video, the clean-source path is gone and watermark
    // filtering stops being a fallback and becomes the main path.
    expect(clean.length, 'no watermark-free stream was offered').toBeGreaterThan(0);
    expect(metadata.awemeId).toBe(normalized.awemeId);
  }, 120_000);
});
