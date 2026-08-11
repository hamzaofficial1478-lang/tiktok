import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { AppConfigSchema, DEFAULT_CONFIG, type AppConfig } from '@shared/config-schema';

/**
 * The single settings module (spec section 13).
 *
 * Two behaviours worth stating because they are the ones users notice:
 *
 * 1. Unknown or invalid values never throw the app into a broken state. A
 *    config file that fails validation is backed up and replaced with defaults,
 *    because refusing to start over a malformed JSON file is a far worse
 *    outcome than losing preferences.
 * 2. Writes are atomic (temp file + fsync + rename). A power cut mid-save
 *    leaves the previous config intact rather than a truncated file — the same
 *    guarantee section 8 demands for downloads, applied to settings.
 */
export class ConfigStore {
  private current: AppConfig;
  private readonly subscribers = new Set<(config: AppConfig) => void>();

  private constructor(
    private readonly filePath: string,
    initial: AppConfig,
    private readonly log: Logger,
  ) {
    this.current = initial;
  }

  static load(filePath: string, log: Logger): ConfigStore {
    let config: AppConfig = { ...DEFAULT_CONFIG };

    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
        // Merge over defaults so a config written by an older version simply
        // picks up new keys instead of failing validation on absent ones.
        const merged = { ...DEFAULT_CONFIG, ...(raw as Record<string, unknown>) };
        const parsed = AppConfigSchema.safeParse(merged);
        if (parsed.success) {
          config = parsed.data;
        } else {
          const backup = `${filePath}.invalid-${Date.now()}`;
          try {
            renameSync(filePath, backup);
          } catch {
            /* best effort */
          }
          log.warn(
            { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), backup },
            'config failed validation; reset to defaults',
          );
        }
      } catch (err) {
        log.warn({ err: String(err) }, 'config unreadable; using defaults');
      }
    }

    const store = new ConfigStore(filePath, config, log);
    if (!existsSync(filePath)) store.persist();
    return store;
  }

  get(): AppConfig {
    return this.current;
  }

  /**
   * Applies a partial update. The merged result is validated as a whole, so a
   * single bad field rejects the update rather than half-applying it.
   */
  update(patch: Partial<AppConfig>): AppConfig {
    const parsed = AppConfigSchema.safeParse({ ...this.current, ...patch });
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid settings: ${detail}`);
    }
    this.current = parsed.data;
    this.persist();
    for (const fn of this.subscribers) {
      try {
        fn(this.current);
      } catch {
        /* ignore misbehaving subscriber */
      }
    }
    return this.current;
  }

  subscribe(fn: (config: AppConfig) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, JSON.stringify(this.current, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.log.error({ err: String(err) }, 'failed to persist config');
    }
  }
}
