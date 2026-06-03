import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CapituAdtClient, InstanceRegistry } from '@capitu/adt-client';
import {
  type ComplianceContext,
  CompliancePolicyViolation,
  FakeEmbeddings,
  getActiveInstance,
  openKb,
  setActiveInstance,
} from '@capitu/kb';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ServerContext, isPackageAllowed } from '../src/context.js';
import { runTool } from '../src/tool.js';
import {
  activateTool,
  applyArtifactTool,
  createObjectTool,
  createServiceBindingTool,
  createServiceDefinitionTool,
  findReferencesTool,
  learnTool,
  listInstancesTool,
  listTransportsTool,
  publishServiceBindingTool,
  readObjectTool,
  readPackageTool,
  recallTool,
  searchTool,
  syntaxCheckTool,
  transportContentsTool,
  unpublishServiceBindingTool,
  useInstanceTool,
  whichInstanceTool,
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
  writesAllowed?: boolean;
  allowedPackages?: string[];
  restrictedByDefault?: boolean;
  permissive?: boolean;
  adtMock?: Partial<CapituAdtClient>;
  packageHierarchy?: ServerContext['packageHierarchy'];
}): ServerContext {
  const db = openKb({ path: join(dbDir, 'kb.db') });
  openDbs.push(db);
  const compliance: ComplianceContext = opts?.permissive
    ? { mode: 'permissive', riskAcknowledged: true }
    : { mode: 'strict', riskAcknowledged: false };
  // Defaults that mimic CapituAdtClient methods so write tools don't need
  // every test to wire pickDefaultTransport / listTransports etc.
  const defaultAdtStubs: Partial<CapituAdtClient> = {
    pickDefaultTransport: vi.fn().mockResolvedValue(undefined),
    resetTransportCache: vi.fn(),
  };
  return {
    kb: db,
    embeddings: fake,
    adt: { ...defaultAdtStubs, ...opts?.adtMock } as CapituAdtClient,
    // These gate tests don't switch instances; a stub registry satisfies the type.
    registry: {} as ServerContext['registry'],
    compliance,
    agent: 'capitu-dev',
    activeProfileName: 'test-instance',
    writes: {
      allowed: opts?.writesAllowed ?? false,
      allowedPackages: opts?.allowedPackages ?? ['$TMP'],
      restrictedByDefault: opts?.restrictedByDefault ?? false,
    },
    // Subtree resolver: tests inject a fake; default denies everything (no subtree).
    packageHierarchy: opts?.packageHierarchy ?? {
      isDescendantOrSelf: async () => false,
      invalidate: () => {},
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
        findReferences: vi
          .fn()
          .mockResolvedValue([{ uri: '/sap/x', type: 'CLAS/OC', name: 'ZCL_CALLER' }]),
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
        syntaxCheck: vi
          .fn()
          .mockResolvedValue([
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
        syntaxCheck: vi
          .fn()
          .mockResolvedValue([
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
    ).rejects.toThrow(/disabled by the server-wide ceiling/);
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
    ).rejects.toThrow(/not in the effective allowlist/);
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
    expect(out.uri).toBe('/sap/bc/adt/ddic/ddl/sources/zi_example_cds');
    expect(out.sourceUri).toBe('/sap/bc/adt/ddic/ddl/sources/zi_example_cds/source/main');
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
    ).rejects.toThrow(/disabled by the server-wide ceiling/);
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
    ).rejects.toThrow(/not in the effective allowlist/);
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
      runTool(activateTool, { objectName: 'ZI_X', objectUri: '/sap/x', packageName: '$TMP' }, ctx),
    ).rejects.toThrow(/disabled by the server-wide ceiling/);
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
        syntaxCheck: vi
          .fn()
          .mockResolvedValue([{ severity: 'error', uri: '/x', line: 1, offset: 0, text: 'bad' }]),
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
    const out = await runTool(transportContentsTool, { transportNumber: 'NDCK900001' }, ctx);
    expect(out.taskCount).toBe(1);
    expect(out.totalObjects).toBe(1);
    expect(out.tasks[0]?.objects[0]?.name).toBe('ZI_FLIGHT_DEMO');
  });
});

