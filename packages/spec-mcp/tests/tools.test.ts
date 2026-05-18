import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbeddings, type ComplianceContext, openKb } from '@capitu/kb';
import type { CapituAdtClient } from '@capitu/adt-client';
import { type ServerContext } from '../src/context.js';
import { runTool } from '../src/tool.js';
import { specToMarkdown } from '../src/spec-model.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  applyTool,
  draftTool,
  exportDocxTool,
  exportProposalTool,
  impactTool,
  learnTool,
  listOutputsTool,
  listProposalsTool,
  proposeTool,
  recallTool,
  validateTool,
} from '../src/tools/index.js';

let dbDir: string;
let openDbs: Database[] = [];
const fake = new FakeEmbeddings();

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'spec-mcp-test-'));
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    /* windows lock */
  }
});

function buildTestContext(opts?: {
  adtMock?: Partial<CapituAdtClient>;
}): ServerContext {
  const db = openKb({ path: join(dbDir, 'kb.db') });
  openDbs.push(db);
  const compliance: ComplianceContext = { mode: 'strict', riskAcknowledged: false };
  return {
    kb: db,
    embeddings: fake,
    adt: (opts?.adtMock ?? {}) as CapituAdtClient,
    compliance,
    agent: 'capitu-spec',
  };
}

describe('specToMarkdown', () => {
  it('renders core sections', () => {
    const md = specToMarkdown({
      title: 'Flight booking',
      requirement: 'allow customers to book a flight',
      approach: 'RAP managed scenario over /dmo/flight, expose OData v4',
      targetPackage: '$TMP',
      namespace: 'Z',
      artifacts: [
        {
          kind: 'cds-interface',
          name: 'ZI_BOOKING',
          description: 'Booking interface view',
          basedOn: '/dmo/booking',
        },
      ],
    });
    expect(md).toContain('# Flight booking');
    expect(md).toContain('## Approach');
    expect(md).toContain('ZI_BOOKING');
    expect(md).toContain('/dmo/booking');
  });
});

describe('draftTool', () => {
  it('normalizes names with namespace prefix and emits markdown', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      draftTool,
      {
        title: 'Test',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          {
            kind: 'cds-interface',
            name: 'BOOKING', // missing Z prefix
            description: 'view',
          },
        ],
      },
      ctx,
    );
    expect(out.markdown).toContain('Z_BOOKING'); // normalized
    expect(out.artifactCount).toBe(1);
    expect(out.warnings.some((w) => w.includes('namespace'))).toBe(true);
  });

  it('warns when behavior definition has no implementation', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      draftTool,
      {
        title: 'X',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          {
            kind: 'behavior-definition',
            name: 'ZI_FLIGHT',
            description: 'BDEF',
          },
        ],
      },
      ctx,
    );
    expect(out.warnings.some((w) => w.includes('behavior implementation'))).toBe(true);
  });

  it('adds transport consideration by default', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      draftTool,
      {
        title: 'X',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          { kind: 'cds-interface', name: 'ZI_X', description: 'x' },
        ],
      },
      ctx,
    );
    expect(out.markdown).toContain('Transport');
  });

  it('warns about /dmo/* usage in data-quality consideration', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      draftTool,
      {
        title: 'X',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          {
            kind: 'cds-interface',
            name: 'ZI_X',
            description: 'x',
            basedOn: '/dmo/flight',
          },
        ],
      },
      ctx,
    );
    expect(out.markdown).toContain('/dmo/*');
  });

  it('produces implementation steps in correct order', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      draftTool,
      {
        title: 'X',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          { kind: 'service-binding', name: 'ZSB_X', description: 'sb' },
          { kind: 'cds-interface', name: 'ZI_X', description: 'i' },
          { kind: 'cds-projection', name: 'ZP_X', description: 'p' },
          { kind: 'service-definition', name: 'ZSD_X', description: 'sd' },
        ],
      },
      ctx,
    );
    // CDS interface should come before projection, projection before SRVD, SRVD before SRVB
    const md = out.markdown;
    expect(md.indexOf('ZI_X')).toBeLessThan(md.indexOf('ZP_X'));
    // Steps section listed in order
    expect(md).toContain('## Implementation order');
  });
});

