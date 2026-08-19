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

  it('backs up an invalid config rather than refusing to launch', () => {
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, concurrency: 99 }));

    const store = ConfigStore.load(file, silent);
    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(readdirSync(dir).some((f) => f.includes('.invalid-'))).toBe(true);
  });

  it('resets only the setting that is broken, and keeps the rest', () => {
    writeFileSync(
      file,
      JSON.stringify({ ...DEFAULT_CONFIG, outputDir: 'D:/TikTok', proxyUrl: 'not a url', concurrency: 3 }),
    );

    const store = ConfigStore.load(file, silent);
    // One unreadable field used to cost every field. Losing a chosen output
    // folder because a proxy URL was malformed is not a settings reset, it is
    // an app that forgets.
    expect(store.get().proxyUrl).toBe('');
    expect(store.get().outputDir).toBe('D:/TikTok');
    expect(store.get().concurrency).toBe(3);
  });

  it('keeps the output folder when a nested block gains a field in a later version', () => {
    // Exactly the upgrade path that reset people's output folder: captions was
    // written by an older build and the schema has moved on since.
    const { captions: _dropped, ...rest } = DEFAULT_CONFIG;
    writeFileSync(
      file,
      JSON.stringify({ ...rest, outputDir: 'D:/TikTok', captions: { mode: 'burn', style: 'not-a-style' } }),
    );

    const store = ConfigStore.load(file, silent);
    expect(store.get().outputDir).toBe('D:/TikTok');
  });

  it('rescues a nested block that is merely missing a newly added option', () => {
    const { source: _added, ...olderCaptions } = DEFAULT_CONFIG.captions;
    writeFileSync(
      file,
      JSON.stringify({ ...DEFAULT_CONFIG, outputDir: 'D:/TikTok', captions: { ...olderCaptions, mode: 'burn' } }),
    );

    const store = ConfigStore.load(file, silent);
    expect(store.get().outputDir).toBe('D:/TikTok');
    // Merged over the default rather than thrown away, so the user's other
    // caption choices survive too.
    expect(store.get().captions.mode).toBe('burn');
    expect(store.get().captions.source).toBe(DEFAULT_CONFIG.captions.source);
  });

  it('rescues a style block written before the newest options existed', () => {
    // Two levels down, which is where the caption options actually live — a
    // shallow merge would have replaced the whole style block and failed.
    const { fontFamily: _added, ...olderStyle } = DEFAULT_CONFIG.captions.style;
    writeFileSync(
      file,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        outputDir: 'D:/TikTok',
        captions: { ...DEFAULT_CONFIG.captions, style: { ...olderStyle, bold: !DEFAULT_CONFIG.captions.style.bold } },
      }),
    );

    const store = ConfigStore.load(file, silent);
    expect(store.get().outputDir).toBe('D:/TikTok');
    expect(store.get().captions.style.fontFamily).toBe(DEFAULT_CONFIG.captions.style.fontFamily);
    expect(store.get().captions.style.bold).toBe(!DEFAULT_CONFIG.captions.style.bold);
  });

  it('writes the repaired config back, so the next launch is clean', () => {
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, outputDir: 'D:/TikTok', proxyUrl: 'not a url' }));

    ConfigStore.load(file, silent);
    const reloaded = ConfigStore.load(file, silent);
    expect(reloaded.get().outputDir).toBe('D:/TikTok');
    // Repaired once: the second load found nothing to back up.
    expect(readdirSync(dir).filter((f) => f.includes('.invalid-'))).toHaveLength(1);
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

describe('bringing a stored config forward when a default changes', () => {
  it('replaces the old filename template that reused numbers across pastes', () => {
    // `{n}` restarts at 1 for every paste and for every account a creator run
    // visits, so five videos added in two goes came out 001, 002, 003, 001,
    // 002 — the same numbers twice in a folder meant to read in order.
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, filenameTemplate: '{n:3} - {author} - {id}' }));

    const store = ConfigStore.load(file, silent);
    expect(store.get().filenameTemplate).toBe('{index:3} - {author} - {id}');
  });

  it('writes the change to disk, so it is not redone on every launch', () => {
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, filenameTemplate: '{n:3} - {author} - {id}' }));
    ConfigStore.load(file, silent);

    expect(JSON.parse(readFileSync(file, 'utf8')).filenameTemplate).toBe('{index:3} - {author} - {id}');
  });

  it('leaves a template the user wrote themselves completely alone', () => {
    // Even though it has the same flaw. Silently editing someone's own setting
    // is a worse failure than the numbering it would fix.
    const mine = '{n:2}_{caption:20}_{id}';
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, filenameTemplate: mine }));

    expect(ConfigStore.load(file, silent).get().filenameTemplate).toBe(mine);
  });

  it('does not touch a config already on the new default', () => {
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, outputDir: 'D:/TikTok' }));
    const store = ConfigStore.load(file, silent);

    expect(store.get().filenameTemplate).toBe(DEFAULT_CONFIG.filenameTemplate);
    expect(store.get().outputDir).toBe('D:/TikTok');
  });
});