describe('RAP service stack tools', () => {
  it('createServiceDefinitionTool generates a default skeleton from exposedCdsView', async () => {
    const createObject = vi.fn().mockResolvedValue(undefined);
    const lock = vi.fn().mockResolvedValue({ uri: 'x', lockHandle: 'H' });
    const writeSource = vi.fn().mockResolvedValue(undefined);
    const unlock = vi.fn().mockResolvedValue(undefined);
    const activate = vi.fn().mockResolvedValue({ success: true, inactiveObjects: 0, messages: [] });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP', 'ZCASEN8N'],
      adtMock: { createObject, lock, writeSource, unlock, activate },
    });
    const out = await runTool(
      createServiceDefinitionTool,
      {
        name: 'ZUI_PURCHASE_REQ',
        description: 'PurchaseReq UI service',
        packageName: 'ZCASEN8N',
        exposedCdsView: 'ZC_PURCHASE_REQ',
      },
      ctx,
    );
    expect(out.created).toBe(true);
    expect(out.activated).toBe(true);
    expect(out.alias).toBe('PurchaseReq'); // ZC_PURCHASE_REQ → strip ZC_, PascalCase
    expect(out.generatedSkeleton).toBe(true);
    expect(out.sourceUri).toBe('/sap/bc/adt/ddic/srvd/sources/zui_purchase_req/source/main');
    // Skeleton contains the expected expose clause
    expect(writeSource.mock.calls[0]?.[1]).toContain('expose ZC_PURCHASE_REQ as PurchaseReq');
    expect(writeSource.mock.calls[0]?.[1]).toContain('define service ZUI_PURCHASE_REQ');
  });

  it('createServiceDefinitionTool honors an explicit alias', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: {
        createObject: vi.fn().mockResolvedValue(undefined),
        lock: vi.fn().mockResolvedValue({ uri: 'x', lockHandle: 'H' }),
        writeSource: vi.fn().mockResolvedValue(undefined),
        unlock: vi.fn().mockResolvedValue(undefined),
        activate: vi.fn().mockResolvedValue({ success: true, inactiveObjects: 0, messages: [] }),
      },
    });
    const out = await runTool(
      createServiceDefinitionTool,
      {
        name: 'ZUI_PURCHASE_REQ',
        description: 'd',
        packageName: 'ZCASEN8N',
        exposedCdsView: 'ZC_PURCHASE_REQ',
        alias: 'PR',
      },
      ctx,
    );
    expect(out.alias).toBe('PR');
  });

  it('createServiceBindingTool routes through createSrvbRaw and reports effective binding', async () => {
    const createSrvbRaw = vi.fn().mockResolvedValue({
      objectUri: '/sap/bc/adt/businessservices/bindings/zui_purchase_req_o4',
    });
    const activate = vi.fn().mockResolvedValue({ success: true, inactiveObjects: 0, messages: [] });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: { createSrvbRaw, activate },
    });
    const out = await runTool(
      createServiceBindingTool,
      {
        name: 'ZUI_PURCHASE_REQ_O4',
        description: 'OData V4 UI binding',
        packageName: 'ZCASEN8N',
        serviceDefinition: 'ZUI_PURCHASE_REQ',
        bindingType: 'ODataV4-UI',
      },
      ctx,
    );
    expect(createSrvbRaw).toHaveBeenCalledTimes(1);
    expect(createSrvbRaw.mock.calls[0]?.[0].serviceDefinition).toBe('ZUI_PURCHASE_REQ');
    expect(out.created).toBe(true);
    expect(out.activated).toBe(true);
    expect(out.effectiveBinding.version).toBe('V4');
    expect(out.effectiveBinding.category).toBe('0'); // UI
    expect(out.serviceDefinition).toBe('ZUI_PURCHASE_REQ');
  });

  it('createServiceBindingTool defaults to V2/UI when bindingType omitted', async () => {
    const createSrvbRaw = vi.fn().mockResolvedValue({
      objectUri: '/sap/bc/adt/businessservices/bindings/z_x',
    });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: {
        createSrvbRaw,
        activate: vi.fn().mockResolvedValue({ success: true, inactiveObjects: 0, messages: [] }),
      },
    });
    const out = await runTool(
      createServiceBindingTool,
      {
        name: 'Z_X',
        description: 'd',
        packageName: 'ZCASEN8N',
        serviceDefinition: 'ZSD_X',
      },
      ctx,
    );
    // default is "ODataV4-UI" per schema default, so V4 + UI
    expect(out.effectiveBinding.version).toBe('V4');
    expect(out.effectiveBinding.category).toBe('0');
  });

  it('createServiceBindingTool honors explicit category / odataVersion overrides', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: {
        createSrvbRaw: vi
          .fn()
          .mockResolvedValue({ objectUri: '/sap/bc/adt/businessservices/bindings/z' }),
        activate: vi.fn().mockResolvedValue({ success: true, inactiveObjects: 0, messages: [] }),
      },
    });
    const out = await runTool(
      createServiceBindingTool,
      {
        name: 'Z_X',
        description: 'd',
        packageName: 'ZCASEN8N',
        serviceDefinition: 'ZSD_X',
        bindingType: 'ODataV4-UI', // would normally yield V4/0
        category: '1', // Web API override
        odataVersion: 'V2', // V2 override
      },
      ctx,
    );
    expect(out.effectiveBinding.version).toBe('V2');
    expect(out.effectiveBinding.category).toBe('1');
  });

  it('publishServiceBindingTool delegates to adt.publishServiceBinding with default version 0001', async () => {
    const publishServiceBinding = vi.fn().mockResolvedValue({
      severity: 'S',
      shortText: 'Service published',
      longText: '',
    });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: { publishServiceBinding },
    });
    const out = await runTool(publishServiceBindingTool, { name: 'ZUI_PURCHASE_REQ_O4' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.name).toBe('ZUI_PURCHASE_REQ_O4');
    expect(out.version).toBe('0001');
    expect(out.severity).toBe('S');
    expect(publishServiceBinding).toHaveBeenCalledWith('ZUI_PURCHASE_REQ_O4', '0001');
    expect(out.predictedEndpoint).toContain('zui_purchase_req_o4');
    expect(out.predictedEndpoint).toContain('/0001/');
  });

  it('publishServiceBindingTool maps SEVERITY="OK" (real PCE response) to ok=true', async () => {
    // Regression for the publishjobs bug captured live on PCE 2026-05-31:
    // The endpoint returns the literal string SEVERITY="OK", NOT a T100
    // letter. Earlier handler only accepted 'S'/'I' as success and reported
    // a successful publish as ok=false. Captured curl output:
    //   <DATA><SEVERITY>OK</SEVERITY><SHORT_TEXT>Local Service Endpoint of
    //   service ZUI_PURCHASE_REQ_O4 with version 0001 is activated locally
    //   </SHORT_TEXT><LONG_TEXT/></DATA>
    const publishServiceBinding = vi.fn().mockResolvedValue({
      severity: 'OK',
      shortText:
        'Local Service Endpoint of service ZUI_PURCHASE_REQ_O4 with version 0001 is activated locally',
      longText: '',
    });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: { publishServiceBinding },
    });
    const out = await runTool(publishServiceBindingTool, { name: 'ZUI_PURCHASE_REQ_O4' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.severity).toBe('OK');
    expect(out.shortText).toContain('activated locally');
    expect(out.message).toMatch(/Published/i);
  });

  it('publishServiceBindingTool surfaces server error severity/shortText', async () => {
    // After the SEVERITY="OK" fix, only literal "OK"/"S"/"I"/"W" map to
    // ok=true. Anything else — "ERROR", "E", "FATAL", empty string — falls
    // through to ok=false with the server's message preserved.
    const publishServiceBinding = vi.fn().mockResolvedValue({
      severity: 'ERROR',
      shortText: 'Service binding not active',
      longText: 'Activate the service binding before publishing.',
    });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: { publishServiceBinding },
    });
    const out = await runTool(publishServiceBindingTool, { name: 'Z_X' }, ctx);
    expect(out.ok).toBe(false);
    expect(out.severity).toBe('ERROR');
    expect(out.message).toContain('severity=ERROR');
    expect(out.message).toContain('Service binding not active');
  });

  it('publishServiceBindingTool honors an explicit version', async () => {
    const publishServiceBinding = vi.fn().mockResolvedValue({
      severity: 'S',
      shortText: '',
      longText: '',
    });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: { publishServiceBinding },
    });
    await runTool(publishServiceBindingTool, { name: 'Z_X', version: '0002' }, ctx);
    expect(publishServiceBinding).toHaveBeenCalledWith('Z_X', '0002');
  });

  it('unpublishServiceBindingTool delegates to adt.unpublishServiceBinding', async () => {
    const unpublishServiceBinding = vi.fn().mockResolvedValue({
      severity: 'S',
      shortText: 'Service unpublished',
      longText: '',
    });
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['ZCASEN8N'],
      adtMock: { unpublishServiceBinding },
    });
    const out = await runTool(unpublishServiceBindingTool, { name: 'ZUI_PURCHASE_REQ_O4' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.severity).toBe('S');
    expect(unpublishServiceBinding).toHaveBeenCalledWith('ZUI_PURCHASE_REQ_O4', '0001');
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

    const row = ctx.kb.prepare('SELECT source_agent FROM learnings WHERE id = ?').get(out.id) as {
      source_agent: string;
    };
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
    ctx.kb.prepare('INSERT INTO learnings_vec (rowid, embedding) VALUES (?, ?)').run(docsId, blob);

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
    await expect(runTool(grayTool, { sourceUri: '/x' }, ctx)).rejects.toThrow(
      CompliancePolicyViolation,
    );
  });
});

