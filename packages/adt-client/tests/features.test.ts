import { describe, expect, it } from 'vitest';
import { FEATURE_PROBES, classifyFeatureStatus } from '../src/features.js';

/**
 * classifyFeatureStatus is pure (status code → availability). probeFeatures
 * itself needs a live ADT HTTP client and is covered by smoke tests; here we
 * pin the classification table that decides "available" from the HTTP status.
 */
describe('classifyFeatureStatus', () => {
  it('treats 2xx as available with no reason', () => {
    expect(classifyFeatureStatus('rap', 200)).toEqual({ id: 'rap', available: true });
    expect(classifyFeatureStatus('rap', 204)).toEqual({ id: 'rap', available: true });
  });

  it('treats 400 / 405 / 5xx as available (endpoint exists, request dispatched)', () => {
    expect(classifyFeatureStatus('transport', 400).available).toBe(true);
    expect(classifyFeatureStatus('transport', 405).available).toBe(true);
    expect(classifyFeatureStatus('transport', 500).available).toBe(true);
  });

  it('treats 404 as unavailable (ICF not activated)', () => {
    const s = classifyFeatureStatus('ui5', 404);
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/not found|ICF/i);
  });

  it('treats 403 as unavailable but notes the endpoint exists', () => {
    const s = classifyFeatureStatus('abapGit', 403);
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/forbidden|authorization/i);
  });

  it('treats 401 as unavailable/indeterminate', () => {
    const s = classifyFeatureStatus('hana', 401);
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/auth/i);
  });

  it('covers the six expected feature ids', () => {
    expect(FEATURE_PROBES.map((p) => p.id).sort()).toEqual(
      ['abapGit', 'amdp', 'hana', 'rap', 'transport', 'ui5'].sort(),
    );
    // every probe has a non-empty endpoint
    for (const p of FEATURE_PROBES) {
      expect(p.endpoint.startsWith('/sap/bc/adt/') || p.endpoint.startsWith('/sap/')).toBe(true);
    }
  });
});
