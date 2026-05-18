import type { Database } from 'better-sqlite3';
import { vecToBlob } from './docs.js';
import type { Learning, StoredLearning } from './types.js';

export function insertLearning(
  db: Database,
  learning: Learning,
  embedding: number[],
): number {
  const skipVec = embedding.length === 0;
  const tx = db.transaction((l: Learning, e: number[]) => {
    const info = db
      .prepare(
        `INSERT INTO learnings (kind, context, problem, solution, source_agent)
         VALUES (@kind, @context, @problem, @solution, @sourceAgent)`,
      )
      .run({
        kind: l.kind,
        context: l.context ? JSON.stringify(l.context) : null,
        problem: l.problem,
        solution: l.solution,
        sourceAgent: l.sourceAgent,
      });
    const id = BigInt(info.lastInsertRowid);
    if (!skipVec) {
      db.prepare('INSERT INTO learnings_vec (rowid, embedding) VALUES (?, ?)').run(
        id,
        vecToBlob(e),
      );
    }
    return Number(id);
  });
  return tx(learning, embedding);
}

export function validateLearning(db: Database, id: number): void {
  db.prepare('UPDATE learnings SET validated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

/**
 * Search learnings by semantic similarity (when embeddings are available)
 * OR by keyword fallback (when running in BM25/Null mode).
 *
 * The keyword fallback is much rougher than vector search — it just does
 * SQL LIKE on problem+solution. Without embeddings there's no other choice
 * at the schema level. queryText is therefore preferred when no embedding.
 */
export function searchLearnings(
  db: Database,
  queryEmbedding: number[],
  opts: { limit?: number; kind?: string; onlyValidated?: boolean; queryText?: string } = {},
): StoredLearning[] {
  const limit = opts.limit ?? 5;
  const hasEmbedding = queryEmbedding.length > 0;

  if (hasEmbedding) {
    return vectorLearningSearch(db, queryEmbedding, opts);
  }
  return keywordLearningSearch(db, opts.queryText ?? '', opts);
}

function vectorLearningSearch(
  db: Database,
  queryEmbedding: number[],
  opts: { limit?: number; kind?: string; onlyValidated?: boolean },
): StoredLearning[] {
  const limit = opts.limit ?? 5;
  const blob = vecToBlob(queryEmbedding);

  const filters: string[] = [];
  if (opts.kind) filters.push('l.kind = ?');
  if (opts.onlyValidated) filters.push('l.validated_at IS NOT NULL');
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const params: unknown[] = [blob, limit * 3];
  if (opts.kind) params.push(opts.kind);
  params.push(limit);

  const sql = `
    WITH vec_hits AS (
      SELECT rowid, distance FROM learnings_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    )
    SELECT l.*, v.distance AS distance
    FROM vec_hits v
    JOIN learnings l ON l.id = v.rowid
    ${where}
    ORDER BY v.distance
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToLearning);
}

function keywordLearningSearch(
  db: Database,
  queryText: string,
  opts: { limit?: number; kind?: string; onlyValidated?: boolean },
): StoredLearning[] {
  const limit = opts.limit ?? 5;
  const filters: string[] = [];
  const params: unknown[] = [];

  // Build a LIKE clause per word for relevance; OR them together.
  const words = queryText
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 6); // cap to avoid SQL explosion
  if (words.length > 0) {
    const likes = words.map(() => '(LOWER(problem) LIKE ? OR LOWER(solution) LIKE ?)');
    filters.push(`(${likes.join(' OR ')})`);
    for (const w of words) {
      const pat = `%${w.toLowerCase()}%`;
      params.push(pat, pat);
    }
  }
  if (opts.kind) {
    filters.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.onlyValidated) filters.push('validated_at IS NOT NULL');

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  // Without semantic scoring, order by most recent.
  const sql = `SELECT * FROM learnings ${where} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToLearning);
}

function rowToLearning(row: Record<string, unknown>): StoredLearning {
  return {
    id: row.id as number,
    kind: row.kind as StoredLearning['kind'],
    context: row.context ? JSON.parse(row.context as string) : undefined,
    problem: row.problem as string,
    solution: row.solution as string,
    validatedAt: (row.validated_at as string) ?? null,
    sourceAgent: row.source_agent as StoredLearning['sourceAgent'],
    createdAt: row.created_at as string,
  };
}
