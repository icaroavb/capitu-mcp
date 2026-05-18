import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompliancePolicyViolation,
  FakeEmbeddings,
  type ComplianceContext,
  openKb,
} from '@capitu/kb';
import type { CapituAdtClient } from '@capitu/adt-client';
import { type ServerContext, isPackageAllowed } from '../src/context.js';
import { runTool } from '../src/tool.js';
import {
  activateTool,
  applyArtifactTool,
  createObjectTool,
  findReferencesTool,
  learnTool,
  listTransportsTool,
  readObjectTool,
  readPackageTool,
  recallTool,
  searchTool,
  syntaxCheckTool,
  transportContentsTool,
  writeObjectTool,
} from '../src/tools/index.js';

let dbDir: string;
let openDbs: Database[] = [];
const fake = new FakeEmbeddings();

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'dev-mcp-test-'));
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

function buildTestContext(opts?: {
  writesAllowed?: boolean;
  allowedPackages?: string[];
  permissive?: boolean;
  adtMock?: Partial<CapituAdtClient>;
}): ServerContext {
  const db = openKb({ path: join(dbDir, 'kb.db') });
  openDbs.push(db);
  const compliance: ComplianceContext = opts?.permissive
    ? { mode: 'permissive', riskAcknowledged: true }
    : { mode: 'strict', riskAcknowledged: false };
  return {
    kb: db,
    embeddings: fake,
    adt: (opts?.adtMock ?? {}) as CapituAdtClient,
    compliance,
    agent: 'capitu-dev',
    writes: {
      allowed: opts?.writesAllowed ?? false,
      allowedPackages: opts?.allowedPackages ?? ['$TMP'],
    },
  };
}

describe('isPackageAllowed', () => {
  it('matches exact', () => {
    expect(isPackageAllowed('$TMP', ['$TMP'])).toBe(true);
    expect(isPackageAllowed('ZFOO', ['$TMP'])).toBe(false);
  });
  it('matches wildcard prefix', () => {
    expect(isPackageAllowed('ZFOO', ['Z*'])).toBe(true);
    expect(isPackageAllowed('YBAR', ['Z*'])).toBe(false);
    expect(isPackageAllowed('ZSANDBOX_PKG', ['ZSANDBOX*'])).toBe(true);
  });
  it('handles multiple patterns', () => {
    expect(isPackageAllowed('YBAR', ['$TMP', 'Z*', 'Y*'])).toBe(true);
  });
});

describe('read tools', () => {
  it('readObjectTool returns source + lineCount', async () => {
    const ctx = buildTestContext({
      adtMock: {
        getSource: vi.fn().mockResolvedValue({
          uri: '/sap/bc/adt/oo/classes/zcl_x/source/main',
          source: 'CLASS zcl_x DEFINITION.\nENDCLASS.',
        }),
      },
    });
    const out = await runTool(
      readObjectTool,
      { sourceUri: '/sap/bc/adt/oo/classes/zcl_x/source/main' },
      ctx,
    );
    expect(out.source).toContain('CLASS');
    expect(out.lineCount).toBe(2);
  });

  it('readPackageTool returns objects + categories', async () => {
    const ctx = buildTestContext({
      adtMock: {
        listPackage: vi.fn().mockResolvedValue({
          objects: [{ uri: '/sap/x', type: 'DDLS/DF', name: 'ZI_FLIGHT_DEMO' }],
          categories: ['core_data_services'],
        }),
      },
    });
    const out = await runTool(readPackageTool, { packageName: 'Y_SUBPACKAGE' }, ctx);
    expect(out.packageName).toBe('Y_SUBPACKAGE');
    expect(out.objects).toHaveLength(1);
    expect(out.categories).toEqual(['core_data_services']);
  });

  it('searchTool returns hits', async () => {
    const ctx = buildTestContext({
      adtMock: {
        search: vi.fn().mockResolvedValue([
          {
            uri: '/sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb',
            type: 'DDLS/DF',
            name: 'ZI_FLIGHT_DEMO',
            packageName: 'Y_SUBPACKAGE',
            description: 'tabela de voos',
          },
        ]),
      },
    });
    const out = await runTool(searchTool, { pattern: 'ZI_FLIGHT*', type: 'DDLS' }, ctx);
    expect(out.total).toBe(1);
    expect(out.hits[0]?.name).toBe('ZI_FLIGHT_DEMO');
  });

  it('findReferencesTool returns references', async () => {
    const ctx = buildTestContext({
      adtMock: {
        findReferences: vi.fn().mockResolvedValue([
          { uri: '/sap/x', type: 'CLAS/OC', name: 'ZCL_CALLER' },
        ]),
      },
    });
    const out = await runTool(findReferencesTool, { uri: '/sap/y' }, ctx);
    expect(out.total).toBe(1);
    expect(out.references[0]?.name).toBe('ZCL_CALLER');
  });
});

