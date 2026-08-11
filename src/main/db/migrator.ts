import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';

export interface Migration {
  /** 1-based, contiguous, never reordered or renumbered once shipped. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/**
 * Migration runner — required "from day one" (spec section 5) because shipping
 * updates must never wipe a user's library.
 *
 * Design notes:
 *  - Version is tracked in `PRAGMA user_version`, not a table. It is atomic
 *    with the transaction that applies the migration, so there is no window
 *    where the schema has changed but the bookkeeping has not.
 *  - Each migration runs inside a transaction together with its version bump.
 *    A migration that throws leaves the database exactly as it was.
 *  - A database newer than the app is a hard error, not a best-effort open.
 *    An older build writing against a newer schema is how libraries get
 *    corrupted, and a clear "this library was made by a newer version" beats
 *    silent damage every time.
 */
export function runMigrations(db: Database, migrations: readonly Migration[], log?: Logger): MigrationResult {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);

  ordered.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migration versions must be contiguous starting at 1; expected ${i + 1} but found ${m.version} (${m.name})`,
      );
    }
  });

  const currentRow = db.pragma('user_version', { simple: true });
  const current = typeof currentRow === 'number' ? currentRow : 0;
  const target = ordered.length;

  if (current > target) {
    throw new Error(
      `This library was created by a newer version of the app (schema v${current}, this build supports v${target}). ` +
        'Update the app to open it.',
    );
  }

  if (current === target) {
    log?.debug({ version: current }, 'database schema up to date');
    return { from: current, to: current, applied: [] };
  }

  const applied: string[] = [];
  for (const migration of ordered) {
    if (migration.version <= current) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // pragma value cannot be bound as a parameter
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      apply();
    } catch (err) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    applied.push(migration.name);
    log?.info({ version: migration.version, name: migration.name }, 'applied migration');
  }

  return { from: current, to: target, applied };
}
