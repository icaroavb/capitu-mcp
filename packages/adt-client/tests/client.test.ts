import { describe, expect, it, vi } from 'vitest';
import { CapituAdtClient, decodeXmlEntities, isLocalPackage } from '../src/index.js';

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
    mock.getObjectSource.mockResolvedValue(
      '@AccessControl.authorizationCheck:#NOT_REQUIRED\ndefine view entity ...',
    );
    const out = await c.getSource('/sap/bc/adt/oo/classes/zcl_x/source/main');
    expect(out.uri).toBe('/sap/bc/adt/oo/classes/zcl_x/source/main');
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

  it('search() decodes XML entities in description', async () => {
    const { c, mock } = makeClient();
    mock.searchObject.mockResolvedValue([
      {
        'adtcore:uri': '/sap/x',
        'adtcore:type': 'CLAS/OC',
        'adtcore:name': 'ZCL_X',
        'adtcore:description': 'Foo &amp; Bar &lt;suffix&gt;',
      },
    ]);
    const hits = await c.search('ZCL_X', 'CLAS');
    expect(hits[0]?.description).toBe('Foo & Bar <suffix>');
  });
});

describe('decodeXmlEntities', () => {
  it('decodes the common entity set', () => {
    expect(decodeXmlEntities('&amp; &lt; &gt; &quot; &apos;')).toBe(`& < > " '`);
  });

  it('decodes numeric refs (decimal and hex)', () => {
    expect(decodeXmlEntities('caf&#233; &#x2014; done')).toBe('café — done');
  });

  it('passes through undefined', () => {
    expect(decodeXmlEntities(undefined)).toBeUndefined();
  });

  it('fast-paths strings without entities (returns identity)', () => {
    const input = 'no entities here';
    expect(decodeXmlEntities(input)).toBe(input);
  });
});

describe('isLocalPackage', () => {
  it('flags $TMP and other $* packages', () => {
    expect(isLocalPackage('$TMP')).toBe(true);
    expect(isLocalPackage('$tmp')).toBe(true); // case-insensitive prefix
    expect(isLocalPackage('$test_local')).toBe(true);
    expect(isLocalPackage('  $TMP  ')).toBe(true); // tolerates padding
  });

  it('does NOT flag transportable packages', () => {
    expect(isLocalPackage('ZIVB_APRENDIZAGEM')).toBe(false);
    expect(isLocalPackage('ZN8N')).toBe(false);
    expect(isLocalPackage('Y_TEST')).toBe(false);
  });

  it('handles undefined / empty safely', () => {
    expect(isLocalPackage(undefined)).toBe(false);
    expect(isLocalPackage('')).toBe(false);
  });
});

describe('createObject — $TMP transport handling', () => {
  it('drops corrNr when target package is $TMP', async () => {
    const c = new CapituAdtClient({
      url: 'https://test.example.com',
      user: 'TEST',
      password: 'TEST',
    });
    const createObject = vi.fn().mockResolvedValue(undefined);
    (c as unknown as { inner: Record<string, unknown> }).inner = {
      login: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      createObject,
    };
    await c.createObject({
      objectType: 'DOMA/DD',
      name: 'ZDO_X',
      description: 'd',
      packageName: '$TMP',
      transport: 'S4HK911172', // caller passes one — must be dropped
    });
    expect(createObject).toHaveBeenCalledTimes(1);
    const call = createObject.mock.calls[0][0];
    expect(call.transport).toBeUndefined();
    expect(call.parentName).toBe('$TMP');
  });

  it('keeps corrNr for transportable packages', async () => {
    const c = new CapituAdtClient({
      url: 'https://test.example.com',
      user: 'TEST',
      password: 'TEST',
    });
    const createObject = vi.fn().mockResolvedValue(undefined);
    (c as unknown as { inner: Record<string, unknown> }).inner = {
      login: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      createObject,
    };
    await c.createObject({
      objectType: 'DOMA/DD',
      name: 'ZDO_X',
      description: 'd',
      packageName: 'ZIVB_APRENDIZAGEM',
      transport: 'S4HK911172',
    });
    const call = createObject.mock.calls[0][0];
    expect(call.transport).toBe('S4HK911172');
  });
});

