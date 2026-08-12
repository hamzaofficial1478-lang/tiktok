import type { Database } from 'better-sqlite3';

/**
 * Durable key/value bookkeeping (migration 002).
 *
 * Distinct from AppConfig on purpose: config holds the user's *preferences*,
 * this holds the engine's *state*. "Was the queue running when we last exited"
 * is not a setting the user edits, and putting it in config.json would surface
 * it in Settings and let a malformed value take the whole config down with it.
 */
export class AppMetaRepository {
  constructor(private readonly db: Database) {}

  get(key: string): string | undefined {
    return this.db.prepare<[string], { value: string }>('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getBoolean(key: string, fallback = false): boolean {
    const value = this.get(key);
    return value === undefined ? fallback : value === '1';
  }

  setBoolean(key: string, value: boolean): void {
    this.set(key, value ? '1' : '0');
  }
}

/**
 * True while the user has the queue running. Written on every start/pause/stop
 * so an unclean exit still leaves an accurate answer, which is what lets the
 * next launch resume automatically rather than waiting to be told to.
 */
export const QUEUE_RUNNING_KEY = 'queue_running';
