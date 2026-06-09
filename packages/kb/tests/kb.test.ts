import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeEmbeddings,
  countDocs,
  insertDoc,
  insertLearning,
  listCatalog,
  openKb,
  recordTrace,
  searchDocs,
  searchLearnings,
  upsertCatalog,
} from '../src/index.js';

let dbDir: string;
let dbPath: string;
let openDbs: Database[] = [];
const fake = new FakeEmbeddings();

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'capitu-kb-test-'));
  dbPath = join(dbDir, 'kb.db');
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  openDbs = [];
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // Windows sometimes holds locks briefly; ignore — temp dir will be cleaned by OS
  }
});

function open(): Database {
  const db = openKb({ path: dbPath });
  openDbs.push(db);
  return db;
}

async function embed(text: string): Promise<number[]> {
  const [v] = await fake.embed([text]);
  if (!v) throw new Error('embed returned empty');
  return v;
}

describe('kb', () => {
  it('opens db and creates schema', () => {
    const db = open();
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    expect(row).toBeDefined();
    db.close();
  });

  it('inserts and retrieves docs', async () => {
    const db = open();
    const emb = await embed('ABAP SELECT statement');
    const id = insertDoc(
      db,
      {
        source: 'abap-keyword',
        release: '7.58',
        title: 'SELECT',
        content: 'The SELECT statement reads data from a database table.',
      },
      emb,
    );
    expect(id).toBeGreaterThan(0);
    expect(countDocs(db)).toBe(1);
    expect(countDocs(db, 'abap-keyword')).toBe(1);
    db.close();
  });

  it('hybrid search returns relevant docs', async () => {
    const db = open();
    const docs = [
      { title: 'SELECT', content: 'ABAP SELECT statement reads data.' },
      { title: 'INSERT', content: 'ABAP INSERT writes a row.' },
      { title: 'DELETE', content: 'ABAP DELETE removes rows.' },
    ];
    for (const d of docs) {
      const e = await embed(`${d.title} ${d.content}`);
      insertDoc(db, { source: 'abap-keyword', release: '7.58', ...d }, e);
    }
    const q = await embed('SELECT statement');
    const hits = searchDocs(db, 'SELECT statement', q, { limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.title).toBe('SELECT');
    db.close();
  });

  it('learnings are stored and searchable', async () => {
    const db = open();
    const emb = await embed('CDS extension fails on contract C1');
    insertLearning(
      db,
      {
        kind: 'gotcha',
        problem: 'Extending CDS view I_BusinessPartner fails with C1 contract',
        solution: 'Use only extension annotations explicitly declared in C0.',
        sourceAgent: 'capitu-dev',
      },
      emb,
    );
    const q = await embed('CDS extension contract problem');
    const hits = searchLearnings(db, q);
    expect(hits.length).toBe(1);
    expect(hits[0]?.kind).toBe('gotcha');
    db.close();
  });

  it('tenant catalog upsert is idempotent', () => {
    const db = open();
    upsertCatalog(db, [{ type: 'released_api', name: 'I_BusinessPartner', releaseContract: 'C1' }]);
    upsertCatalog(db, [{ type: 'released_api', name: 'I_BusinessPartner', releaseContract: 'C2' }]);
    const all = listCatalog(db, 'released_api');
    expect(all).toHaveLength(1);
    expect(all[0]?.releaseContract).toBe('C2');
    db.close();
  });

  it('traces are recorded', () => {
    const db = open();
    recordTrace(db, {
      agent: 'capitu-docs',
      tool: 'search',
      input: { query: 'select' },
      output: { hits: 3 },
      durationMs: 42,
      status: 'ok',
    });
    const row = db.prepare('SELECT COUNT(*) AS c FROM traces').get() as { c: number };
    expect(row.c).toBe(1);
    db.close();
  });

  it('BM25-only mode: insertDoc with empty embedding skips vec', async () => {
    const db = open();
    const id = insertDoc(
      db,
      {
        source: 'abap-keyword',
        title: 'SELECT',
        content: 'ABAP SELECT reads data from tables.',
      },
      [], // empty embedding = NullEmbeddings mode
    );
    expect(id).toBeGreaterThan(0);
    // docs row exists
    const docCount = (db.prepare('SELECT COUNT(*) AS c FROM docs').get() as { c: number }).c;
    expect(docCount).toBe(1);
    // docs_vec has nothing
    const vecCount = (db.prepare('SELECT COUNT(*) AS c FROM docs_vec').get() as { c: number }).c;
    expect(vecCount).toBe(0);
    // FTS still has it — keyword search must work
    const hits = searchDocs(db, 'SELECT', [], { limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0]?.title).toBe('SELECT');
    db.close();
  });

  it('BM25-only mode: insertLearning + searchLearnings fallback via queryText', async () => {
    const db = open();
    insertLearning(
      db,
      {
        kind: 'gotcha',
        problem: 'CDS view fails to activate with wrong annotation',
        solution: 'check syntax with capituDevSyntaxCheck before activate',
        sourceAgent: 'capitu-dev',
      },
      [], // empty = no vector
    );
    // recall via keyword query
    const hits = searchLearnings(db, [], { queryText: 'CDS annotation fails' });
    expect(hits.length).toBe(1);
    expect(hits[0]?.kind).toBe('gotcha');
    db.close();
  });

  it('BM25-only recall ranks by relevance, not recency (FTS5)', async () => {
    const db = open();
    // Most relevant to "transport" is inserted FIRST; two unrelated learnings
    // are inserted AFTER. A recency-ordered search would return the last one;
    // FTS5/BM25 must return the transport one on top.
    insertLearning(
      db,
      {
        kind: 'error-fix',
        problem: 'transport request locked when releasing transport task',
        solution: 'release the sub-task transport before the request transport',
        sourceAgent: 'capitu-dev',
      },
      [],
    );
    insertLearning(
      db,
      {
        kind: 'pattern',
        problem: 'naming convention for projection views',
        solution: 'ZP_ prefix matching ZC_',
        sourceAgent: 'capitu-spec',
      },
      [],
    );
    insertLearning(
      db,
      {
        kind: 'gotcha',
        problem: 'class activation needs the include written first',
        solution: 'write main before includes',
        sourceAgent: 'capitu-dev',
      },
      [],
    );
    const hits = searchLearnings(db, [], { queryText: 'transport', limit: 3 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.problem).toMatch(/transport/i); // relevance wins over recency
    db.close();
  });

  it('BM25-only recall tolerates punctuation/quotes in the query (no FTS syntax error)', async () => {
    const db = open();
    insertLearning(
      db,
      {
        kind: 'gotcha',
        problem: 'read_entities( ) must be called inside the handler',
        solution: 'use the correct RAP handler signature',
        sourceAgent: 'capitu-dev',
      },
      [],
    );
    // A raw query with parens/quotes would break a naive FTS MATCH — must not throw.
    const hits = searchLearnings(db, [], { queryText: 'read_entities( "handler"' });
    expect(hits.length).toBe(1);
    db.close();
  });
});
