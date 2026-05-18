import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database, { type Database as DB } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export interface OpenOptions {
  path?: string;
  readonly?: boolean;
}

export function defaultDbPath(): string {
  return process.env.CAPITU_KB_PATH ?? join(homedir(), '.capitu', 'kb.db');
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
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION),
      );
    }
  }

  return db;
}