describe('validateTool', () => {
  it('flags name collision when search finds exact match', async () => {
    const ctx = buildTestContext({
      adtMock: {
        listPackage: vi.fn().mockResolvedValue({ objects: [], categories: [] }),
        search: vi.fn().mockResolvedValue([
          {
            uri: '/sap/bc/adt/oo/classes/zcl_existing',
            type: 'CLAS/OC',
            name: 'ZCL_EXISTING',
            packageName: 'ZSANDBOX_PKG',
          },
        ]),
      },
    });
    const out = await runTool(
      validateTool,
      {
        targetPackage: 'ZSANDBOX_PKG',
        artifacts: [{ kind: 'class', name: 'ZCL_EXISTING' }],
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.findings.some((f) => f.severity === 'error' && f.message.includes('collision'))).toBe(true);
  });

  it('reports package not found as error', async () => {
    const ctx = buildTestContext({
      adtMock: {
        listPackage: vi.fn().mockRejectedValue(new Error('Package not found')),
        search: vi.fn().mockResolvedValue([]),
      },
    });
    const out = await runTool(
      validateTool,
      {
        targetPackage: 'INVALID_PKG',
        artifacts: [{ kind: 'class', name: 'ZCL_X' }],
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.packageExists).toBe(false);
  });

  it('passes when no collisions and package exists', async () => {
    const ctx = buildTestContext({
      adtMock: {
        listPackage: vi.fn().mockResolvedValue({ objects: [], categories: [] }),
        search: vi.fn().mockResolvedValue([]),
      },
    });
    const out = await runTool(
      validateTool,
      {
        targetPackage: '$TMP',
        artifacts: [{ kind: 'cds-interface', name: 'ZI_NEW' }],
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.packageExists).toBe(true);
  });
});

describe('impactTool', () => {
  it('classifies isolated when no consumers', async () => {
    const ctx = buildTestContext({
      adtMock: {
        findReferences: vi.fn().mockResolvedValue([]),
      },
    });
    const out = await runTool(
      impactTool,
      { uri: '/sap/bc/adt/oo/classes/zcl_lonely' },
      ctx,
    );
    expect(out.riskTier).toBe('isolated');
    expect(out.totalConsumers).toBe(0);
    expect(out.summary).toContain('Safe to rename');
  });

  it('classifies high risk above 10 consumers', async () => {
    const refs = Array.from({ length: 15 }, (_, i) => ({
      uri: `/x/${i}`,
      type: 'CLAS/OC',
      name: `Z_USER_${i}`,
      packageName: 'ZSANDBOX_PKG',
    }));
    const ctx = buildTestContext({
      adtMock: { findReferences: vi.fn().mockResolvedValue(refs) },
    });
    const out = await runTool(
      impactTool,
      { uri: '/x' },
      ctx,
    );
    expect(out.riskTier).toBe('high');
    expect(out.totalConsumers).toBe(15);
    expect(out.byType.CLAS).toBe(15);
  });

  it('classifies medium between 4 and 10', async () => {
    const refs = Array.from({ length: 5 }, (_, i) => ({
      uri: `/x/${i}`,
      type: 'DDLS/DF',
      name: `ZI_${i}`,
    }));
    const ctx = buildTestContext({
      adtMock: { findReferences: vi.fn().mockResolvedValue(refs) },
    });
    const out = await runTool(impactTool, { uri: '/x' }, ctx);
    expect(out.riskTier).toBe('medium');
  });
});

describe('proposal flow (propose + apply)', () => {
  it('propose returns a token and persists pending proposal', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      proposeTool,
      {
        title: 'Test proposal',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          {
            kind: 'cds-interface',
            name: 'ZI_PROP_TEST',
            description: 'test',
            basedOn: '/dmo/carrier',
            exposes: ['CarrierId', 'Name'],
          },
        ],
      },
      ctx,
    );
    expect(out.status).toBe('pending');
    expect(out.token).toMatch(/^[0-9a-f]{8}-/);
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0]?.source).toContain('@AbapCatalog');
    expect(out.artifacts[0]?.source).toContain('ZI_PROP_TEST');
    expect(out.blockingErrors).toEqual([]);
    expect(out.executionOrder).toEqual(['ZI_PROP_TEST']);

    // listProposals should show it
    const list = await runTool(listProposalsTool, { status: 'pending' }, ctx);
    expect(list.total).toBe(1);
    expect(list.proposals[0]?.token).toBe(out.token);
  });

  it('propose detects name collisions across different kinds', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      proposeTool,
      {
        title: 'Collision',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          { kind: 'cds-interface', name: 'ZI_SAME', description: 'a' },
          { kind: 'cds-projection', name: 'ZI_SAME', description: 'b' },
        ],
      },
      ctx,
    );
    expect(out.blockingErrors.length).toBeGreaterThan(0);
    expect(out.blockingErrors[0]).toContain('Name collision');
  });

  it('propose allows BDEF + root view sharing the same name (RAP convention)', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      proposeTool,
      {
        title: 'RAP root',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          { kind: 'cds-interface', name: 'ZI_ROOT', description: 'root view' },
          { kind: 'behavior-definition', name: 'ZI_ROOT', description: 'BDEF' },
        ],
      },
      ctx,
    );
    expect(out.blockingErrors).toEqual([]);
  });

  it('apply with confirmed=false marks proposal cancelled and writes nothing', async () => {
    const ctx = buildTestContext({
      adtMock: {
        // None of these should be called
        createObject: vi.fn(),
        lock: vi.fn(),
        writeSource: vi.fn(),
        activate: vi.fn(),
      },
    });
    const propose = await runTool(
      proposeTool,
      {
        title: 'Will cancel',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          { kind: 'cds-interface', name: 'ZI_NEVER', description: 'x', basedOn: '/dmo/x' },
        ],
      },
      ctx,
    );
    const apply = await runTool(
      applyTool,
      { token: propose.token, confirmed: false },
      ctx,
    );
    expect(apply.status).toBe('cancelled');
    expect(apply.applied).toBe(0);
    expect((ctx.adt.createObject as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('apply rejects unknown token', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      applyTool,
      { token: '00000000-0000-0000-0000-000000000000', confirmed: true },
      ctx,
    );
    expect(out.status).toBe('rejected');
    expect(out.summary).toContain('not found');
  });

  it('apply rejects already-applied proposal', async () => {
    const ctx = buildTestContext({
      adtMock: {
        createObject: vi.fn().mockResolvedValue(undefined),
        lock: vi.fn().mockResolvedValue({ uri: '/x', lockHandle: 'H' }),
        writeSource: vi.fn().mockResolvedValue(undefined),
        unlock: vi.fn().mockResolvedValue(undefined),
        activate: vi.fn().mockResolvedValue({ success: true, inactiveObjects: 0, messages: [] }),
      },
    });
    const propose = await runTool(
      proposeTool,
      {
        title: 'Once',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          { kind: 'cds-interface', name: 'ZI_ONCE', description: 'x', basedOn: '/dmo/x' },
        ],
      },
      ctx,
    );
    const first = await runTool(
      applyTool,
      { token: propose.token, confirmed: true },
      ctx,
    );
    expect(first.status).toBe('applied');
    const second = await runTool(
      applyTool,
      { token: propose.token, confirmed: true },
      ctx,
    );
    expect(second.status).toBe('rejected');
  });

  it('apply happy path: executes create→write→activate for each artifact', async () => {
    const calls: string[] = [];
    const ctx = buildTestContext({
      adtMock: {
        createObject: vi.fn(async (opts) => {
          calls.push(`create:${opts.name}`);
        }),
        lock: vi.fn(async (uri) => {
          calls.push(`lock:${uri}`);
          return { uri, lockHandle: 'H' };
        }),
        writeSource: vi.fn(async (uri) => {
          calls.push(`write:${uri}`);
        }),
        unlock: vi.fn(async (uri) => {
          calls.push(`unlock:${uri}`);
        }),
        activate: vi.fn(async (name) => {
          calls.push(`activate:${name}`);
          return { success: true, inactiveObjects: 0, messages: [] };
        }),
      },
    });
    const propose = await runTool(
      proposeTool,
      {
        title: 'Two CDS',
        requirement: 'r',
        approach: 'a',
        targetPackage: '$TMP',
        namespace: 'Z',
        artifacts: [
          {
            kind: 'cds-interface',
            name: 'ZI_TWO',
            description: 'i',
            basedOn: '/dmo/carrier',
            exposes: ['CarrierId'],
          },
          {
            kind: 'cds-projection',
            name: 'ZP_TWO',
            description: 'p',
            basedOn: 'ZI_TWO',
            exposes: ['CarrierId'],
          },
        ],
      },
      ctx,
    );
    const apply = await runTool(
      applyTool,
      { token: propose.token, confirmed: true },
      ctx,
    );
    expect(apply.status).toBe('applied');
    expect(apply.applied).toBe(2);
    // Order: ZI_TWO before ZP_TWO
    const ziCreateIdx = calls.indexOf('create:ZI_TWO');
    const zpCreateIdx = calls.indexOf('create:ZP_TWO');
    expect(ziCreateIdx).toBeGreaterThanOrEqual(0);
    expect(zpCreateIdx).toBeGreaterThan(ziCreateIdx);
  });
});

