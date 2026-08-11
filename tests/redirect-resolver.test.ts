import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpRedirectResolver } from '@main/resolve/redirect-resolver';

/**
 * Driven against a real HTTP server rather than a stubbed fetch.
 *
 * The behaviours that matter here — hop counting, a whole-chain deadline, HEAD
 * not transferring a body, the GET fallback when a CDN rejects HEAD — are
 * properties of the HTTP exchange itself. A stubbed fetch would assert that the
 * mock does what the mock was written to do.
 */
let server: Server;
let base: string;
/** Records method + path for every request the resolver actually made. */
let requests: { method: string; url: string }[] = [];
let bodyBytesSent = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? '?', url: req.url ?? '' });
    const path = req.url ?? '/';

    const redirect = (to: string, status = 302): void => {
      res.writeHead(status, { location: to });
      res.end();
    };

    if (path.startsWith('/hop/')) {
      const n = Number(path.slice('/hop/'.length));
      if (n > 0) return redirect(`/hop/${n - 1}`);
      return redirect('/final');
    }

    if (path === '/final') {
      const body = 'x'.repeat(4_096);
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) });
      // HEAD must not transfer this; the counter proves it.
      if (req.method === 'HEAD') return res.end();
      bodyBytesSent += body.length;
      return res.end(body);
    }

    if (path === '/head-not-allowed') {
      if (req.method === 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      return redirect('/final');
    }

    if (path === '/relative') return redirect('deeper/final');
    if (path === '/deeper/final') return redirect('/final');
    if (path === '/permanent') return redirect('/final', 301);
    if (path === '/see-other') return redirect('/final', 303);
    if (path === '/keep-method') return redirect('/final', 308);
    if (path === '/loop') return redirect('/loop');
    if (path === '/bad-scheme') return redirect('javascript:alert(1)');
    if (path === '/no-location') {
      res.writeHead(302);
      return res.end();
    }
    if (path === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end();
      }, 2_000);
      return;
    }
    if (path.startsWith('/status/')) {
      res.writeHead(Number(path.slice('/status/'.length)));
      return res.end();
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function resolver(overrides: { maxHops?: number; timeoutMs?: number } = {}): HttpRedirectResolver {
  requests = [];
  bodyBytesSent = 0;
  return new HttpRedirectResolver({ maxHops: 5, timeoutMs: 8_000, ...overrides });
}

describe('HttpRedirectResolver', () => {
  it('follows a chain to its destination', async () => {
    const final = await resolver().resolve(`${base}/hop/2`);
    expect(final).toBe(`${base}/final`);
  });

  it('uses HEAD and never downloads a body', async () => {
    const r = resolver();
    await r.resolve(`${base}/hop/1`);
    expect(requests.every((req) => req.method === 'HEAD')).toBe(true);
    expect(bodyBytesSent).toBe(0);
  });

  it('falls back to GET when the server rejects HEAD, still without reading the body', async () => {
    const r = resolver();
    const final = await r.resolve(`${base}/head-not-allowed`);
    expect(final).toBe(`${base}/final`);
    expect(requests.map((req) => req.method)).toContain('GET');
    expect(bodyBytesSent).toBe(0);
  });

  it('handles every redirect status TikTok might use', async () => {
    for (const path of ['/permanent', '/see-other', '/keep-method']) {
      expect(await resolver().resolve(`${base}${path}`), path).toBe(`${base}/final`);
    }
  });

  it('resolves a relative Location against the current URL', async () => {
    expect(await resolver().resolve(`${base}/relative`)).toBe(`${base}/final`);
  });

  it('stops after the hop limit instead of following forever', async () => {
    await expect(resolver({ maxHops: 3 }).resolve(`${base}/loop`)).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    // 3 hops allowed = 4 requests before giving up; never unbounded.
    expect(requests.length).toBeLessThanOrEqual(4);
  });

  it('enforces the hop limit exactly at the boundary', async () => {
    // 5 redirects then the destination: within a 5-hop budget.
    expect(await resolver({ maxHops: 5 }).resolve(`${base}/hop/4`)).toBe(`${base}/final`);
    await expect(resolver({ maxHops: 4 }).resolve(`${base}/hop/4`)).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
  });

  it('applies one deadline across the whole chain, not per hop', async () => {
    const started = Date.now();
    await expect(resolver({ timeoutMs: 400 }).resolve(`${base}/slow`)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    // A 5-hop chain at 8s each would stall a batch for 40s; this must not.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses a redirect to a non-HTTP scheme', async () => {
    await expect(resolver().resolve(`${base}/bad-scheme`)).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
  });

  it('treats a redirect status with no Location as the destination', async () => {
    expect(await resolver().resolve(`${base}/no-location`)).toBe(`${base}/no-location`);
  });

  it('maps HTTP statuses to the right taxonomy codes', async () => {
    const cases = [
      ['404', 'VIDEO_DELETED'],
      ['410', 'VIDEO_DELETED'],
      ['403', 'REGION_BLOCKED'],
      ['429', 'RATE_LIMITED'],
      ['500', 'NETWORK_ERROR'],
      ['503', 'NETWORK_ERROR'],
      ['418', 'RESOLVE_FAILED'],
    ] as const;

    for (const [status, code] of cases) {
      await expect(resolver().resolve(`${base}/status/${status}`), status).rejects.toMatchObject({ code });
    }
  });

  it('never auto-retries a dead short link', async () => {
    // 404 -> VIDEO_DELETED, which section 8 marks terminal so retries are not
    // spent on it.
    const { isAutoRetryable } = await import('@shared/errors');
    expect(isAutoRetryable('VIDEO_DELETED')).toBe(false);
    expect(isAutoRetryable('NETWORK_ERROR')).toBe(true);
  });

  it('reports an unreachable host as a network error, not a crash', async () => {
    // Port 1 is reserved and refuses instantly.
    await expect(resolver({ timeoutMs: 2_000 }).resolve('http://127.0.0.1:1/x')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('surfaces caller cancellation as CANCELLED', async () => {
    const controller = new AbortController();
    const promise = resolver().resolve(`${base}/slow`, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
