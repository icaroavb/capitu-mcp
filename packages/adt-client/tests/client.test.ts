import { describe, expect, it, vi } from 'vitest';
import { CapituAdtClient } from '../src/index.js';

/**
 * These tests mock the underlying ADTClient and exercise normalization logic.
 * Real connectivity is covered by scripts/smoke-test-adt*.ts against a live SAP.
 */

interface MockADT {
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  searchObject: ReturnType<typeof vi.fn>;
  nodeContents: ReturnType<typeof vi.fn>;
  getObjectSource: ReturnType<typeof vi.fn>;
}

function patchInner(c: CapituAdtClient, mock: MockADT): void {
  // Test seam: replace the private `inner` ADTClient with our mock.
  (c as unknown as { inner: MockADT }).inner = mock;
}

function makeClient(): { c: CapituAdtClient; mock: MockADT } {
  const c = new CapituAdtClient({
    url: 'https://test.example.com',
    user: 'TEST',
    password: 'TEST',
  });
  const mock: MockADT = {
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    searchObject: vi.fn(),
    nodeContents: vi.fn(),
    getObjectSource: vi.fn(),
  };
  patchInner(c, mock);
  return { c, mock };
}

describe('CapituAdtClient', () => {
  it('connect() is idempotent', async () => {
    const { c, mock } = makeClient();
    await c.connect();
    await c.connect();
    await c.connect();
    expect(mock.login).toHaveBeenCalledTimes(1);
    expect(c.isConnected()).toBe(true);
  });

  it('disconnect() resets state', async () => {
    const { c, mock } = makeClient();
    await c.connect();
    await c.disconnect();
    expect(c.isConnected()).toBe(false);
    expect(mock.logout).toHaveBeenCalledTimes(1);
  });

  it('search() normalizes adtcore:* fields', async () => {
    const { c, mock } = makeClient();
    mock.searchObject.mockResolvedValue([
      {
        'adtcore:uri': '/sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb',
        'adtcore:type': 'DDLS/DF',
        'adtcore:name': 'ZI_FLIGHT_DEMO',
        'adtcore:packageName': 'Y_SUBPACKAGE',
        'adtcore:description': 'tabela de voos',
      },
    ]);
    const hits = await c.search('ZI_FLIGHT_DEMO', 'DDLS');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      uri: '/sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb',
      type: 'DDLS/DF',
      name: 'ZI_FLIGHT_DEMO',
      packageName: 'Y_SUBPACKAGE',
      description: 'tabela de voos',
    });
  });

  it('search() handles missing optional fields', async () => {
    const { c, mock } = makeClient();
    mock.searchObject.mockResolvedValue([
      {
        'adtcore:uri': '/sap/bc/adt/oo/classes/cl_x',
        'adtcore:type': 'CLAS/OC',
        'adtcore:name': 'CL_X',
      },
    ]);
    const hits = await c.search('CL_X', 'CLAS');
    expect(hits[0]?.packageName).toBeUndefined();
    expect(hits[0]?.description).toBeUndefined();
  });

  it('listPackage() splits objects and categories', async () => {
    const { c, mock } = makeClient();
    mock.nodeContents.mockResolvedValue({
      nodes: [
        {
          OBJECT_URI: '/sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb',
          OBJECT_TYPE: 'DDLS/DF',
          OBJECT_NAME: 'ZI_FLIGHT_DEMO',
          DESCRIPTION: 'tabela de voos',
        },
      ],
      categories: [{ CATEGORY: 'core_data_services' }, { CATEGORY: 'classes' }],
    });
    const contents = await c.listPackage('Y_SUBPACKAGE');
    expect(contents.objects).toHaveLength(1);
    expect(contents.objects[0]?.name).toBe('ZI_FLIGHT_DEMO');
    expect(contents.objects[0]?.description).toBe('tabela de voos');
    expect(contents.categories).toEqual(['core_data_services', 'classes']);
  });

  it('listPackage() handles empty package', async () => {
    const { c, mock } = makeClient();
    mock.nodeContents.mockResolvedValue({ nodes: [], categories: [] });
    const contents = await c.listPackage('$TMP');
    expect(contents.objects).toEqual([]);
    expect(contents.categories).toEqual([]);
  });

  it('getSource() returns uri + source text', async () => {
    const { c, mock } = makeClient();
    mock.getObjectSource.mockResolvedValue('@AccessControl.authorizationCheck:#NOT_REQUIRED\ndefine view entity ...');
    const out = await c.getSource('/sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb/source/main');
    expect(out.uri).toBe('/sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb/source/main');
    expect(out.source).toContain('@AccessControl');
  });

  it('search() lazily connects', async () => {
    const { c, mock } = makeClient();
    mock.searchObject.mockResolvedValue([]);
    expect(c.isConnected()).toBe(false);
    await c.search('Z*');
    expect(mock.login).toHaveBeenCalledTimes(1);
    expect(c.isConnected()).toBe(true);
  });
});
