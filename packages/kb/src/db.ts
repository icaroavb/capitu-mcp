import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database, { type Database as DB } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { envValue } from './winenv.js';

export interface OpenOptions {
  path?: string;
  readonly?: boolean;
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, 'CAPITU_KB_PATH') ?? join(homedir(), '.capitu', 'kb.db');
}

export function openKb(opts: OpenOptions = {}): DB {
  const path = opts.path ?? defaultDbPath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { readonly: opts.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  sqliteVec.load(db);

  if (!opts.readonly) {
    db.exec(SCHEMA_SQL);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    const current = row ? Number(row.value) : 0;
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION),
      );
    } else if (current < SCHEMA_VERSION) {
      runMigrations(db, current);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    }
  }

  return db;
}

/**
 * Apply forward migrations for a KB opened at an older schema version.
 *
 * `SCHEMA_SQL` is `CREATE IF NOT EXISTS`, so new tables already exist by the
 * time we get here — the job of a migration is the DATA side (e.g. backfilling
 * an FTS index that a pre-existing table's rows never populated).
 */
function runMigrations(db: DB, fromVersion: number): void {
  // v1 → v2: learnings_fts was added. An existing KB has learnings rows but an
  // empty FTS index — rebuild it from the external content table. Idempotent.
  if (fromVersion < 2) {
    try {
      db.exec("INSERT INTO learnings_fts(learnings_fts) VALUES('rebuild')");
    } catch {
      // If the rebuild command isn't supported for any reason, fall back to a
      // manual backfill so keyword recall still works on upgraded KBs.
      db.exec(
        'INSERT INTO learnings_fts (rowid, problem, solution) ' +
          'SELECT id, problem, solution FROM learnings',
      );
    }
  }
}
