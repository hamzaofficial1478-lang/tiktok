import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFetchableUrl,
  commitPart,
  discardPart,
  downloadToPart,
  partPathFor,
} from '@main/download/downloader';

/**
 * Driven against a real HTTP server writing to a real temp directory.
 *
 * The guarantee under test — "no output file ever exists in a truncated state
 * under its final name" — is a statement about the filesystem, so a mocked
 * fetch writing to a mocked fs would prove nothing about it.
 */
const BODY = Buffer.from('x'.repeat(64 * 1024));

let server: Server;
let base: string;
let dir: string;
/** Set to cut the response short after N bytes, simulating a dropped transfer. */
let truncateAfter: number | null = null;
let ignoreRange = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';

    if (path === '/empty') {
      res.writeHead(200, { 'content-length': '0' });
      return res.end();
    }
    if (path === '/slow') {
      // Dribbles the body out so a cancellation lands mid-transfer rather than
      // racing a 64KB localhost response that finishes instantly.
      res.writeHead(200, { 'content-length': String(BODY.length) });
      let sent = 0;
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        res.write(BODY.subarray(sent, sent + 4_096));
        sent += 4_096;
        if (sent >= BODY.length) {
          clearInterval(tick);
          res.end();
        }
      }, 25);
      req.on('close', () => clearInterval(tick));
      return;
    }
    if (path.startsWith('/status/')) {
      res.writeHead(Number(path.slice('/status/'.length)));
      return res.end();
    }

    const range = ignoreRange ? null : req.headers.range;
    const match = range ? /bytes=(\d+)-/.exec(range) : null;
    const start = match ? Number(match[1]) : 0;

    if (start >= BODY.length) {
      res.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
      return res.end();
    }

    const slice = BODY.subarray(start);
    if (start > 0 && !ignoreRange) {
      res.writeHead(206, {
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
      });
    } else {
      res.writeHead(200, { 'content-length': String(BODY.length) });
    }

    if (truncateAfter !== null) {
      // Write a prefix and hang up, exactly as a dropped connection does.
      // The socket is destroyed only once the prefix has actually flushed —
      // destroying immediately resets the connection before the client has
      // even parsed the headers, which is a different failure entirely.
      res.flushHeaders();
      res.write(slice.subarray(0, truncateAfter), () => {
        setTimeout(() => res.destroy(), 10);
      });
      return;
    }
    return res.end(slice);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dl-'));
  truncateAfter = null;
  ignoreRange = false;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function target(name = 'video.mp4'): string {
  return join(dir, name);
}

async function download(path: string, targetPath: string, signal = new AbortController().signal) {
  const progress: { bytesDone: number; bytesTotal: number | null }[] = [];
  const outcome = await downloadToPart({
    url: `${base}${path}`,
    targetPath,
    signal,
    skipSpaceCheck: true,
    // The fixture server runs on 127.0.0.1, which the SSRF guard blocks by
    // design. Opting out here keeps the guard on everywhere else.
    allowPrivateHosts: true,
    onProgress: (p) => progress.push({ bytesDone: p.bytesDone, bytesTotal: p.bytesTotal }),
  });
  return { outcome, progress };
}