// Sample S/4HANA-shape XML — flat <request> with nested <task>
const S4_TR_XML = `<?xml version="1.0" encoding="utf-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm">
  <request number="S4HK911172" owner="TEST" desc="Open WB transport" status="D" type="K" target="TARGET">
    <task number="S4HK911173" owner="TEST" desc="WB task" status="D"/>
  </request>
</tm:root>`;

const EMPTY_TR_XML = `<?xml version="1.0" encoding="utf-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"></tm:root>`;

function mockClientWithHttp(opts: {
  trXml?: string;
  trXmlByUrl?: Record<string, string>;
  inner?: Record<string, unknown>;
}): CapituAdtClient {
  const c = new CapituAdtClient({
    url: 'https://test.example.com',
    user: 'TEST',
    password: 'TEST',
  });
  const request = vi.fn(async (url: string) => {
    if (opts.trXmlByUrl) {
      for (const [pattern, xml] of Object.entries(opts.trXmlByUrl)) {
        if (url.includes(pattern)) return { status: 200, body: xml };
      }
    }
    return { status: 200, body: opts.trXml ?? '' };
  });
  (c as unknown as { inner: Record<string, unknown> }).inner = {
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    httpClient: { request },
    userTransports: vi.fn().mockResolvedValue({ workbench: [], customizing: [] }),
    ...opts.inner,
  };
  return c;
}

describe('pickDefaultTransport', () => {
  it('returns undefined for local packages without touching the network', async () => {
    const c = mockClientWithHttp({ trXml: S4_TR_XML });
    expect(await c.pickDefaultTransport('$TMP')).toBeUndefined();
    // No HTTP call needed for local packages.
    const inner = (c as unknown as { inner: { httpClient: { request: ReturnType<typeof vi.fn> } } })
      .inner;
    expect(inner.httpClient.request).not.toHaveBeenCalled();
  });

  it('auto-picks the first modifiable workbench transport from S/4-shape XML', async () => {
    const c = mockClientWithHttp({ trXml: S4_TR_XML });
    expect(await c.pickDefaultTransport('ZN8N')).toBe('S4HK911172');
    // Cached — second call doesn't re-hit the SAP TR endpoint.
    await c.pickDefaultTransport('ZN8N');
    const inner = (c as unknown as { inner: { httpClient: { request: ReturnType<typeof vi.fn> } } })
      .inner;
    expect(inner.httpClient.request).toHaveBeenCalledTimes(1);
  });

  it('throws an actionable error when the user has no open workbench TR', async () => {
    const c = mockClientWithHttp({ trXml: EMPTY_TR_XML });
    await expect(c.pickDefaultTransport('ZN8N')).rejects.toThrow(/no open workbench transport/i);
  });

  it('resetTransportCache forces a re-pick on next call', async () => {
    const c = mockClientWithHttp({ trXml: S4_TR_XML });
    await c.pickDefaultTransport('ZN8N');
    c.resetTransportCache();
    await c.pickDefaultTransport('ZN8N');
    const inner = (c as unknown as { inner: { httpClient: { request: ReturnType<typeof vi.fn> } } })
      .inner;
    expect(inner.httpClient.request).toHaveBeenCalledTimes(2);
  });
});