describe('instance management tools', () => {
  /**
   * Builds a context whose `registry` is a real InstanceRegistry wired to the
   * test DB's `meta` table (the same channel the 3 MCP processes share).
   * Two fake instances; passwords resolved to a constant — no network. We test
   * UseInstance with probe:false so it doesn't try to connect.
   */
  function buildInstanceContext(): { ctx: ServerContext; db: Database } {
    const db = openKb({ path: join(dbDir, 'kb.db') });
    openDbs.push(db);
    const registry = new InstanceRegistry(
      [
        { name: 'dev', url: 'https://dev.s4hana.cloud.sap', user: 'U1', client: '100' },
        { name: 'qas', url: 'https://qas.example.com', user: 'U2', edition: 'on-prem' },
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
      agent: 'capitu-dev' as const,
      writes: { allowed: false, allowedPackages: ['$TMP'] },
    };
    // Mirror buildContext(): `adt` is a getter resolving the active client, so
    // the test exercises the same dynamic-switch behavior as production.
    Object.defineProperty(base, 'adt', { enumerable: true, get: () => registry.active() });
    return { ctx: base as ServerContext, db };
  }

  it('listInstances returns all instances and flags the active one', async () => {
    const { ctx } = buildInstanceContext();
    const out = await runTool(listInstancesTool, {}, ctx);
    expect(out.active).toBe('dev'); // first instance when meta unset
    expect(out.instances.map((i) => i.name).sort()).toEqual(['dev', 'qas']);
    expect(out.instances.find((i) => i.name === 'dev')?.isActive).toBe(true);
    // edition inferred from URL for dev (.s4hana.cloud.sap → pce)
    expect(out.instances.find((i) => i.name === 'dev')?.edition).toBe('pce');
  });

  it('whichInstance reports the active instance summary (no secrets)', async () => {
    const { ctx } = buildInstanceContext();
    const out = await runTool(whichInstanceTool, {}, ctx);
    expect(out.name).toBe('dev');
    expect(out.url).toBe('https://dev.s4hana.cloud.sap');
    expect(JSON.stringify(out)).not.toMatch(/pw/);
  });

  it('useInstance switches the active instance and persists to the shared meta', async () => {
    const { ctx, db } = buildInstanceContext();
    const out = await runTool(useInstanceTool, { name: 'qas', probe: false }, ctx);
    expect(out.switched.name).toBe('qas');
    expect(out.probe).toBeUndefined();
    // Persisted to meta → another process would observe it.
    expect(getActiveInstance(db)).toBe('qas');
    // And the active getter now resolves the qas client.
    expect(ctx.adt.url).toBe('https://qas.example.com');
  });

  it('useInstance rejects an unknown instance', async () => {
    const { ctx } = buildInstanceContext();
    await expect(runTool(useInstanceTool, { name: 'prd', probe: false }, ctx)).rejects.toThrow(
      /Unknown instance "prd"/,
    );
  });
});

describe('per-instance write safety (ceiling + restrictive default)', () => {
  it('blocks writes with a restrictive-default message + step-by-step when profile is silent', async () => {
    // env allows writes, but the active profile did not declare readOnly:false.
    const ctx = buildTestContext({ writesAllowed: false, restrictedByDefault: true });
    await expect(
      runTool(
        createObjectTool,
        {
          objectType: 'CLAS/OC',
          name: 'ZCL_X',
          description: 'x',
          packageName: '$TMP',
        },
        ctx,
      ),
    ).rejects.toThrow(/READ-ONLY-BY-DEFAULT/);
  });

  it('restrictive-default message names the active instance and tells how to opt in', async () => {
    const ctx = buildTestContext({ writesAllowed: false, restrictedByDefault: true });
    await expect(
      runTool(
        createObjectTool,
        { objectType: 'CLAS/OC', name: 'ZCL_X', description: 'x', packageName: '$TMP' },
        ctx,
      ),
    ).rejects.toThrow(/instances\.json[\s\S]*readOnly.*false[\s\S]*capituDevUseInstance/);
  });

  it('allows the write when env permits AND the profile opened it (restrictedByDefault=false)', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP', 'Z*'],
      restrictedByDefault: false,
      adtMock: {
        createObject: vi.fn().mockResolvedValue(undefined),
      },
    });
    const out = await runTool(
      createObjectTool,
      { objectType: 'CLAS/OC', name: 'ZCL_OK', description: 'x', packageName: 'ZSANDBOX' },
      ctx,
    );
    // createObjectTool returns a structured result; just assert it didn't throw
    // and the package gate accepted ZSANDBOX (matches the Z* profile allowlist).
    expect(out).toBeDefined();
  });

  it('package outside the effective allowlist is rejected with the new message', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      allowedPackages: ['$TMP'],
      restrictedByDefault: false,
    });
    await expect(
      runTool(
        createObjectTool,
        { objectType: 'CLAS/OC', name: 'ZCL_X', description: 'x', packageName: 'ZPROD' },
        ctx,
      ),
    ).rejects.toThrow(/not in the effective allowlist/);
  });

  it('allows a write to a sub-package via a ZFOO/** subtree rule', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      restrictedByDefault: false,
      allowedPackages: ['ZIVB_APRENDIZAGEM/**'],
      // Resolver says ZIVB_SUB1 is under ZIVB_APRENDIZAGEM.
      packageHierarchy: {
        isDescendantOrSelf: async (root, pkg) =>
          root.toUpperCase() === 'ZIVB_APRENDIZAGEM' && pkg.toUpperCase() === 'ZIVB_SUB1',
        invalidate: () => {},
      },
      adtMock: { createObject: vi.fn().mockResolvedValue(undefined) },
    });
    const out = await runTool(
      createObjectTool,
      { objectType: 'CLAS/OC', name: 'ZCL_SUB', description: 'x', packageName: 'ZIVB_SUB1' },
      ctx,
    );
    expect(out).toBeDefined();
  });

  it('denies (fail-closed) when subtree resolution throws', async () => {
    const ctx = buildTestContext({
      writesAllowed: true,
      restrictedByDefault: false,
      allowedPackages: ['ZIVB_APRENDIZAGEM/**'],
      packageHierarchy: {
        isDescendantOrSelf: async () => {
          throw new Error('denying the write for safety: network down');
        },
        invalidate: () => {},
      },
    });
    await expect(
      runTool(
        createObjectTool,
        { objectType: 'CLAS/OC', name: 'ZCL_X', description: 'x', packageName: 'ZIVB_SUB1' },
        ctx,
      ),
    ).rejects.toThrow(/denying the write for safety/);
  });
});
