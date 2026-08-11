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
 *   synchronous = NORMAL the correct pairing with WAL: durable against app
 *                        crashes, and only at risk from an OS-level crash,
 *                        which for a re-downloadable media library is a fine
 *                        trade for the write throughput.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true });

  const db = new Database(options.file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  const migration = runMigrations(db, MIGRATIONS, options.log);

  return {
    db,
    migration,
    close(): void {
      db.close();
    },
  };
}