describe('listTransports — S/4HANA XML shape', () => {
  it('calls the CTS endpoint with ARC-1 query params and parses flat <request>', async () => {
    const c = mockClientWithHttp({ trXml: S4_TR_XML });
    const trs = await c.listTransports();
    expect(trs).toHaveLength(1);
    expect(trs[0]?.number).toBe('S4HK911172');
    expect(trs[0]?.state).toBe('modifiable');
    expect(trs[0]?.workbench).toBe(true);

    const inner = (
      c as unknown as {
        inner: { httpClient: { request: ReturnType<typeof vi.fn> } };
      }
    ).inner;
    const calledUrl = inner.httpClient.request.mock.calls[0]?.[0] as string;
    // Required query params discovered via ARC-1 + verified on PCE.
    expect(calledUrl).toMatch(/requestType=KWT/);
    expect(calledUrl).toMatch(/requestStatus=DR/);
    // singular "target", not "targets" — abap-adt-api's bug.
    expect(calledUrl).toMatch(/target=true(&|$)/);
  });

  it('falls back to abap-adt-api userTransports when S/4 XML returns empty', async () => {
    const c = new CapituAdtClient({
      url: 'https://test.example.com',
      user: 'TEST',
      password: 'TEST',
    });
    const userTransports = vi.fn().mockResolvedValue({
      workbench: [
        {
          'tm:name': 'TARGET',
          modifiable: [
            {
              'tm:number': 'NPLK900001',
              'tm:owner': 'TEST',
              'tm:desc': 'NPL legacy',
              'tm:status': 'D',
              objects: [],
              tasks: [],
            },
          ],
          released: [],
        },
      ],
      customizing: [],
    });
    (c as unknown as { inner: Record<string, unknown> }).inner = {
      login: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      httpClient: { request: vi.fn().mockResolvedValue({ status: 200, body: EMPTY_TR_XML }) },
      userTransports,
    };
    const trs = await c.listTransports();
    expect(trs).toHaveLength(1);
    expect(trs[0]?.number).toBe('NPLK900001');
    expect(userTransports).toHaveBeenCalled();
  });
});

describe('writeSource — normalizes empty transport', () => {
  it('passes undefined to abap-adt-api when transport is empty/whitespace', async () => {
    const c = new CapituAdtClient({
      url: 'https://test.example.com',
      user: 'TEST',
      password: 'TEST',
    });
    const setObjectSource = vi.fn().mockResolvedValue(undefined);
    (c as unknown as { inner: Record<string, unknown> }).inner = {
      login: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      setObjectSource,
    };
    await c.writeSource('/sap/bc/adt/ddic/domains/zdo_x/source/main', 'source', 'H', '   ');
    expect(setObjectSource).toHaveBeenCalledWith(
      '/sap/bc/adt/ddic/domains/zdo_x/source/main',
      'source',
      'H',
      undefined,
    );
  });
});

describe('createBdefRaw / createSrvbRaw — corrNr threading', () => {
  function mockClient(): {
    c: CapituAdtClient;
    request: ReturnType<typeof vi.fn>;
  } {
    const c = new CapituAdtClient({
      url: 'https://test.example.com',
      user: 'TEST',
      password: 'TEST',
    });
    const request = vi.fn().mockResolvedValue({ status: 201, body: '' });
    (c as unknown as { inner: Record<string, unknown> }).inner = {
      login: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      httpClient: { request },
    };
    return { c, request };
  }

  it('createBdefRaw on $TMP omits corrNr from the URL', async () => {
    const { c, request } = mockClient();
    await c.createBdefRaw({
      name: 'ZI_BDEF_X',
      description: 'd',
      packageName: '$TMP',
      transport: 'S4HK911170', // caller passed one — must be DROPPED for $TMP
    });
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/_package=%24TMP/);
    expect(url).not.toMatch(/corrNr=/);
  });

  it('createBdefRaw on transportable package appends corrNr', async () => {
    const { c, request } = mockClient();
    await c.createBdefRaw({
      name: 'ZI_BDEF_X',
      description: 'd',
      packageName: 'ZCASEN8N',
      transport: 'S4HK911170',
    });
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/_package=ZCASEN8N/);
    expect(url).toMatch(/corrNr=S4HK911170/);
  });

  it('createBdefRaw on transportable package WITHOUT transport omits corrNr', async () => {
    const { c, request } = mockClient();
    // Caller didn't pass a transport — adt-client doesn't synthesize one here.
    // (Auto-pick is the MCP-layer's job via pickDefaultTransport; if it failed,
    // the createBdefRaw call still goes out, and the SAP responds with TO-131
    // or SADT_RESOURCE-17 — a USEFUL error, not a silent bad payload.)
    await c.createBdefRaw({
      name: 'ZI_BDEF_X',
      description: 'd',
      packageName: 'ZCASEN8N',
    });
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/_package=ZCASEN8N/);
    expect(url).not.toMatch(/corrNr=/);
  });

  it('createSrvbRaw on transportable package appends corrNr (regression: SADT_RESOURCE-17)', async () => {
    const { c, request } = mockClient();
    await c.createSrvbRaw({
      name: 'ZUI_X_O4',
      description: 'd',
      packageName: 'ZCASEN8N',
      serviceDefinition: 'ZUI_X',
      bindingType: 'ODataV4-UI',
      transport: 'S4HK911170',
    });
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/businessservices\/bindings\?/);
    expect(url).toMatch(/_package=ZCASEN8N/);
    expect(url).toMatch(/corrNr=S4HK911170/);
    // Live error this regression-tests against:
    //   HTTP 400 — ExceptionParameterNotFound — [SADT_RESOURCE-17]
    //   "Parameter corrNr could not be found."
    // (raised by /sap/bc/adt/businessservices/bindings when corrNr is missing
    // for a transportable package; reproduced live on PCE 2026-05-27)
  });

  it('createSrvbRaw on $TMP omits corrNr (would 400 otherwise)', async () => {
    const { c, request } = mockClient();
    await c.createSrvbRaw({
      name: 'ZUI_X_O4',
      description: 'd',
      packageName: '$TMP',
      serviceDefinition: 'ZUI_X',
      transport: 'S4HK911170', // caller passed one — dropped
    });
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).not.toMatch(/corrNr=/);
  });

  it('createSrvbRaw trims whitespace transport and treats it as missing', async () => {
    const { c, request } = mockClient();
    await c.createSrvbRaw({
      name: 'ZUI_X_O4',
      description: 'd',
      packageName: 'ZCASEN8N',
      serviceDefinition: 'ZUI_X',
      transport: '   ',
    });
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).not.toMatch(/corrNr=/);
  });
});

