import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { ConfigStore } from '@main/settings/config';
import { DEFAULT_CONFIG } from '@shared/config-schema';

const silent = pino({ level: 'silent' });
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  file = join(dir, 'config.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ConfigStore', () => {
  it('writes defaults on first run and reads them back', () => {
    const store = ConfigStore.load(file, silent);
    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_CONFIG);
  });

  it('persists updates across a reload', () => {
    ConfigStore.load(file, silent).update({ concurrency: 3, watermarkMode: 'force_removal' });

    const reloaded = ConfigStore.load(file, silent);
    expect(reloaded.get().concurrency).toBe(3);
    expect(reloaded.get().watermarkMode).toBe('force_removal');
  });

  it('picks up new keys added by a later version instead of failing validation', () => {
    // A config file written by an older build, missing keys this build knows.
    writeFileSync(file, JSON.stringify({ concurrency: 2, schemaVersion: 1 }));

    const store = ConfigStore.load(file, silent);
    expect(store.get().concurrency).toBe(2);
    expect(store.get().outroMode).toBe(DEFAULT_CONFIG.outroMode);
  });

  it('backs up an invalid config and starts from defaults rather than refusing to launch', () => {
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, concurrency: 99 }));

    const store = ConfigStore.load(file, silent);
    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(readdirSync(dir).some((f) => f.includes('.invalid-'))).toBe(true);
  });

  it('survives an unparseable config file', () => {
    writeFileSync(file, '{ not json at all');
    expect(ConfigStore.load(file, silent).get()).toEqual(DEFAULT_CONFIG);
  });

  it('rejects out-of-range values without half-applying the update', () => {
    const store = ConfigStore.load(file, silent);

    expect(() => store.update({ concurrency: 5 })).toThrow(/concurrency/i);
    expect(() => store.update({ rateLimitMs: 100 })).toThrow(/rateLimitMs/i);
    // The valid half of a rejected update must not stick.
    expect(() => store.update({ watermarkMode: 'keep', concurrency: 0 })).toThrow();
    expect(store.get().watermarkMode).toBe(DEFAULT_CONFIG.watermarkMode);
  });

  it('enforces spec bounds: concurrency 1-4, rate limit 0.5-10s', () => {
    const store = ConfigStore.load(file, silent);
    expect(store.update({ concurrency: 1 }).concurrency).toBe(1);
    expect(store.update({ concurrency: 4 }).concurrency).toBe(4);
    expect(store.update({ rateLimitMs: 500 }).rateLimitMs).toBe(500);
    expect(store.update({ rateLimitMs: 10_000 }).rateLimitMs).toBe(10_000);
    expect(() => store.update({ rateLimitMs: 10_001 })).toThrow();
  });

  it('requires a filename template that can stay unique', () => {
    const store = ConfigStore.load(file, silent);
    expect(() => store.update({ filenameTemplate: '{author}' })).toThrow(/\{id\}|\{index\}/);
    expect(() => store.update({ filenameTemplate: 'sub/dir/{id}' })).toThrow(/path separators/i);
    expect(store.update({ filenameTemplate: '{author} - {caption:40} [{id}]' }).filenameTemplate).toContain('{id}');
  });

  it('validates the proxy URL only when one is set', () => {
    const store = ConfigStore.load(file, silent);
    expect(store.update({ proxyUrl: '' }).proxyUrl).toBe('');
    expect(store.update({ proxyUrl: 'socks5://127.0.0.1:9050' }).proxyUrl).toBe('socks5://127.0.0.1:9050');
    expect(() => store.update({ proxyUrl: 'not a url' })).toThrow(/proxy/i);
  });

  it('notifies subscribers on change', () => {
    const store = ConfigStore.load(file, silent);
    const seen: number[] = [];
    const unsubscribe = store.subscribe((c) => seen.push(c.concurrency));

    store.update({ concurrency: 2 });
    unsubscribe();
    store.update({ concurrency: 3 });

    expect(seen).toEqual([2]);
  });

  it('never leaves a temp file behind after a successful write', () => {
    ConfigStore.load(file, silent).update({ concurrency: 2 });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});
