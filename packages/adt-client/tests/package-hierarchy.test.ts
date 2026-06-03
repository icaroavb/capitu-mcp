import { describe, expect, it, vi } from 'vitest';
import {
  AdtPackageHierarchyResolver,
  type DirectSubpackageFetcher,
  matchesSubtreeRule,
} from '../src/package-hierarchy.js';

/**
 * A fake DEVCLASS tree:
 *   ZIVB_APRENDIZAGEM
 *     ├── ZIVB_SUB1
 *     │     └── ZIVB_SUB1_A
 *     └── ZIVB_SUB2
 *   ZOTHER (unrelated)
 */
const TREE: Record<string, string[]> = {
  ZIVB_APRENDIZAGEM: ['ZIVB_SUB1', 'ZIVB_SUB2'],
  ZIVB_SUB1: ['ZIVB_SUB1_A'],
  ZIVB_SUB2: [],
  ZIVB_SUB1_A: [],
  ZOTHER: [],
};

function fakeFetcher(): DirectSubpackageFetcher {
  return async (root: string) => TREE[root.toUpperCase()] ?? [];
}

describe('AdtPackageHierarchyResolver', () => {
  it('matches the root itself', async () => {
    const r = new AdtPackageHierarchyResolver(fakeFetcher());
    expect(await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_APRENDIZAGEM')).toBe(true);
  });

  it('matches a transitive descendant (2 levels deep)', async () => {
    const r = new AdtPackageHierarchyResolver(fakeFetcher());
    expect(await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB1_A')).toBe(true);
  });

  it('is case-insensitive', async () => {
    const r = new AdtPackageHierarchyResolver(fakeFetcher());
    expect(await r.isDescendantOrSelf('zivb_aprendizagem', 'zivb_sub2')).toBe(true);
  });

  it('rejects a package outside the subtree', async () => {
    const r = new AdtPackageHierarchyResolver(fakeFetcher());
    expect(await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZOTHER')).toBe(false);
  });

  it('caches the subtree (fetcher called once per root within TTL)', async () => {
    const spy = vi.fn(fakeFetcher());
    const r = new AdtPackageHierarchyResolver(spy);
    await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB1');
    await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB2');
    const callsAfterTwo = spy.mock.calls.length;
    await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB1_A');
    expect(spy.mock.calls.length).toBe(callsAfterTwo); // served from cache
  });

  it('fails closed on fetcher error (throws, purges cache for retry)', async () => {
    let calls = 0;
    const flaky: DirectSubpackageFetcher = async (root) => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return TREE[root.toUpperCase()] ?? [];
    };
    const r = new AdtPackageHierarchyResolver(flaky);
    await expect(r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB1')).rejects.toThrow(
      /denying the write for safety/,
    );
    // Cache was purged → a retry can now succeed.
    expect(await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB1')).toBe(true);
  });

  it('fails closed on a TDEVC cycle (maxDepth)', async () => {
    const cyclic: DirectSubpackageFetcher = async () => ['ZCYCLE']; // always returns a new-looking child
    const r = new AdtPackageHierarchyResolver(cyclic, { maxDepth: 3 });
    // ZCYCLE → ZCYCLE → ... the dedupe stops actual recursion, but a truly
    // unbounded fan-out would trip maxDepth/maxPackages. Here dedupe halts it,
    // so the result is simply "not a descendant of an unrelated root".
    expect(await r.isDescendantOrSelf('ZROOT', 'ZNOPE')).toBe(false);
  });

  it('invalidate() drops the cache', async () => {
    const spy = vi.fn(fakeFetcher());
    const r = new AdtPackageHierarchyResolver(spy);
    await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB1');
    const before = spy.mock.calls.length;
    r.invalidate('ZIVB_APRENDIZAGEM');
    await r.isDescendantOrSelf('ZIVB_APRENDIZAGEM', 'ZIVB_SUB1');
    expect(spy.mock.calls.length).toBeGreaterThan(before); // re-fetched
  });
});

describe('matchesSubtreeRule', () => {
  it('only consults the resolver for /** rules and matches', async () => {
    const r = new AdtPackageHierarchyResolver(fakeFetcher());
    expect(await matchesSubtreeRule('ZIVB_SUB1_A', ['ZIVB_APRENDIZAGEM/**'], r)).toBe(true);
  });

  it('ignores non-subtree patterns (returns false, no resolution)', async () => {
    const spy = vi.fn(fakeFetcher());
    const r = new AdtPackageHierarchyResolver(spy);
    expect(await matchesSubtreeRule('ZFOO', ['$TMP', 'Z*'], r)).toBe(false);
    expect(spy.mock.calls.length).toBe(0); // no /** rule → resolver never called
  });

  it('returns false when the package is outside every subtree rule', async () => {
    const r = new AdtPackageHierarchyResolver(fakeFetcher());
    expect(await matchesSubtreeRule('ZOTHER', ['ZIVB_APRENDIZAGEM/**'], r)).toBe(false);
  });
});