describe('publishServiceBinding / unpublishServiceBinding', () => {
  function mockClient(): {
    c: CapituAdtClient;
    request: ReturnType<typeof vi.fn>;
  } {
    const c = new CapituAdtClient({
      url: 'https://test.example.com',
      user: 'TEST',
      password: 'TEST',
    });
    const request = vi.fn();
    (c as unknown as { inner: Record<string, unknown> }).inner = {
      login: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      httpClient: { request },
    };
    return { c, request };
  }

  const SUCCESS_XML = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">
  <asx:values>
    <DATA>
      <SEVERITY>S</SEVERITY>
      <SHORT_TEXT>Service published successfully</SHORT_TEXT>
      <LONG_TEXT>OData V4 service now reachable</LONG_TEXT>
    </DATA>
  </asx:values>
</asx:abap>`;

  it('publishServiceBinding POSTs to /odatav2/publishjobs with name+version in the query', async () => {
    const { c, request } = mockClient();
    request.mockResolvedValue({ status: 200, body: SUCCESS_XML });
    const out = await c.publishServiceBinding('ZUI_PURCHASE_REQ_O4', '0001');
    expect(request).toHaveBeenCalledTimes(1);
    const url = request.mock.calls[0]?.[0] as string;
    // Note: /odatav2/ in the path even for V4 bindings — single SAP endpoint.
    // Earlier capitu code used /odatav4/ and content-type application/vnd.sap.adt.publishjobs+xml;
    // PCE rejected both. This test pins the correct shape.
    expect(url).toBe(
      '/sap/bc/adt/businessservices/odatav2/publishjobs?servicename=ZUI_PURCHASE_REQ_O4&serviceversion=0001',
    );
    const opts = request.mock.calls[0]?.[1] as {
      method: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(opts.method).toBe('POST');
    // No explicit Content-Type — server picks defaults; with application/* Accept it returns asx:abap.
    expect(opts.headers['Content-Type']).toBeUndefined();
    expect(opts.headers.Accept).toBe('application/*');
    expect(opts.body).toContain('<adtcore:objectReference adtcore:name="ZUI_PURCHASE_REQ_O4"/>');
    expect(out.severity).toBe('S');
    expect(out.shortText).toBe('Service published successfully');
    expect(out.longText).toBe('OData V4 service now reachable');
  });

  it('publishServiceBinding parses error severity from the asx:abap envelope', async () => {
    const { c, request } = mockClient();
    request.mockResolvedValue({
      status: 200,
      body: `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">
  <asx:values>
    <DATA>
      <SEVERITY>E</SEVERITY>
      <SHORT_TEXT>Service binding not active</SHORT_TEXT>
      <LONG_TEXT>Activate the SRVB before publishing.</LONG_TEXT>
    </DATA>
  </asx:values>
</asx:abap>`,
    });
    const out = await c.publishServiceBinding('Z_X', '0001');
    expect(out.severity).toBe('E');
    expect(out.shortText).toBe('Service binding not active');
  });

  it('publishServiceBinding returns empty severity + body preview for non-asx responses', async () => {
    // When the body doesn't match the expected envelope (CSRF rejection
    // plain-text, SICF error pages, HTML, …) the parser returns empty
    // severity/shortText and surfaces the raw response in longText. We do
    // NOT fabricate a severity ('?' or anything else) — the caller maps
    // empty → failure at its own layer (e.g. dev-mcp/service.ts).
    const { c, request } = mockClient();
    request.mockResolvedValue({
      status: 403,
      body: 'A validação de token CSRF falhou',
    });
    const out = await c.publishServiceBinding('Z_X', '0001');
    expect(out.severity).toBe('');
    expect(out.shortText).toBe('');
    expect(out.longText).toContain('CSRF');
  });

  it('publishServiceBinding parses the real PCE response with SEVERITY="OK"', async () => {
    // Real XML captured live from PCE 2026-05-31 via curl. SEVERITY is the
    // literal string "OK", NOT a T100 letter — the publishjobs endpoint
    // has its own severity vocabulary. Test fixed against the actual bytes
    // the server sends so we don't regress to the previous bug of treating
    // a successful publish as failed because we only matched 'S'/'I'.
    const { c, request } = mockClient();
    request.mockResolvedValue({
      status: 200,
      body: '<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><SEVERITY>OK</SEVERITY><SHORT_TEXT>Local Service Endpoint of service ZUI_PURCHASE_REQ_O4 with version 0001 is activated locally</SHORT_TEXT><LONG_TEXT/></DATA></asx:values></asx:abap>',
    });
    const out = await c.publishServiceBinding('ZUI_PURCHASE_REQ_O4', '0001');
    expect(out.severity).toBe('OK');
    expect(out.shortText).toContain('Local Service Endpoint');
    expect(out.shortText).toContain('activated locally');
    expect(out.longText).toBe('');
  });

  it('publishServiceBinding URL-encodes special chars in name (defensive)', async () => {
    // Service binding names are always uppercase ABAP identifiers in practice
    // (Z[A-Z0-9_]+), but if a bad caller passes whitespace or '/', the
    // URLSearchParams call should encode them rather than corrupt the URL.
    const { c, request } = mockClient();
    request.mockResolvedValue({ status: 200, body: SUCCESS_XML });
    await c.publishServiceBinding('Z X', '0001');
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).toContain('servicename=Z+X');
  });

  it('unpublishServiceBinding hits the unpublishjobs endpoint', async () => {
    const { c, request } = mockClient();
    request.mockResolvedValue({
      status: 200,
      body: SUCCESS_XML.replace('Service published successfully', 'Service unpublished'),
    });
    const out = await c.unpublishServiceBinding('Z_X', '0001');
    const url = request.mock.calls[0]?.[0] as string;
    expect(url).toContain('/odatav2/unpublishjobs?');
    expect(url).toContain('servicename=Z_X');
    expect(out.severity).toBe('S');
  });

  it('publishServiceBinding wraps non-2xx errors thrown by the transport', async () => {
    const { c, request } = mockClient();
    request.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 401'), {
        type: 'ExceptionUnauthorized',
        err: 401,
      }),
    );
    await expect(c.publishServiceBinding('Z_X', '0001')).rejects.toThrow(
      /publishjobs\(Z_X v0001\)/,
    );
  });
});
