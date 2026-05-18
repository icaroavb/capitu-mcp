import type { Database } from 'better-sqlite3';
import { EMBEDDING_DIM } from './schema.js';
import type { DocChunk, StoredDoc } from './types.js';

function vecToBlob(vec: number[]): Buffer {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`embedding dim ${vec.length} != expected ${EMBEDDING_DIM}`);
  }
  const buf = Buffer.alloc(EMBEDDING_DIM * 4);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    buf.writeFloatLE(vec[i] ?? 0, i * 4);
  }
  return buf;
}

export function insertDoc(
  db: Database,
  chunk: DocChunk,
  embedding: number[],
): number {
  const insertDoc = db.prepare(`
    INSERT INTO docs (source, release, url, title, content, chunk_meta)
    VALUES (@source, @release, @url, @title, @content, @chunkMeta)
  `);
  const insertFts = db.prepare(
    'INSERT INTO docs_fts (rowid, content) VALUES (?, ?)',
  );
  const insertVec = db.prepare(
    'INSERT INTO docs_vec (rowid, embedding) VALUES (?, ?)',
  );

  // When embedding is empty (NullEmbeddings — BM25-only mode), skip the
  // vector insert. FTS5 still gets the row so keyword search works.
  const skipVec = embedding.length === 0;

  const tx = db.transaction((c: DocChunk, e: number[]) => {
    const info = insertDoc.run({
      source: c.source,
      release: c.release ?? null,
      url: c.url ?? null,
      title: c.title,
      content: c.content,
      chunkMeta: c.chunkMeta ? JSON.stringify(c.chunkMeta) : null,
    });
    const id = BigInt(info.lastInsertRowid);
    insertFts.run(id, c.content);
    if (!skipVec) {
      insertVec.run(id, vecToBlob(e));
    }
    return Number(id);
  });

  return tx(chunk, embedding);
}

export function getDoc(db: Database, id: number): StoredDoc | undefined {
  const row = db
    .prepare('SELECT * FROM docs WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToDoc(row);
}

function rowToDoc(row: Record<string, unknown>): StoredDoc {
  return {
    id: row.id as number,
    source: row.source as StoredDoc['source'],
    release: (row.release as string) ?? undefined,
    url: (row.url as string) ?? undefined,
    title: row.title as string,
    content: row.content as string,
    chunkMeta: row.chunk_meta ? JSON.parse(row.chunk_meta as string) : undefined,
    indexedAt: row.indexed_at as string,
  };
}

export function countDocs(db: Database, source?: string): number {
  const sql = source
    ? 'SELECT COUNT(*) as c FROM docs WHERE source = ?'
    : 'SELECT COUNT(*) as c FROM docs';
  const row = (source ? db.prepare(sql).get(source) : db.prepare(sql).get()) as {
    c: number;
  };
  return row.c;
}

export function deleteBySource(db: Database, source: string): number {
  const tx = db.transaction(() => {
    const ids = db
      .prepare('SELECT id FROM docs WHERE source = ?')
      .all(source) as { id: number }[];
    for (const { id } of ids) {
      db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(id);
      db.prepare('DELETE FROM docs_vec WHERE rowid = ?').run(id);
    }
    const info = db.prepare('DELETE FROM docs WHERE source = ?').run(source);
    return Number(info.changes);
  });
  return tx();
}

export { vecToBlob };
