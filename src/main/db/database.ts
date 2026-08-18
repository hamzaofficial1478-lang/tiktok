import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Logger } from 'pino';
import { MIGRATIONS } from './migrations';
import { runMigrations, type MigrationResult } from './migrator';

export interface OpenDatabaseOptions {
  /** Absolute file path, or ':memory:' in tests. */
  file: string;
  log?: Logger;
}

export interface DatabaseHandle {
  readonly db: DatabaseType;
  readonly migration: MigrationResult;
  close(): void;
}

/**
 * Opens the library database and brings it to the current schema version.
 *
 * PRAGMA choices, all of which matter for this workload:
 *   journal_mode = WAL   readers never block the writer, so the Library screen
 *                        can query while a 300-item batch is writing.
 *   foreign_keys = ON    off by default in SQLite; `downloads.video_id` would
 *                        otherwise be a suggestion rather than a constraint.
 *   busy_timeout         a queue worker and a UI query can collide; wait
 *                        rather than throwing SQLITE_BUSY at the user.
 *   synchronous = FULL   every commit reaches the disk before it is reported
 *                        as committed. See below — this was NORMAL, and the
 *                        reasoning that chose NORMAL had a hole in it.
 *
 * ## Why FULL, when NORMAL is the usual advice with WAL
 *
 * NORMAL is the right default for a cache. This is not a cache: it is the
 * record of which links are still owed and which videos have already been
 * taken, and losing the tail of it after a power cut means re-downloading
 * videos that are already on disk and, worse, re-downloading them under
 * "(2)" names because the file the ledger forgot about is still there.
 *
 * The earlier note called that "a fine trade for the write throughput", which
 * was true when progress was written to SQLite four times a second per active
 * item. It is not written that way any more — see the queue engine's
 * `onProgress`, which now persists roughly every two seconds and keeps the
 * live figures in memory where they belong. With the write rate an order of
 * magnitude lower, the throughput that paid for NORMAL is no longer being
 * bought with anything, so the durability comes back for free.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true });

  const db = new Database(options.file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');

  const migration = runMigrations(db, MIGRATIONS, options.log);

  return {
    db,
    migration,
    close(): void {
      db.close();
    },
  };
}
