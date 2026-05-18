import type { Database } from 'better-sqlite3';
import { vecToBlob } from './docs.js';
import type { SearchHit } from './types.js';

export interface SearchOptions {
  limit?: number;
  source?: string;
  release?: string;
  rrfK?: number;
}

interface RankedRow {
  id: number;
  rank: number;
}

export function searchDocs(
  db: Database,
  query: string,
  queryEmbedding: number[],
  opts: SearchOptions = {},
): SearchHit[] {
  const limit = opts.limit ?? 10;
  const k = opts.rrfK ?? 60;
  const candidatePool = Math.max(limit * 4, 40);

  // BM25 always runs. Vector search only when we have a real embedding —
  // in BM25-only mode (NullEmbeddings), queryEmbedding is [] and we skip vec.
  const bm25 = bm25Search(db, query, candidatePool, opts);
  const vec =
    queryEmbedding.length > 0
      ? vectorSearch(db, queryEmbedding, candidatePool, opts)
      : [];

  const scores = new Map<number, number>();
  for (const r of bm25) {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + r.rank));
  }
  for (const r of vec) {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + r.rank));
  }

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (topIds.length === 0) return [];

  const placeholders = topIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, source, release, url, title, content FROM docs WHERE id IN (${placeholders})`,
    )
    .all(...topIds.map(([id]) => id)) as Array<{
    id: number;
    source: string;
    release: string | null;
    url: string | null;
    title: string;
    content: string;
  }>;

  const byId = new Map(rows.map((r) => [r.id, r]));
  return topIds.flatMap(([id, score]) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        id: r.id,
        title: r.title,
        content: r.content,
        source: r.source as SearchHit['source'],
        release: r.release ?? undefined,
        url: r.url ?? undefined,
        score,
      } satisfies SearchHit,
    ];
  });
}

function bm25Search(
  db: Database,
  query: string,
  limit: number,
  opts: SearchOptions,
): RankedRow[] {
  const filters: string[] = [];
  const params: unknown[] = [escapeFtsQuery(query)];
  if (opts.source) {
    filters.push('d.source = ?');
    params.push(opts.source);
  }
  if (opts.release) {
    filters.push('d.release = ?');
    params.push(opts.release);
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
  params.push(limit);

  const sql = `
    SELECT d.id AS id
    FROM docs_fts f
    JOIN docs d ON d.id = f.rowid
    WHERE docs_fts MATCH ? ${where}
    ORDER BY bm25(docs_fts)
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params) as { id: number }[];
  return rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
}

function vectorSearch(
  db: Database,
  embedding: number[],
  limit: number,
  opts: SearchOptions,
): RankedRow[] {
  const blob = vecToBlob(embedding);

  // sqlite-vec KNN runs first, then we filter by source/release in a CTE
  const filters: string[] = [];
  const params: unknown[] = [blob, limit * 3];
  if (opts.source) {
    filters.push('d.source = ?');
    params.push(opts.source);
  }
  if (opts.release) {
    filters.push('d.release = ?');
    params.push(opts.release);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(limit);

  const sql = `
    WITH vec_hits AS (
      SELECT rowid, distance
      FROM docs_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    )
    SELECT v.rowid AS id, v.distance AS distance
    FROM vec_hits v
    JOIN docs d ON d.id = v.rowid
    ${where}
    ORDER BY v.distance
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params) as { id: number; distance: number }[];
  return rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
}

function escapeFtsQuery(q: string): string {
  // FTS5: wrap each token in quotes to avoid syntax errors on special chars
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(' ');
}
