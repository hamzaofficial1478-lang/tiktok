import { AppError } from '@shared/errors';

/**
 * Follows a TikTok short link to its destination — section 6 step 4: HEAD
 * request, max 5 hops, 8s timeout, without downloading the body.
 *
 * An interface rather than a bare function so that phase 3 can wrap it in the
 * global token bucket (section 8: a minimum gap between outbound resolution
 * requests) without the normalizer knowing anything about rate limiting, and
 * so tests can drive redirect chains deterministically.
 */
export interface RedirectResolver {
  resolve(url: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export interface HttpRedirectResolverOptions {
  readonly maxHops?: number;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class HttpRedirectResolver implements RedirectResolver {
  private readonly maxHops: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: HttpRedirectResolverOptions = {}) {
    this.maxHops = options.maxHops ?? 5;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async resolve(url: string, options?: { signal?: AbortSignal }): Promise<string> {
    // One deadline for the whole chain, not per hop: five hops at 8s each would
    // stall a 300-item batch for 40 seconds on a single bad link.
    const deadline = Date.now() + this.timeoutMs;
    let current = url;

    for (let hop = 0; hop <= this.maxHops; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('NETWORK_ERROR', `timed out resolving short link after ${hop} hop(s)`);

      const response = await this.request(current, remaining, options?.signal);
      const location = response.headers.get('location');

      if (!isRedirect(response.status) || !location) {
        if (response.status >= 400) throw statusToError(response.status, current);
        // Not a redirect and not an error: this is the destination.
        return current;
      }

      if (hop === this.maxHops) {
        throw new AppError('RESOLVE_FAILED', `short link exceeded ${this.maxHops} redirects`);
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new AppError('RESOLVE_FAILED', `short link returned an unusable Location header: ${location}`);
      }

      // Refuse to leave HTTP(S); a Location of javascript:, data: or file: is
      // never legitimate here.
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new AppError('RESOLVE_FAILED', `short link redirected to an unsupported scheme: ${next.protocol}`);
      }

      current = next.toString();
    }

    throw new AppError('RESOLVE_FAILED', `short link exceeded ${this.maxHops} redirects`);
  }

  /**
   * HEAD first so no body is transferred. Some CDNs answer HEAD with 405/501,
   * in which case a GET is issued and cancelled the moment headers arrive —
   * still without reading the body.
   */
  private async request(url: string, remainingMs: number, external?: AbortSignal): Promise<Response> {
    const attempt = async (method: 'HEAD' | 'GET'): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      const onExternalAbort = (): void => controller.abort();
      external?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        return await this.fetchImpl(url, {
          method,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': this.userAgent,
            // TikTok's short-link host decides where to send you based on how
            // the request looks. Asked with HEAD and `Accept: */*`, it answers
            // with the homepage — a redirect that succeeds and points nowhere.
            // These are the headers a browser navigation carries.
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
        });
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onExternalAbort);
        if (method === 'GET') controller.abort();
      }
    };

    try {
      // GET first, not HEAD. `redirect: 'manual'` returns the moment the 3xx
      // arrives, so no body is transferred and the saving HEAD offered was
      // never real — while HEAD is exactly what TikTok answers wrongly.
      const response = await attempt('GET');
      if (response.status === 405 || response.status === 501) return await attempt('HEAD');
      return response;
    } catch (err) {
      if (external?.aborted) throw new AppError('CANCELLED', 'short link resolution cancelled');
      throw new AppError('NETWORK_ERROR', `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function statusToError(status: number, url: string): AppError {
  // A short code that 404s means the post is gone. Terminal on purpose:
  // section 8 forbids spending retries on a 404.
  if (status === 404 || status === 410) return new AppError('VIDEO_DELETED', `short link ${url} returned ${status}`);
  if (status === 403) return new AppError('REGION_BLOCKED', `short link ${url} returned 403`);
  if (status === 429) return new AppError('RATE_LIMITED', `short link ${url} returned 429`);
  if (status >= 500) return new AppError('NETWORK_ERROR', `short link ${url} returned ${status}`);
  return new AppError('RESOLVE_FAILED', `short link ${url} returned ${status}`);
}