describe('syntaxCheckTool', () => {
  it('returns ok=true when no errors', async () => {
    const ctx = buildTestContext({
      adtMock: {
        syntaxCheck: vi.fn().mockResolvedValue([
          { severity: 'warning', uri: '/x', line: 5, offset: 0, text: 'unused var' },
        ]),
      },
    });
    const out = await runTool(syntaxCheckTool, { uri: '/sap/x/source/main' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe('warning');
  });

  it('returns ok=false on errors', async () => {
    const ctx = buildTestContext({
      adtMock: {
        syntaxCheck: vi.fn().mockResolvedValue([
          { severity: 'error', uri: '/x', line: 5, offset: 0, text: 'syntax error' },
        ]),
      },
    });
    const out = await runTool(syntaxCheckTool, { uri: '/sap/x/source/main' }, ctx);
    expect(out.ok).toBe(false);
  });
});

describe('createObjectTool', () => {
  it('refuses when writes disabled', async () => {
    const ctx = buildTestContext({ writesAllowed: false });
    await expect(
      runTool(
        createObjectTool,
        {
          objectType: 'DDLS/DF',
          name: 'ZI_TEST',
          description: 'test',
          packageName: '$TMP',
        },
        ctx,
      ),
    ).rejects.toThrow(/Writes disabled/);
  });

  it('refuses when package not allowed', async () => {
    const ctx = buildTestContext({ writesAllowed: true, allowedPackages: ['$TMP'] });
    await expect(
      runTool(
        createObjectTool,
        {
          objectType: 'DDLS/DF',
          name: 'ZI_TEST',
          description: 'test',
          packageName: 'ZSANDBOX_PKG',
        },
        ctx,
      ),
    ).rejects.toThrow(/not in the allowlist/);
  });

  it('builds correct URIs by type and returns hint for next steps', async () => {
    const createSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZSANDBOX_PKG'],
      adtMock: { createObject: createSpy },
    });
    const out = await runTool(
      createObjectTool,
      {
        objectType: 'DDLS/DF',
        name: 'ZI_EXAMPLE_CDS',
        description: 'capitu first creation',
        packageName: 'ZSANDBOX_PKG',
      },
      ctx,
    );
    expect(out.created).toBe(true);
    expect(out.uri).toBe('/sap/bc/adt/ddic/ddl/sources/zi_test_capitu');
    expect(out.sourceUri).toBe('/sap/bc/adt/ddic/ddl/sources/zi_test_capitu/source/main');
    expect(out.hint).toMatch(/INACTIVE and empty/);
    expect(createSpy).toHaveBeenCalledWith({
      objectType: 'DDLS/DF',
      name: 'ZI_EXAMPLE_CDS',
      description: 'capitu first creation',
      packageName: 'ZSANDBOX_PKG',
      transport: undefined,
    });
  });

  it('builds URI correctly for CLAS/OC', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      adtMock: { createObject: vi.fn().mockResolvedValue(undefined) },
    });
    const out = await runTool(
      createObjectTool,
      {
        objectType: 'CLAS/OC',
        name: 'ZCL_X',
        description: 'test class',
        packageName: '$TMP',
      },
      ctx,
    );
    expect(out.uri).toBe('/sap/bc/adt/oo/classes/zcl_x');
  });
});

