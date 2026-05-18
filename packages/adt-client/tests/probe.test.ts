import { describe, expect, it } from 'vitest';
import { classifyEdition } from '../src/index.js';

describe('classifyEdition', () => {
  it('classifies *.s4hana.cloud.sap as PCE', () => {
    expect(classifyEdition('https://abc.s4hana.cloud.sap')).toBe('pce');
    expect(classifyEdition('https://my100.s4hana.cloud.sap:443')).toBe('pce');
  });

  it('classifies BTP ABAP environment hosts', () => {
    expect(classifyEdition('https://x.abap.ondemand.com')).toBe('btp-abap');
    expect(classifyEdition('https://abap-system-xyz.cfapps.eu10.hana.ondemand.com')).toBe(
      'btp-abap',
    );
  });

  it('classifies custom datacenter / on-prem hosts', () => {
    expect(classifyEdition('https://sap.example.com:8100')).toBe('on-prem');
    expect(classifyEdition('https://sap.example.com.br:8000')).toBe('on-prem');
  });

  it('returns unknown for malformed urls', () => {
    expect(classifyEdition('not a url')).toBe('unknown');
  });
});
