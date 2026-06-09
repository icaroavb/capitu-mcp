import type { Database } from 'better-sqlite3';
import { vecToBlob } from './docs.js';
import type { Learning, StoredLearning } from './types.js';

export function insertLearning(db: Database, learning: Learning, embedding: number[]): number {
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
    // Always index in FTS5 so bm25-mode recall ranks by relevance (not recency).
    db.prepare('INSERT INTO learnings_fts (rowid, problem, solution) VALUES (?, ?, ?)').run(
      id,
      l.problem,
      l.solution,
    );
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
  // opts.limit flows through to vectorLearningSearch / keywordLearningSearch
  // — each applies its own default. No need to materialize here.
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

/**
 * Keyword recall for bm25 mode. Primary path: FTS5 MATCH over learnings_fts
 * ranked by BM25 (relevance, not recency). Falls back to LIKE when the query
 * is empty or not valid FTS5 syntax (stray quotes, operators).
 */
function keywordLearningSearch(
  db: Database,
  queryText: string,
  opts: { limit?: number; kind?: string; onlyValidated?: boolean },
): StoredLearning[] {
  const limit = opts.limit ?? 5;

  // Build a tolerant FTS query: keep word-ish tokens, OR them. Dropping FTS
  // operators/punctuation avoids "fts5: syntax error" on free-text input.
  const tokens = queryText
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_*]/gu, '').trim())
    .filter((w) => w.length >= 2)
    .slice(0, 8);

  if (tokens.length > 0) {
    const matchExpr = tokens.join(' OR ');
    const filters: string[] = ['learnings_fts MATCH ?'];
    const params: unknown[] = [matchExpr];
    if (opts.kind) {
      filters.push('l.kind = ?');
      params.push(opts.kind);
    }
    if (opts.onlyValidated) filters.push('l.validated_at IS NOT NULL');
    params.push(limit);
    const sql = `
      SELECT l.* FROM learnings_fts f
      JOIN learnings l ON l.id = f.rowid
      WHERE ${filters.join(' AND ')}
      ORDER BY f.rank
      LIMIT ?
    `;
    try {
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map(rowToLearning);
    } catch {
      // FTS parse error → fall through to LIKE.
    }
  }

  return likeLearningSearch(db, tokens, opts, limit);
}

/** Last-resort recall: LIKE over problem+solution, ordered by recency. */
function likeLearningSearch(
  db: Database,
  tokens: string[],
  opts: { kind?: string; onlyValidated?: boolean },
  limit: number,
): StoredLearning[] {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (tokens.length > 0) {
    const likes = tokens.map(() => '(LOWER(problem) LIKE ? OR LOWER(solution) LIKE ?)');
    filters.push(`(${likes.join(' OR ')})`);
    for (const w of tokens) {
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
