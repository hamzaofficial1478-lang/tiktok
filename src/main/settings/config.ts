import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { AppConfigSchema, DEFAULT_CONFIG, type AppConfig } from '@shared/config-schema';

/**
 * The single settings module (spec section 13).
 *
 * Three behaviours worth stating because they are the ones users notice:
 *
 * 1. Unknown or invalid values never throw the app into a broken state. A
 *    config file that fails validation is backed up rather than refused,
 *    because refusing to start over a malformed JSON file is a far worse
 *    outcome than losing preferences.
 * 2. A setting is only lost if that setting is the broken one. See
 *    `recoverConfig` — this is the fix for an output folder that reset itself
 *    on launch.
 * 3. Writes are atomic (temp file + fsync + rename). A power cut mid-save
 *    leaves the previous config intact rather than a truncated file — the same
 *    guarantee section 8 demands for downloads, applied to settings.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The saved value laid over the default, all the way down.
 *
 * Recursive rather than shallow because the settings that change shape are the
 * nested ones — `captions.style` gains options as the caption work continues,
 * and a shallow merge would replace the whole style block with an older one
 * that is missing the new keys, failing validation for the very reason this is
 * trying to avoid.
 */
function overlay(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = base[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? overlay(existing, value) : value;
  }
  return out;
}

/**
 * Salvages everything still valid from a config file that failed validation.
 *
 * The bug this exists for: settings were validated as one object, so a single
 * unreadable field reset *every* setting to its default. The field that
 * actually changed shape was `captions`, which gains options as the caption
 * work continues — and because the load merge is shallow, an older nested
 * captions object is handed to the schema exactly as it was written. The user
 * chose an output folder, the app added a caption option, and the next launch
 * had no output folder. Nothing about that is obvious from where they sit;
 * it just looks like the app forgets.
 *
 * So each field is now judged on its own. A nested object gets one more
 * chance first, merged over its default, which is what rescues a captions
 * block that is merely missing a newly added key rather than wrong.
 */
/**
 * Templates that shipped as a default and have since been superseded.
 *
 * Only exact matches are rewritten. A template someone typed themselves is
 * theirs, even if it has the same flaw — silently editing a user's setting is
 * a worse failure than the numbering it would fix.
 */
const SUPERSEDED_TEMPLATES = new Map<string, string>([
  // `{n}` restarts at 1 for every paste and every account a run visits, so a
  // second batch reused the numbers of the first: 001, 002, 003, 001, 002.
  // `{index}` is allocated from a counter in the database and never restarts.
  ['{n:3} - {author} - {id}', '{index:3} - {author} - {id}'],
]);

/**
 * Brings a stored config forward when a default has changed under it.
 *
 * Changing `DEFAULT_CONFIG` only helps a fresh install: everyone else has the
 * old value written to disk, and would keep it forever. This is the step that
 * makes a corrected default reach the people who already have the old one.
 */
export function migrateConfig(config: AppConfig): { config: AppConfig; changed: string[] } {
  const changed: string[] = [];
  let next = config;

  const upgraded = SUPERSEDED_TEMPLATES.get(config.filenameTemplate);
  if (upgraded) {
    next = { ...next, filenameTemplate: upgraded };
    changed.push('filenameTemplate');
  }

  return { config: next, changed };
}

export function recoverConfig(raw: Record<string, unknown>): { config: AppConfig; reset: string[] } {
  const shape = AppConfigSchema.shape as Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  const reset: string[] = [];

  for (const key of Object.keys(shape)) {
    if (!(key in raw)) continue;
    const field = shape[key];
    if (!field) continue;

    const direct = field.safeParse(raw[key]);
    if (direct.success) {
      merged[key] = direct.data;
      continue;
    }

    const fallback = DEFAULT_CONFIG[key as keyof AppConfig];
    const saved = raw[key];
    if (isPlainObject(saved) && isPlainObject(fallback)) {
      const patched = field.safeParse(overlay(fallback, saved));
      if (patched.success) {
        merged[key] = patched.data;
        continue;
      }
    }

    reset.push(key);
  }

  const parsed = AppConfigSchema.safeParse(merged);
  // Defaults alone must always validate, so this branch means a default is
  // itself broken — a bug in this file, not in the user's config.
  return { config: parsed.success ? parsed.data : { ...DEFAULT_CONFIG }, reset };
}
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
          // Keep everything that still reads, and say precisely what did not.
          const recovered = recoverConfig(merged);
          config = recovered.config;

          const backup = `${filePath}.invalid-${Date.now()}`;
          try {
            renameSync(filePath, backup);
          } catch {
            /* best effort */
          }
          log.warn(
            {
              issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
              reset: recovered.reset,
              kept: Object.keys(AppConfigSchema.shape).filter((key) => !recovered.reset.includes(key)).length,
              backup,
            },
            recovered.reset.length > 0
              ? 'some settings could not be read and were reset; the rest were kept'
              : 'the config file needed repairing; every setting was kept',
          );
        }
      } catch (err) {
        log.warn({ err: String(err) }, 'config unreadable; using defaults');
      }
    }

    /**
     * Applied after loading and before anything reads it, so the corrected
     * value is what the first download uses rather than the one after a
     * restart.
     */
    const migrated = migrateConfig(config);
    const store = new ConfigStore(filePath, migrated.config, log);

    if (migrated.changed.length > 0) {
      log.info({ changed: migrated.changed }, 'brought stored settings forward to the current defaults');
      store.persist();
    } else if (!existsSync(filePath)) {
      store.persist();
    }
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