describe('downloading to .part', () => {
  it('writes to .part and never to the final name', async () => {
    const path = target();
    const { outcome } = await download('/video', path);

    expect(outcome.partPath).toBe(`${path}.part`);
    expect(existsSync(outcome.partPath)).toBe(true);
    // The final name must not exist until commitPart runs.
    expect(existsSync(path)).toBe(false);
    expect(statSync(outcome.partPath).size).toBe(BODY.length);
  });

  it('renames atomically into place on commit', async () => {
    const path = target();
    const { outcome } = await download('/video', path);

    commitPart(outcome.partPath, path);

    expect(existsSync(path)).toBe(true);
    expect(existsSync(outcome.partPath)).toBe(false);
    expect(readFileSync(path).length).toBe(BODY.length);
  });

  it('reports progress that ends at the full size', async () => {
    const { progress } = await download('/video', target());

    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1];
    expect(last?.bytesDone).toBe(BODY.length);
    expect(last?.bytesTotal).toBe(BODY.length);
  });

  it('leaves a resumable .part when the transfer drops', async () => {
    truncateAfter = 8 * 1024;
    const path = target();

    await expect(
      downloadToPart({
        url: `${base}/video`,
        targetPath: path,
        signal: new AbortController().signal,
        skipSpaceCheck: true,
        onProgress: () => {},
      allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });

    // The partial is kept for resume; the final name still does not exist.
    expect(existsSync(partPathFor(path))).toBe(true);
    expect(statSync(partPathFor(path)).size).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
  });

  it('resumes from an existing .part instead of starting over', async () => {
    const path = target();
    truncateAfter = 8 * 1024;
    await downloadToPart({
      url: `${base}/video`,
      targetPath: path,
      signal: new AbortController().signal,
      skipSpaceCheck: true,
      onProgress: () => {},
    allowPrivateHosts: true,
    }).catch(() => undefined);

    const partialSize = statSync(partPathFor(path)).size;
    expect(partialSize).toBeGreaterThan(0);

    truncateAfter = null;
    const { outcome } = await download('/video', path);

    expect(outcome.resumedFrom).toBe(partialSize);
    expect(outcome.bytes).toBe(BODY.length);
    commitPart(outcome.partPath, path);
    // The resumed file must be byte-identical to the original.
    expect(readFileSync(path).equals(BODY)).toBe(true);
  });

  it('restarts rather than splicing when the server ignores Range', async () => {
    const path = target();
    writeFileSync(partPathFor(path), Buffer.alloc(1_024, 1));
    ignoreRange = true;

    const { outcome } = await download('/video', path);

    // Appending a full 200 response to a partial would produce a corrupt file.
    expect(outcome.resumedFrom).toBe(0);
    expect(outcome.bytes).toBe(BODY.length);
    commitPart(outcome.partPath, path);
    expect(readFileSync(path).equals(BODY)).toBe(true);
  });

  it('starts over when the range is past the end of the file', async () => {
    const path = target();
    writeFileSync(partPathFor(path), Buffer.alloc(BODY.length + 10, 2));

    const { outcome } = await download('/video', path);

    expect(outcome.bytes).toBe(BODY.length);
    commitPart(outcome.partPath, path);
    expect(readFileSync(path).equals(BODY)).toBe(true);
  });

  it('deletes the .part when the user cancels', async () => {
    const path = target();
    const controller = new AbortController();

    const promise = downloadToPart({
      url: `${base}/slow`,
      targetPath: path,
      signal: controller.signal,
      skipSpaceCheck: true,
      onProgress: () => {},
    allowPrivateHosts: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    // Section 8: cancelling must leave nothing behind.
    expect(existsSync(partPathFor(path))).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects an empty response rather than saving a zero-byte file', async () => {
    const path = target();
    await expect(download('/empty', path)).rejects.toMatchObject({ code: 'DOWNLOAD_INCOMPLETE' });
    expect(existsSync(partPathFor(path))).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('maps HTTP statuses to the taxonomy', async () => {
    const cases = [
      ['404', 'VIDEO_DELETED'],
      ['403', 'CDN_FORBIDDEN'],
      ['429', 'RATE_LIMITED'],
      ['503', 'NETWORK_ERROR'],
    ] as const;

    for (const [status, code] of cases) {
      await expect(download(`/status/${status}`, target(`s${status}.mp4`)), status).rejects.toMatchObject({ code });
    }
  });

  it('discards a partial on request', async () => {
    const path = target();
    writeFileSync(partPathFor(path), 'partial');
    discardPart(path);
    expect(existsSync(partPathFor(path))).toBe(false);
  });

  it('creates the output directory when it does not exist', async () => {
    const nested = join(dir, 'a', 'b', 'video.mp4');
    const { outcome } = await download('/video', nested);
    commitPart(outcome.partPath, nested);
    expect(existsSync(nested)).toBe(true);
  });
});

describe('refusing untrustworthy download URLs', () => {
  function detailOf(fn: () => void): string {
    try {
      fn();
    } catch (err) {
      return (err as { detail?: string }).detail ?? String(err);
    }
    throw new Error('expected it to throw');
  }

  it.each([
    'file:///C:/Windows/System32/config/SAM',
    'file:///etc/passwd',
    'ftp://example.com/video.mp4',
    'data:video/mp4;base64,AAAA',
  ])('refuses the %s scheme', (url) => {
    expect(detailOf(() => assertFetchableUrl(url))).toMatch(/refusing to download/i);
  });

  it.each([
    'http://localhost:8080/admin',
    'http://127.0.0.1/secret',
    'http://[::1]/secret',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/router',
    'http://172.16.0.1/internal',
  ])('refuses the private address in %s', (url) => {
    expect(detailOf(() => assertFetchableUrl(url))).toMatch(/private address/i);
  });

  it('accepts an ordinary public CDN URL', () => {
    expect(() => assertFetchableUrl('https://v16-webapp.tiktok.com/video.mp4?a=1')).not.toThrow();
    expect(() => assertFetchableUrl('http://cdn.example.com/video.mp4')).not.toThrow();
  });

  it('refuses something that is not a URL at all', () => {
    expect(detailOf(() => assertFetchableUrl('not a url'))).toMatch(/cannot be parsed/i);
  });

  it('is enforced by downloadToPart, not only available to callers', async () => {
    // The check has to sit on the path that actually fetches, or it is
    // decoration.
    await expect(
      downloadToPart({
        url: 'file:///etc/passwd',
        targetPath: target('out.mp4'),
        signal: new AbortController().signal,
        onProgress: () => {},
      allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ detail: expect.stringMatching(/refusing to download/i) });
  });
});
