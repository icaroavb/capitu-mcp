import { type CapituAdtClient, InstanceRegistry, type RegistryProfile } from '@capitu/adt-client';
import {
  type ComplianceContext,
  type EmbeddingsProvider,
  getActiveInstance,
  loadComplianceFromEnv,
  loadInstanceProfiles,
  openKb,
  resolveEmbeddingsProvider,
  resolvePassword,
  setActiveInstance,
} from '@capitu/kb';
import type { Database } from 'better-sqlite3';

/**
 * ServerContext for capitu-dev.
 *
 * The shape mirrors @capitu/docs-mcp's context — same KB, same compliance gate,
 * same embeddings — but the agent identifier differs so that traces and
 * learnings recorded from dev are attributable.
 *
 * Plus: a writes-allowed flag and a package allowlist used by write tools.
 *
 * `adt` is a GETTER backed by `registry`: it resolves the CapituAdtClient of
 * the currently-active SAP instance. Tools call `ctx.adt.*` unchanged; the
 * underlying connection can be switched at runtime (capituDevUseInstance) and
 * the change propagates across the docs/dev/spec processes via the shared KB.
 */
export interface ServerContext {
  kb: Database;
  embeddings: EmbeddingsProvider;
  /** Active SAP client. Resolved dynamically from `registry` — do not cache. */
  adt: CapituAdtClient;
  registry: InstanceRegistry;
  compliance: ComplianceContext;
  agent: 'capitu-dev';
  writes: {
    allowed: boolean;
    allowedPackages: string[]; // glob-ish patterns: '$TMP', 'Z*', 'ZSANDBOX_PKG'
  };
}

export interface ServerContextOptions {
  kbPath?: string;
  embeddings?: EmbeddingsProvider;
}

export function buildContext(opts: ServerContextOptions = {}): ServerContext {
  const kb = openKb({ path: opts.kbPath });
  const registry = buildInstanceRegistry(kb);
  const embeddings = opts.embeddings ?? resolveEmbeddingsProvider();
  const compliance = loadComplianceFromEnv();

  const writesAllowed = process.env.CAPITU_ALLOW_WRITES === 'true';
  const allowedPackages = (process.env.CAPITU_ALLOWED_PACKAGES ?? '$TMP')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const ctx = {
    kb,
    embeddings,
    registry,
    compliance,
    agent: 'capitu-dev' as const,
    writes: { allowed: writesAllowed, allowedPackages },
  };
  // `adt` resolves the active instance's client on every access.
  Object.defineProperty(ctx, 'adt', {
    enumerable: true,
    get: () => registry.active(),
  });
  return ctx as ServerContext;
}

/**
 * Wire a registry from the configured instance profiles + the shared KB.
 *
 * Profiles come from ~/.capitu/instances.json (or the SAP_* env-var fallback);
 * the active-instance pointer lives in the KB `meta` table so all three MCP
 * processes agree on one system. Passwords are resolved lazily from env vars,
 * never read here.
 */
export function buildInstanceRegistry(kb: Database): InstanceRegistry {
  const { instances } = loadInstanceProfiles();
  const profiles: RegistryProfile[] = instances.map((p) => ({
    name: p.name,
    url: p.url,
    user: p.user,
    client: p.client,
    language: p.language,
    edition: p.edition,
    insecureSkipTlsVerify: p.insecureSkipTlsVerify,
  }));
  const byName = new Map(instances.map((p) => [p.name, p]));
  return new InstanceRegistry(profiles, {
    getActive: () => getActiveInstance(kb),
    setActive: (name) => setActiveInstance(kb, name),
    resolvePassword: (profile) => {
      const full = byName.get(profile.name);
      // full is always present (same source list); fall back defensively.
      return resolvePassword(full ?? { name: profile.name, url: profile.url, user: profile.user });
    },
  });
}

export async function shutdownContext(ctx: ServerContext): Promise<void> {
  try {
    await ctx.registry.disconnectAll();
  } catch {
    // best-effort
  }
  try {
    ctx.kb.close();
  } catch {
    // best-effort
  }
}

/**
 * Tests whether a package name matches one of the configured allowlist patterns.
 * Patterns support a single trailing '*' wildcard (e.g. 'Z*' matches 'ZFOO', 'ZBAR').
 * Exact match also works ('$TMP' matches only '$TMP').
 */
export function isPackageAllowed(packageName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (packageName.startsWith(prefix)) return true;
    } else if (packageName === p) {
      return true;
    }
  }
  return false;
}
