import { describe, expect, it } from 'vitest';
import {
  BDEF_COLLECTION,
  BDEF_CONTENT_TYPE,
  SRVB_COLLECTION,
  SRVB_CONTENT_TYPE,
  bdefObjectUri,
  bdefSourceUri,
  buildBdefCreateXml,
  buildSrvbCreateXml,
  normalizeSrvbBindingType,
  srvbObjectUri,
} from '../src/raw-create.js';

describe('BDEF XML', () => {
  it('builds a blue:blueSource envelope with the right namespaces and attributes', () => {
    const xml = buildBdefCreateXml({
      name: 'zi_booking',
      description: 'Booking behavior',
      packageName: '$tmp',
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns:blue="http://www.sap.com/wbobj/blue"');
    expect(xml).toContain('xmlns:adtcore="http://www.sap.com/adt/core"');
    expect(xml).toContain('adtcore:type="BDEF/BDO"');
    expect(xml).toContain('adtcore:name="ZI_BOOKING"');
    expect(xml).toContain('adtcore:description="Booking behavior"');
    expect(xml).toContain('<adtcore:packageRef adtcore:name="$TMP"/>');
  });

  it('escapes XML-special characters in description', () => {
    const xml = buildBdefCreateXml({
      name: 'ZI_X',
      description: 'A & B "quotes" <tag>',
      packageName: '$TMP',
    });
    expect(xml).toContain('adtcore:description="A &amp; B &quot;quotes&quot; &lt;tag&gt;"');
  });

  it('uppercases name and package', () => {
    const xml = buildBdefCreateXml({
      name: 'zi_lowercase',
      description: 'd',
      packageName: 'zivb_aprendizagem',
    });
    expect(xml).toContain('adtcore:name="ZI_LOWERCASE"');
    expect(xml).toContain('<adtcore:packageRef adtcore:name="ZIVB_APRENDIZAGEM"/>');
  });

  it('exposes the correct content-type constant', () => {
    expect(BDEF_CONTENT_TYPE).toBe('application/vnd.sap.adt.blues.v1+xml');
  });

  it('builds correct object + source URIs', () => {
    expect(bdefObjectUri('ZI_BOOKING')).toBe('/sap/bc/adt/bo/behaviordefinitions/zi_booking');
    expect(bdefSourceUri('ZI_BOOKING')).toBe(
      '/sap/bc/adt/bo/behaviordefinitions/zi_booking/source/main',
    );
    expect(BDEF_COLLECTION).toBe('/sap/bc/adt/bo/behaviordefinitions');
  });
});

describe('SRVB XML', () => {
  it('builds a srvb:serviceBinding envelope with V2 UI by default', () => {
    const xml = buildSrvbCreateXml({
      name: 'z_ui_booking',
      description: 'UI binding',
      packageName: '$tmp',
      serviceDefinition: 'zsd_booking',
    });
    expect(xml).toContain('xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"');
    expect(xml).toContain('adtcore:type="SRVB/SVB"');
    expect(xml).toContain('adtcore:name="Z_UI_BOOKING"');
    expect(xml).toContain('<srvb:serviceDefinition adtcore:name="ZSD_BOOKING"/>');
    expect(xml).toContain('srvb:category="0"');
    expect(xml).toContain('srvb:type="ODATA"');
    expect(xml).toContain('srvb:version="V2"');
    expect(xml).toContain('srvb:content srvb:version="0001"');
  });

  it('honors ODataV4-UI normalization', () => {
    const xml = buildSrvbCreateXml({
      name: 'Z_X',
      description: 'd',
      packageName: '$TMP',
      serviceDefinition: 'ZSD_X',
      bindingType: 'ODataV4-UI',
    });
    expect(xml).toContain('srvb:version="V4"');
    expect(xml).toContain('srvb:category="0"');
  });

  it('honors Web API (category=1) hint', () => {
    const xml = buildSrvbCreateXml({
      name: 'Z_X',
      description: 'd',
      packageName: '$TMP',
      serviceDefinition: 'ZSD_X',
      bindingType: 'OData V4 Web API',
    });
    expect(xml).toContain('srvb:version="V4"');
    expect(xml).toContain('srvb:category="1"');
  });

  it('lets explicit category/odataVersion override bindingType', () => {
    const xml = buildSrvbCreateXml({
      name: 'Z_X',
      description: 'd',
      packageName: '$TMP',
      serviceDefinition: 'ZSD_X',
      bindingType: 'ODataV4-UI',
      category: '1',
      odataVersion: 'V2',
    });
    expect(xml).toContain('srvb:version="V2"');
    expect(xml).toContain('srvb:category="1"');
  });

  it('exposes the correct content-type constant', () => {
    expect(SRVB_CONTENT_TYPE).toMatch(
      /^application\/vnd\.sap\.adt\.businessservices\.servicebinding\.v2\+xml/,
    );
  });

  it('builds correct object URI', () => {
    expect(srvbObjectUri('Z_UI_BOOKING')).toBe(
      '/sap/bc/adt/businessservices/bindings/z_ui_booking',
    );
    expect(SRVB_COLLECTION).toBe('/sap/bc/adt/businessservices/bindings');
  });
});

describe('normalizeSrvbBindingType', () => {
  it('defaults to ODATA / V2 when empty', () => {
    expect(normalizeSrvbBindingType()).toEqual({ type: 'ODATA', odataVersion: 'V2' });
    expect(normalizeSrvbBindingType('')).toEqual({ type: 'ODATA', odataVersion: 'V2' });
  });

  it('parses V4 from various formats', () => {
    expect(normalizeSrvbBindingType('ODataV4-UI').odataVersion).toBe('V4');
    expect(normalizeSrvbBindingType('odata v4 web api').odataVersion).toBe('V4');
    expect(normalizeSrvbBindingType('ODATA_V4_UI').odataVersion).toBe('V4');
  });

  it('extracts category from "UI" vs "Web API" hint', () => {
    expect(normalizeSrvbBindingType('ODataV4-UI').category).toBe('0');
    expect(normalizeSrvbBindingType('ODataV4 Web API').category).toBe('1');
    expect(normalizeSrvbBindingType('ODataV2').category).toBeUndefined();
  });
});