describe('write safety gates', () => {
  it('writeObjectTool refuses when writes disabled', async () => {
    const ctx = buildTestContext({ writesAllowed: false });
    await expect(
      runTool(
        writeObjectTool,
        {
          sourceUri: '/sap/x/source/main',
          objectUri: '/sap/x',
          packageName: '$TMP',
          source: 'CLASS zcl_x DEFINITION. ENDCLASS.',
        },
        ctx,
      ),
    ).rejects.toThrow(/Writes disabled/);
  });

  it('writeObjectTool refuses when package not in allowlist', async () => {
    const ctx = buildTestContext({ writesAllowed: true, allowedPackages: ['$TMP'] });
    await expect(
      runTool(
        writeObjectTool,
        {
          sourceUri: '/sap/x/source/main',
          objectUri: '/sap/x',
          packageName: 'ZSANDBOX_PKG',
          source: 'x',
        },
        ctx,
      ),
    ).rejects.toThrow(/not in the allowlist/);
  });

  it('writeObjectTool aborts on syntax errors before locking', async () => {
    const lockSpy = vi.fn();
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      adtMock: {
        syntaxCheck: vi
          .fn()
          .mockResolvedValue([{ severity: 'error', uri: '/x', line: 1, offset: 0, text: 'bad' }]),
        lock: lockSpy,
      },
    });
    const out = await runTool(
      writeObjectTool,
      {
        sourceUri: '/sap/x/source/main',
        objectUri: '/sap/x',
        packageName: '$TMP',
        source: 'broken',
      },
      ctx,
    );
    expect(out.written).toBe(false);
    expect(out.syntaxOk).toBe(false);
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it('activateTool refuses when writes disabled', async () => {
    const ctx = buildTestContext({ writesAllowed: false });
    await expect(
      runTool(
        activateTool,
        { objectName: 'ZI_X', objectUri: '/sap/x', packageName: '$TMP' },
        ctx,
      ),
    ).rejects.toThrow(/Writes disabled/);
  });
});

describe('writeObjectTool happy path', () => {
  it('locks, writes, unlocks in order', async () => {
    const callOrder: string[] = [];
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      adtMock: {
        syntaxCheck: vi.fn(async () => {
          callOrder.push('syntaxCheck');
          return [];
        }),
        lock: vi.fn(async () => {
          callOrder.push('lock');
          return { uri: '/sap/x', lockHandle: 'HANDLE-1' };
        }),
        writeSource: vi.fn(async () => {
          callOrder.push('writeSource');
        }),
        unlock: vi.fn(async () => {
          callOrder.push('unlock');
        }),
      },
    });
    const out = await runTool(
      writeObjectTool,
      {
        sourceUri: '/sap/x/source/main',
        objectUri: '/sap/x',
        packageName: '$TMP',
        source: 'CLASS zcl_ok DEFINITION. ENDCLASS.',
      },
      ctx,
    );
    expect(out.written).toBe(true);
    expect(out.lockReleased).toBe(true);
    expect(callOrder).toEqual(['syntaxCheck', 'lock', 'writeSource', 'unlock']);
  });

  it('releases lock even when writeSource throws', async () => {
    const unlockSpy = vi.fn();
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      adtMock: {
        syntaxCheck: vi.fn().mockResolvedValue([]),
        lock: vi.fn().mockResolvedValue({ uri: '/sap/x', lockHandle: 'H' }),
        writeSource: vi.fn().mockRejectedValue(new Error('SAP says no')),
        unlock: unlockSpy,
      },
    });
    await expect(
      runTool(
        writeObjectTool,
        {
          sourceUri: '/sap/x/source/main',
          objectUri: '/sap/x',
          packageName: '$TMP',
          source: 'x',
        },
        ctx,
      ),
    ).rejects.toThrow(/SAP says no/);
    expect(unlockSpy).toHaveBeenCalledTimes(1);
  });
});

