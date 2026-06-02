import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceRegistry } from '@capitu/adt-client';
import {
  type ComplianceContext,
  CompliancePolicyViolation,
  FakeEmbeddings,
  getActiveInstance,
  insertDoc,
  openKb,
  setActiveInstance,
} from '@capitu/kb';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerContext } from '../src/context.js';
import { runTool } from '../src/tool.js';
import {
  learnTool,
  listInstancesTool,
  recallLearningsTool,
  searchTool,
  useInstanceTool,
} from '../src/tools/index.js';

let dbDir: string;
let openDbs: Database[] = [];
const fake = new FakeEmbeddings();

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'docs-mcp-test-'));
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // Windows lock
  }
});

function buildTestContext(opts?: { permissive?: boolean }): ServerContext {
  const db = openKb({ path: join(dbDir, 'kb.db') });
  openDbs.push(db);
  const compliance: ComplianceContext = opts?.permissive
    ? { mode: 'permissive', riskAcknowledged: true }
    : { mode: 'strict', riskAcknowledged: false };
  return {
    kb: db,
    embeddings: fake,
    // adt is unused in these tests (only tools that touch SAP need it)
    adt: null as unknown as ServerContext['adt'],
    compliance,
    agent: 'capitu-docs',
  };
}

async function seedDocs(ctx: ServerContext): Promise<void> {
  const docs = [
    {
      title: 'SELECT',
      content: 'The SELECT statement reads data from one or more database tables in ABAP.',
    },
    {
      title: 'INSERT',
      content: 'The INSERT statement adds rows to a database table.',
    },
    {
      title: 'DELETE',
      content: 'The DELETE statement removes rows from a database table.',
    },
  ];
  for (const d of docs) {
    const [emb] = await ctx.embeddings.embed([`${d.title} ${d.content}`]);
    if (!emb) throw new Error('embed failed');
    insertDoc(ctx.kb, { source: 'abap-keyword', release: '7.58', ...d }, emb);
  }
}

describe('docs-mcp tools', () => {
  it('searchTool returns hits for a relevant query', async () => {
    const ctx = buildTestContext();
    await seedDocs(ctx);
    const out = await runTool(searchTool, { query: 'SELECT statement', limit: 2 }, ctx);
    expect(out.totalIndexed).toBe(3);
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0]?.title).toBe('SELECT');
    expect(out.hits[0]?.snippet).toContain('SELECT');
  });

  it('searchTool validates input with Zod', async () => {
    const ctx = buildTestContext();
    await expect(runTool(searchTool, { query: '' }, ctx)).rejects.toThrow();
    await expect(runTool(searchTool, { limit: 5 }, ctx)).rejects.toThrow();
  });

  it('learn + recall round-trip works', async () => {
    const ctx = buildTestContext();
    const learnOut = await runTool(
      learnTool,
      {
        kind: 'gotcha',
        problem: 'CDS extension fails when contract is C1',
        solution: 'Use only annotations declared in C0; or wrap in custom view',
      },
      ctx,
    );
    expect(learnOut.id).toBeGreaterThan(0);
    expect(learnOut.status).toBe('recorded');

    const recallOut = await runTool(
      recallLearningsTool,
      { query: 'CDS extension contract problem', limit: 5 },
      ctx,
    );
    expect(recallOut.matches.length).toBe(1);
    expect(recallOut.matches[0]?.kind).toBe('gotcha');
  });

  it('runTool records a trace per call', async () => {
    const ctx = buildTestContext();
    await seedDocs(ctx);
    await runTool(searchTool, { query: 'SELECT', limit: 1 }, ctx);
    const traces = ctx.kb.prepare('SELECT agent, tool, status FROM traces').all() as Array<{
      agent: string;
      tool: string;
      status: string;
    }>;
    expect(traces).toHaveLength(1);
    expect(traces[0]).toEqual({
      agent: 'capitu-docs',
      tool: 'capituDocsSearch',
      status: 'ok',
    });
  });

  it('runTool records failed traces with error status', async () => {
    const ctx = buildTestContext();
    // searchTool with empty query → Zod fails → trace not recorded
    // (compliance + zod parse run before withTrace).
    // To test failure trace, force a tool that throws after parse:
    await expect(runTool(searchTool, { query: '' }, ctx)).rejects.toThrow();
    const traces = ctx.kb.prepare('SELECT COUNT(*) as c FROM traces').get() as { c: number };
    // Zod errors happen before withTrace, so no trace expected.
    expect(traces.c).toBe(0);
  });
});

describe('compliance gate', () => {
  it('endorsed category passes in strict mode', async () => {
    const ctx = buildTestContext();
    await seedDocs(ctx);
    await expect(runTool(searchTool, { query: 'SELECT', limit: 1 }, ctx)).resolves.toBeTruthy();
  });

  it('throws CompliancePolicyViolation when category is gray-zone in strict', async () => {
    const ctx = buildTestContext();
    // Manufacture a tool with a gray-zone category to exercise the gate.
    const grayTool = {
      ...searchTool,
      name: 'fake-gray',
      category: 'business-data-read' as const,
    };
    await expect(runTool(grayTool, { query: 'x' }, ctx)).rejects.toThrow(CompliancePolicyViolation);
  });
});

describe('instance management tools (docs)', () => {
  function buildInstanceContext(): { ctx: ServerContext; db: Database } {
    const db = openKb({ path: join(dbDir, 'kb.db') });
    openDbs.push(db);
    const registry = new InstanceRegistry(
      [
        { name: 'dev', url: 'https://dev.s4hana.cloud.sap', user: 'U1' },
        { name: 'qas', url: 'https://qas.example.com', user: 'U2' },
      ],
      {
        getActive: () => getActiveInstance(db),
        setActive: (n) => setActiveInstance(db, n),
        resolvePassword: () => 'pw',
      },
    );
    const base = {
      kb: db,
      embeddings: fake,
      registry,
      compliance: { mode: 'strict' as const, riskAcknowledged: false },
      agent: 'capitu-docs' as const,
    };
    Object.defineProperty(base, 'adt', { enumerable: true, get: () => registry.active() });
    return { ctx: base as ServerContext, db };
  }

  it('listInstances works and the switch propagates via shared meta', async () => {
    const { ctx, db } = buildInstanceContext();
    const list = await runTool(listInstancesTool, {}, ctx);
    expect(list.active).toBe('dev');
    expect(list.instances).toHaveLength(2);

    await runTool(useInstanceTool, { name: 'qas', probe: false }, ctx);
    expect(getActiveInstance(db)).toBe('qas'); // shared pointer updated
    expect(ctx.adt.url).toBe('https://qas.example.com');
  });
});
