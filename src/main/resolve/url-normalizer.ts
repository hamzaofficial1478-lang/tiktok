import { AppError } from '@shared/errors';
import { parse, type ParseResult } from '@shared/url-parse';
import type { NormalizedUrl } from './types';
import type { RedirectResolver } from './redirect-resolver';

export { parse, buildCanonicalUrl } from '@shared/url-parse';
export type { ParseResult } from '@shared/url-parse';

/**
 * The network-bound half of section 6: short-link redirect resolution and
 * the session cache in front of it. The pure parsing lives in
 * shared/url-parse so the renderer can validate a paste without IPC.
 */
export interface UrlNormalizerOptions {
  readonly redirectResolver: RedirectResolver;
}

export class UrlNormalizer {
  /**
   * Session-scoped short-link cache (section 6 step 4), so re-pasting the same
   * batch does not re-hit the network. Keyed by the short URL; deliberately not
   * persisted, since TikTok can retarget a short code.
   */
  private readonly shortLinkCache = new Map<string, NormalizedUrl>();

  constructor(private readonly options: UrlNormalizerOptions) {}

  /** Pure, synchronous validation for live paste feedback. */
  parse(input: string): ParseResult {
    return parse(input);
  }

  /**
   * The full procedure. Throws AppError with the taxonomy code the queue row
   * should display.
   */
  async normalize(input: string, options?: { signal?: AbortSignal }): Promise<NormalizedUrl> {
    const parsed = parse(input);

    if (parsed.status === 'invalid') throw new AppError(parsed.code, `input: ${truncate(input)}`);

    if (parsed.status === 'resolved') {
      return {
        awemeId: parsed.awemeId,
        canonicalUrl: parsed.canonicalUrl,
        authorHandle: parsed.authorHandle,
        kind: parsed.kind,
        viaShortLink: false,
        rawUrl: input.trim(),
      };
    }

    const cached = this.shortLinkCache.get(parsed.shortUrl);
    if (cached) return { ...cached, rawUrl: input.trim() };

    const finalUrl = await this.options.redirectResolver.resolve(parsed.shortUrl, options);

    const afterRedirect = parse(finalUrl);
    if (afterRedirect.status === 'invalid') {
      throw new AppError(afterRedirect.code, `short link ${parsed.shortUrl} resolved to ${truncate(finalUrl)}`);
    }
    if (afterRedirect.status === 'needs-redirect') {
      // A short link that only redirects to another short link is a loop we
      // will not chase further.
      throw new AppError('RESOLVE_FAILED', `short link ${parsed.shortUrl} redirected to another short link`);
    }

    const normalized: NormalizedUrl = {
      awemeId: afterRedirect.awemeId,
      canonicalUrl: afterRedirect.canonicalUrl,
      authorHandle: afterRedirect.authorHandle,
      kind: afterRedirect.kind,
      viaShortLink: true,
      rawUrl: input.trim(),
    };

    this.shortLinkCache.set(parsed.shortUrl, normalized);
    return normalized;
  }

  /** Test/diagnostic hook; the cache is otherwise invisible. */
  get cacheSize(): number {
    return this.shortLinkCache.size;
  }

  clearCache(): void {
    this.shortLinkCache.clear();
  }
}

function truncate(value: string, max = 200): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
