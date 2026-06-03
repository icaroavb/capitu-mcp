import { type CapituAdtClient, InstanceRegistry, type RegistryProfile } from '@capitu/adt-client';
import {
  type ComplianceContext,
  type EmbeddingsProvider,
  getActiveInstance,
  loadComplianceFromEnv,
  loadInstanceProfiles,
  openKb,
  resolveBearer,
  resolveCookie,
  resolveEmbeddingsProvider,
  resolvePassword,
  setActiveInstance,
} from '@capitu/kb';
import type { Database } from 'better-sqlite3';

/**
 * Spec agent context. Mirrors docs-mcp/dev-mcp shape so the KB / embeddings /
 * compliance gate work identically. The agent identifier is 'capitu-spec' so
 * learnings/traces are attributable.
 *
 * Spec needs ADT for validate / impactAnalysis but never writes. Most tools
 * are pure: requirement in, structured markdown out.
 *
 * `adt` is a getter backed by `registry` — see docs/dev context for the
 * runtime instance-switching rationale.
 */
export interface ServerContext {
  kb: Database;
  embeddings: EmbeddingsProvider;
  /** Active SAP client. Resolved dynamically from `registry` — do not cache. */
  adt: CapituAdtClient;
  registry: InstanceRegistry;
  compliance: ComplianceContext;
  agent: 'capitu-spec';
  /** Tool-visibility map from instances.json (tool→enabled). Undefined = all on. */
  toolVisibility?: Record<string, boolean>;
}

export interface ServerContextOptions {
  kbPath?: string;
  embeddings?: EmbeddingsProvider;
}

export function buildContext(opts: ServerContextOptions = {}): ServerContext {
  const kb = openKb({ path: opts.kbPath });
  const { registry, toolVisibility } = buildInstanceRegistry(kb);
  const embeddings = opts.embeddings ?? resolveEmbeddingsProvider();
  const compliance = loadComplianceFromEnv();

  const ctx = {
    kb,
    embeddings,
    registry,
    compliance,
    agent: 'capitu-spec' as const,
    toolVisibility,
  };
  Object.defineProperty(ctx, 'adt', {
    enumerable: true,
    get: () => registry.active(),
  });
  return ctx as ServerContext;
}

/**
 * Wire a registry from the configured instance profiles + the shared KB, and
 * surface the tool-visibility map. Profiles from ~/.capitu/instances.json (or
 * SAP_* fallback); active-instance pointer in the KB `meta` table; passwords/
 * cookies/tokens resolved lazily.
 */
export function buildInstanceRegistry(kb: Database): {
  registry: InstanceRegistry;
  toolVisibility?: Record<string, boolean>;
} {
  const { instances, tools } = loadInstanceProfiles();
  const byName = new Map(instances.map((p) => [p.name, p]));
  const profiles: RegistryProfile[] = instances.map((p) => ({
    name: p.name,
    url: p.url,
    user: p.user,
    client: p.client,
    language: p.language,
    edition: p.edition,
    insecureSkipTlsVerify: p.insecureSkipTlsVerify,
    authMode: p.authMode,
    readOnly: p.readOnly,
    allowedPackages: p.allowedPackages,
  }));
  const lookup = (name: string) => byName.get(name) ?? { name, url: '', user: '' };
  const registry = new InstanceRegistry(profiles, {
    getActive: () => getActiveInstance(kb),
    setActive: (name) => setActiveInstance(kb, name),
    resolvePassword: (profile) => resolvePassword(lookup(profile.name)),
    resolveCookie: (profile) => resolveCookie(lookup(profile.name)),
    resolveBearer: (profile) => resolveBearer(lookup(profile.name)),
  });
  return { registry, toolVisibility: tools };
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