describe('export tools', () => {
  it('exportDocxTool writes a docx into the configured CAPITU_OUTPUT_DIR', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'spec-export-test-'));
    const previous = process.env.CAPITU_OUTPUT_DIR;
    process.env.CAPITU_OUTPUT_DIR = tmpDir;
    try {
      const ctx = buildTestContext();
      const out = await runTool(
        exportDocxTool,
        {
          title: 'Export Test',
          markdown: '# Hello\n\nWorld',
          category: 'analysis',
          format: 'docx',
        },
        ctx,
      );
      expect(existsSync(out.path)).toBe(true);
      expect(out.category).toBe('analysis');
      expect(out.format).toBe('docx');
      expect(out.bytes).toBeGreaterThan(0);
    } finally {
      if (previous !== undefined) process.env.CAPITU_OUTPUT_DIR = previous;
      else delete process.env.CAPITU_OUTPUT_DIR;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
    }
  });

  it('listOutputsTool returns empty when no exports yet', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'spec-listout-test-'));
    const previous = process.env.CAPITU_OUTPUT_DIR;
    process.env.CAPITU_OUTPUT_DIR = tmpDir;
    try {
      const ctx = buildTestContext();
      const out = await runTool(listOutputsTool, { category: 'all' }, ctx);
      expect(out.total).toBe(0);
      expect(out.files).toEqual([]);
    } finally {
      if (previous !== undefined) process.env.CAPITU_OUTPUT_DIR = previous;
      else delete process.env.CAPITU_OUTPUT_DIR;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
    }
  });

  it('exportProposalTool throws for missing token', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'spec-exportprop-test-'));
    const previous = process.env.CAPITU_OUTPUT_DIR;
    process.env.CAPITU_OUTPUT_DIR = tmpDir;
    try {
      const ctx = buildTestContext();
      await expect(
        runTool(
          exportProposalTool,
          { token: '00000000-0000-0000-0000-000000000000', format: 'docx' },
          ctx,
        ),
      ).rejects.toThrow(/not found/);
    } finally {
      if (previous !== undefined) process.env.CAPITU_OUTPUT_DIR = previous;
      else delete process.env.CAPITU_OUTPUT_DIR;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
    }
  });
});

describe('cross-agent learnings (spec)', () => {
  it('learn records with sourceAgent=capitu-spec', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      learnTool,
      {
        kind: 'decision',
        problem: 'Should we wrap /dmo/* in a Z CDS interface?',
        solution: 'Yes. /dmo/* is not released; always wrap in ZI_* before downstream consumption.',
      },
      ctx,
    );
    expect(out.id).toBeGreaterThan(0);
    const row = ctx.kb
      .prepare('SELECT source_agent FROM learnings WHERE id = ?')
      .get(out.id) as { source_agent: string };
    expect(row.source_agent).toBe('capitu-spec');
  });

  it('recall finds spec-originated learnings', async () => {
    const ctx = buildTestContext();
    await runTool(
      learnTool,
      {
        kind: 'pattern',
        problem: 'Naming convention for projection CDS',
        solution: 'Always ZP_<entity> matching ZC_<entity>',
      },
      ctx,
    );
    const out = await runTool(
      recallTool,
      { query: 'naming convention projection' },
      ctx,
    );
    expect(out.matches.length).toBe(1);
    expect(out.matches[0]?.sourceAgent).toBe('capitu-spec');
  });
});
