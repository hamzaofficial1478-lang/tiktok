import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type LoggerHandle } from '@main/logging/logger';
import type { LogEntry } from '@shared/ipc/contract';

let dir: string;
let handle: LoggerHandle;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-'));
});

afterEach(async () => {
  await handle?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('logger', () => {
  it('writes structured entries to a file and the ring buffer', async () => {
    handle = createLogger({ directory: dir, level: 'info' });
    handle.log.child({ scope: 'db' }).info({ items: 3 }, 'applied migration');
    await flush();

    const tail = handle.tail(10);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ level: 'info', scope: 'db', msg: 'applied migration' });
    expect(tail[0]?.data).toMatchObject({ items: 3 });

    const contents = readFileSync(join(dir, 'app.log'), 'utf8');
    expect(JSON.parse(contents.trim()).msg).toBe('applied migration');
  });

  it('respects the level threshold', async () => {
    handle = createLogger({ directory: dir, level: 'warn' });
    handle.log.info('ignored');
    handle.log.error('kept');
    await flush();

    expect(handle.tail(10).map((e) => e.msg)).toEqual(['kept']);
  });

  it('changes level at runtime, as the Settings screen does', async () => {
    handle = createLogger({ directory: dir, level: 'error' });
    handle.log.debug('before');
    handle.setLevel('debug');
    handle.log.debug('after');
    await flush();

    expect(handle.tail(10).map((e) => e.msg)).toEqual(['after']);
  });

  it('streams entries to subscribers and stops after unsubscribe', async () => {
    handle = createLogger({ directory: dir, level: 'info' });
    const seen: LogEntry[] = [];
    const unsubscribe = handle.subscribe((e) => seen.push(e));

    handle.log.info('one');
    await flush();
    unsubscribe();
    handle.log.info('two');
    await flush();

    expect(seen.map((e) => e.msg)).toEqual(['one']);
  });

  it('caps the ring buffer so a 300-item batch cannot grow it without bound', async () => {
    handle = createLogger({ directory: dir, level: 'info', ringSize: 50 });
    for (let i = 0; i < 200; i++) handle.log.info(`entry ${i}`);
    await flush();

    const tail = handle.tail(1_000);
    expect(tail).toHaveLength(50);
    expect(tail[tail.length - 1]?.msg).toBe('entry 199');
  });

  it('redacts sensitive fields while keeping the surrounding context', async () => {
    handle = createLogger({ directory: dir, level: 'info' });
    handle.log.info({ proxyUrl: 'http://user:secret@proxy:8080', host: 'tiktok.com' }, 'using proxy');
    await flush();

    const entry = handle.tail(1)[0];
    expect(entry?.data?.['proxyUrl']).toBe('[redacted]');
    expect(entry?.data?.['host']).toBe('tiktok.com');
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).not.toContain('secret');
  });

  it('rotates the active file and keeps a bounded number of old ones', async () => {
    handle = createLogger({ directory: dir, level: 'info', maxBytes: 700, maxFiles: 2 });
    for (let i = 0; i < 120; i++) handle.log.info({ i }, 'a reasonably long message to force rotation quickly');
    await flush();

    const files = readdirSync(dir).sort();
    expect(files).toContain('app.log');
    expect(files.some((f) => /^app\.\d+\.log$/.test(f))).toBe(true);
    // maxFiles rotated + 1 active
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
