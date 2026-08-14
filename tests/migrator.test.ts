import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, type Migration } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

const tableNames = (db: Database.Database): string[] =>
  db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

describe('migration runner', () => {
  it('applies every migration to a fresh database and records the version', () => {
    const db = freshDb();
    const result = runMigrations(db, MIGRATIONS);

    expect(result.from).toBe(0);
    expect(result.to).toBe(MIGRATIONS.length);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.name));
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['videos', 'downloads', 'queue_items', 'app_meta']));
  });

  it('is idempotent — re-running applies nothing', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    const second = runMigrations(db, MIGRATIONS);

    expect(second.applied).toEqual([]);
    expect(second.from).toBe(MIGRATIONS.length);
    expect(second.to).toBe(MIGRATIONS.length);
  });

  it('applies only the missing migrations to a partially migrated database', () => {
    const db = freshDb();
    runMigrations(db, [MIGRATIONS[0] as Migration]);
    expect(db.pragma('user_version', { simple: true })).toBe(1);

    const result = runMigrations(db, MIGRATIONS);
    expect(result.from).toBe(1);
    // Derived from the registry so adding a migration does not make this
    // assertion stale — what is under test is "everything after the first",
    // not any particular migration's name.
    expect(result.applied).toEqual(MIGRATIONS.slice(1).map((m) => m.name));
  });

  it('refuses to open a database created by a newer build rather than damaging it', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    db.pragma(`user_version = ${MIGRATIONS.length + 5}`);

    expect(() => runMigrations(db, MIGRATIONS)).toThrow(/newer version of the app/i);
  });

  it('rolls back a failing migration completely', () => {
    const db = freshDb();
    const broken: Migration[] = [
      { version: 1, name: 'ok', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' },
      { version: 2, name: 'boom', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY); CREATE TABLE b (nope);' },
    ];

    expect(() => runMigrations(db, broken)).toThrow(/failed and was rolled back/i);
    // The partial work from migration 2 must be gone, and the version must
    // still reflect migration 1 — otherwise a retry would skip it.
    expect(tableNames(db)).toContain('a');
    expect(tableNames(db)).not.toContain('b');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('rejects non-contiguous versions so a misnumbered migration cannot silently skip', () => {
    const db = freshDb();
    const gap: Migration[] = [
      { version: 1, name: 'one', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' },
      { version: 3, name: 'three', sql: 'CREATE TABLE c (id INTEGER PRIMARY KEY);' },
    ];

    expect(() => runMigrations(db, gap)).toThrow(/contiguous/i);
  });

  it('ships the exact schema section 5 specifies', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);

    const columns = (table: string): string[] =>
      db
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);

    expect(columns('videos')).toEqual([
      'id',
      'aweme_id',
      'canonical_url',
      'author_handle',
      'author_name',
      'caption',
      'duration_ms',
      'cover_url',
      'music_title',
      'uploaded_at',
      'first_seen_at',
    ]);
    expect(columns('queue_items')).toEqual([
      'id',
      'position',
      'batch_id',
      'raw_url',
      'canonical_url',
      'aweme_id',
      'status',
      'progress',
      'bytes_done',
      'bytes_total',
      'attempt_count',
      'error_code',
      'error_detail',
      'duplicate_action',
      'created_at',
      'started_at',
      'finished_at',
      'source_strategy',
      'watermark_removed',
      'batch_index',
      // Where a profile-sourced batch is filed; null for individually pasted
      // links, which have no account in common.
      'output_subdir',
    ]);
    expect(columns('downloads')).toContain('source_strategy');
    expect(columns('downloads')).toContain('file_exists');
  });
});