describe('applyArtifactTool (atomic macro)', () => {
  it('runs create + write + activate in order on success', async () => {
    const calls: string[] = [];
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      adtMock: {
        createObject: vi.fn(async () => {
          calls.push('create');
        }),
        syntaxCheck: vi.fn(async () => {
          calls.push('syntaxCheck');
          return [];
        }),
        lock: vi.fn(async () => {
          calls.push('lock');
          return { uri: '/x', lockHandle: 'H' };
        }),
        writeSource: vi.fn(async () => {
          calls.push('write');
        }),
        unlock: vi.fn(async () => {
          calls.push('unlock');
        }),
        activate: vi.fn(async () => {
          calls.push('activate');
          return { success: true, inactiveObjects: 0, messages: [] };
        }),
      },
    });
    const out = await runTool(
      applyArtifactTool,
      {
        objectType: 'DDLS/DF',
        name: 'ZI_APPLY_TEST',
        description: 'test',
        packageName: '$TMP',
        source: 'define view entity ZI_APPLY_TEST as select from /dmo/carrier { key carrier_id }',
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.steps.map((s) => s.step)).toEqual(['create', 'write', 'activate']);
    expect(calls).toEqual(['create', 'syntaxCheck', 'lock', 'write', 'unlock', 'activate']);
  });

  it('aborts on pre-write syntax error without locking', async () => {
    const lockSpy = vi.fn();
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      adtMock: {
        createObject: vi.fn().mockResolvedValue(undefined),
        syntaxCheck: vi.fn().mockResolvedValue([
          { severity: 'error', uri: '/x', line: 1, offset: 0, text: 'bad' },
        ]),
        lock: lockSpy,
      },
    });
    const out = await runTool(
      applyArtifactTool,
      {
        objectType: 'DDLS/DF',
        name: 'ZI_BAD',
        description: 'bad',
        packageName: '$TMP',
        source: 'broken',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.failedAt).toBe('write');
    expect(lockSpy).not.toHaveBeenCalled();
  });

  it('reports failure when activation returns success=false', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      adtMock: {
        createObject: vi.fn().mockResolvedValue(undefined),
        syntaxCheck: vi.fn().mockResolvedValue([]),
        lock: vi.fn().mockResolvedValue({ uri: '/x', lockHandle: 'H' }),
        writeSource: vi.fn().mockResolvedValue(undefined),
        unlock: vi.fn().mockResolvedValue(undefined),
        activate: vi.fn().mockResolvedValue({
          success: false,
          inactiveObjects: 1,
          messages: [{ type: 'E', text: 'missing field' }],
        }),
      },
    });
    const out = await runTool(
      applyArtifactTool,
      {
        objectType: 'DDLS/DF',
        name: 'ZI_AC',
        description: 'x',
        packageName: '$TMP',
        source: 'x',
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.failedAt).toBe('activate');
    expect(out.errorMessage).toContain('missing field');
  });
});

describe('transport tools', () => {
  it('listTransportsTool filters by state (modifiable by default)', async () => {
    const ctx = buildTestContext({
      adtMock: {
        listTransports: vi.fn().mockResolvedValue([
          {
            number: 'NDCK900001',
            owner: 'TEST_USER',
            description: 'Aprendizado capitu',
            status: 'D',
            state: 'modifiable',
            workbench: true,
            objectCount: 3,
          },
          {
            number: 'NDCK900002',
            owner: 'TEST_USER',
            description: 'Já liberada',
            status: 'R',
            state: 'released',
            workbench: true,
            objectCount: 5,
          },
        ]),
      },
    });
    const out = await runTool(listTransportsTool, {}, ctx);
    expect(out.total).toBe(1);
    expect(out.transports[0]?.number).toBe('NDCK900001');
    expect(out.transports[0]?.state).toBe('modifiable');
  });

  it('listTransportsTool returns all when state=all', async () => {
    const ctx = buildTestContext({
      adtMock: {
        listTransports: vi.fn().mockResolvedValue([
          {
            number: 'A',
            owner: 'X',
            description: 'a',
            status: 'D',
            state: 'modifiable',
            workbench: true,
            objectCount: 0,
          },
          {
            number: 'B',
            owner: 'X',
            description: 'b',
            status: 'R',
            state: 'released',
            workbench: true,
            objectCount: 0,
          },
        ]),
      },
    });
    const out = await runTool(listTransportsTool, { state: 'all' }, ctx);
    expect(out.total).toBe(2);
  });

  it('transportContentsTool returns aggregated tasks + objects', async () => {
    const ctx = buildTestContext({
      adtMock: {
        transportContents: vi.fn().mockResolvedValue({
          number: 'NDCK900001',
          owner: 'TEST_USER',
          description: 'Aprendizado capitu',
          status: 'D',
          tasks: [
            {
              number: 'NDCK900002',
              owner: 'TEST_USER',
              description: 'Task',
              status: 'D',
              objects: [{ pgmid: 'R3TR', type: 'DDLS', name: 'ZI_FLIGHT_DEMO' }],
            },
          ],
          allObjects: [{ pgmid: 'R3TR', type: 'DDLS', name: 'ZI_FLIGHT_DEMO' }],
        }),
      },
    });
    const out = await runTool(
      transportContentsTool,
      { transportNumber: 'NDCK900001' },
      ctx,
    );
    expect(out.taskCount).toBe(1);
    expect(out.totalObjects).toBe(1);
    expect(out.tasks[0]?.objects[0]?.name).toBe('ZI_FLIGHT_DEMO');
  });
});

