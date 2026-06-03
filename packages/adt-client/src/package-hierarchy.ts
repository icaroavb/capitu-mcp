/**
 * DEVCLASS hierarchy resolver for `allowedPackages` subtree rules (`ZFOO/**`).
 *
 * Ported from ARC-1's `src/adt/package-hierarchy.ts`. Pattern semantics:
 *   - `ZFOO/**` = package `ZFOO` and every transitive sub-package whose
 *     DEVCLASS chain (`TDEVC.PARENTCL`) leads back to `ZFOO`.
 *   - Direct children come from a `DirectSubpackageFetcher` (the MCP layer wires
 *     it to `CapituAdtClient.getSubpackages`, so this module stays HTTP-agnostic).
 *
 * Security invariants:
 *   - Resolution failure (network, permission, missing root) is **fail-closed**:
 *     the resolver throws and the caller MUST treat the throw as "package denied".
 *     Never silently allow.
 *   - A rejected resolution purges its cache entry so a retry can succeed, but
 *     the current request still fails (no cementing a transient failure).
 *   - Caps on depth + size guard against a corrupted TDEVC cycle.
 */

export interface PackageHierarchyResolver {
  /**
   * True iff `pkg` is `root` itself or a descendant of `root`. Case-insensitive.
   * Throws on resolution failure — callers MUST treat a throw as fail-closed.
   */
  isDescendantOrSelf(root: string, pkg: string): Promise<boolean>;
  /** Drop cached subtrees. With no arg, clears everything. */
  invalidate(root?: string): void;
}

/** Returns the direct sub-packages of `root` (names; case is normalized here). */
export type DirectSubpackageFetcher = (root: string) => Promise<string[]>;

interface CacheEntry {
  expires: number;
  subtree: Promise<Set<string>>;
}

export interface PackageHierarchyResolverOptions {
  /** Cache lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
  /** Cap on subtree size; exceeding it fails closed. Default 10000. */
  maxPackages?: number;
  /** Cap on BFS depth; exceeding it fails closed (cycle guard). Default 50. */
  maxDepth?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PACKAGES = 10_000;
const DEFAULT_MAX_DEPTH = 50;

export class AdtPackageHierarchyResolver implements PackageHierarchyResolver {
  private readonly fetcher: DirectSubpackageFetcher;
  private readonly ttlMs: number;
  private readonly maxPackages: number;
  private readonly maxDepth: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(fetcher: DirectSubpackageFetcher, opts: PackageHierarchyResolverOptions = {}) {
    this.fetcher = fetcher;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPackages = opts.maxPackages ?? DEFAULT_MAX_PACKAGES;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  async isDescendantOrSelf(root: string, pkg: string): Promise<boolean> {
    const upperRoot = root.toUpperCase();
    const upperPkg = pkg.toUpperCase();
    if (upperRoot === upperPkg) return true;
    const subtree = await this.getSubtree(upperRoot);
    return subtree.has(upperPkg);
  }

  invalidate(root?: string): void {
    if (root === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(root.toUpperCase());
  }

  private getSubtree(upperRoot: string): Promise<Set<string>> {
    const now = Date.now();
    const cached = this.cache.get(upperRoot);
    if (cached && cached.expires > now) return cached.subtree;

    const subtree = this.computeSubtree(upperRoot).catch((err: unknown) => {
      // Fail-closed: purge so a retry can succeed; rethrow with a clear message
      // at the safety boundary.
      this.cache.delete(upperRoot);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to resolve DEVCLASS subtree under '${upperRoot}' for an allowedPackages ` +
          `'${upperRoot}/**' rule (denying the write for safety): ${msg}`,
      );
    });
    this.cache.set(upperRoot, { expires: now + this.ttlMs, subtree });
    return subtree;
  }

  private async computeSubtree(upperRoot: string): Promise<Set<string>> {
    const result = new Set<string>([upperRoot]);
    let frontier: string[] = [upperRoot];
    let depth = 0;
    while (frontier.length > 0) {
      if (depth >= this.maxDepth) {
        throw new Error(
          `DEVCLASS hierarchy under '${upperRoot}' exceeds maxDepth=${this.maxDepth} (possible TDEVC cycle)`,
        );
      }
      const nextFrontier: string[] = [];
      for (const cur of frontier) {
        const children = await this.fetcher(cur);
        for (const child of children) {
          const upper = child.toUpperCase();
          if (result.has(upper)) continue;
          result.add(upper);
          if (result.size > this.maxPackages) {
            throw new Error(
              `DEVCLASS subtree under '${upperRoot}' exceeds maxPackages=${this.maxPackages}; refusing for safety`,
            );
          }
          nextFrontier.push(upper);
        }
      }
      frontier = nextFrontier;
      depth++;
    }
    return result;
  }
}

/**
 * Subtree-aware package allowlist check.
 *
 * Plain patterns (exact / trailing-`*`) are matched synchronously by the caller;
 * this async path only handles `X/**` subtree rules, which need the resolver.
 * Returns true if `pkg` matches any subtree rule. Throws (fail-closed) only if a
 * subtree rule's resolution fails — the caller denies on throw.
 */
export async function matchesSubtreeRule(
  pkg: string,
  patterns: string[],
  resolver: PackageHierarchyResolver,
): Promise<boolean> {
  for (const p of patterns) {
    if (!p.endsWith('/**')) continue;
    const root = p.slice(0, -3);
    if (await resolver.isDescendantOrSelf(root, pkg)) return true;
  }
  return false;
}