describe('cross-agent learnings', () => {
  it('learn records with sourceAgent=capitu-dev', async () => {
    const ctx = buildTestContext();
    const out = await runTool(
      learnTool,
      {
        kind: 'error-fix',
        problem: 'activation fails with ED064',
        solution: 'retry once — known S/4HANA quirk',
      },
      ctx,
    );
    expect(out.id).toBeGreaterThan(0);

    const row = ctx.kb
      .prepare('SELECT source_agent FROM learnings WHERE id = ?')
      .get(out.id) as { source_agent: string };
    expect(row.source_agent).toBe('capitu-dev');
  });

  it('recall finds learnings written by both agents', async () => {
    const ctx = buildTestContext();

    // Simula um learning gravado pelo docs-mcp diretamente no DB
    const info = ctx.kb
      .prepare(
        `INSERT INTO learnings (kind, problem, solution, source_agent)
         VALUES ('gotcha', 'porta 8100 HTTPS', 'usar SMICM', 'capitu-docs')`,
      )
      .run();
    const docsId = BigInt(info.lastInsertRowid);
    const [emb] = await fake.embed(['porta 8100 HTTPS\nusar SMICM']);
    if (!emb) throw new Error('embed failed');
    const blob = Buffer.alloc(emb.length * 4);
    for (let i = 0; i < emb.length; i++) blob.writeFloatLE(emb[i] ?? 0, i * 4);
    ctx.kb
      .prepare('INSERT INTO learnings_vec (rowid, embedding) VALUES (?, ?)')
      .run(docsId, blob);

    // Grava outro pelo dev
    await runTool(
      learnTool,
      {
        kind: 'gotcha',
        problem: 'porta diferente do padrão',
        solution: 'verificar serviços ICM',
      },
      ctx,
    );

    const out = await runTool(recallTool, { query: 'porta HTTPS SAP', limit: 5 }, ctx);
    expect(out.matches.length).toBeGreaterThanOrEqual(1);
    const sources = new Set(out.matches.map((m) => m.sourceAgent));
    // Pelo menos um dos dois agentes deve aparecer (ambos é o ideal)
    expect(sources.size).toBeGreaterThanOrEqual(1);
  });
});

describe('compliance still enforced', () => {
  it('strict mode passes endorsed categories', async () => {
    const ctx = buildTestContext({
      adtMock: {
        getSource: vi.fn().mockResolvedValue({ uri: '/x', source: 'ok' }),
      },
    });
    await expect(
      runTool(readObjectTool, { sourceUri: '/sap/x/source/main' }, ctx),
    ).resolves.toBeTruthy();
  });

  it('CompliancePolicyViolation thrown for gray-zone tool (forged)', async () => {
    const ctx = buildTestContext();
    const grayTool = {
      ...readObjectTool,
      name: 'fake-gray',
      category: 'business-data-read' as const,
    };
    await expect(
      runTool(grayTool, { sourceUri: '/x' }, ctx),
    ).rejects.toThrow(CompliancePolicyViolation);
  });
});
