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

export interface ServerContext {
  kb: Database;
  embeddings: EmbeddingsProvider;
  /** Active SAP client. Resolved dynamically from `registry` — do not cache. */
  adt: CapituAdtClient;
  registry: InstanceRegistry;
  compliance: ComplianceContext;
  agent: 'capitu-docs';
}

export interface ServerContextOptions {
  /** Path to the shared KB SQLite file. Defaults to env CAPITU_KB_PATH. */
  kbPath?: string;
  /** Override embeddings provider (tests pass FakeEmbeddings). */
  embeddings?: EmbeddingsProvider;
}

export function buildContext(opts: ServerContextOptions = {}): ServerContext {
  const kb = openKb({ path: opts.kbPath });
  const registry = buildInstanceRegistry(kb);
  const embeddings = opts.embeddings ?? resolveEmbeddingsProvider();
  const compliance = loadComplianceFromEnv();

  const ctx = { kb, embeddings, registry, compliance, agent: 'capitu-docs' as const };
  // `adt` resolves the active instance's client on every access.
  Object.defineProperty(ctx, 'adt', {
    enumerable: true,
    get: () => registry.active(),
  });
  return ctx as ServerContext;
}

/**
 * Wire a registry from the configured instance profiles + the shared KB.
 * Profiles from ~/.capitu/instances.json (or SAP_* fallback); active-instance
 * pointer in the KB `meta` table (shared across the 3 MCP processes); passwords
 * resolved lazily from env vars.
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
    resolvePassword: (profile) =>
      resolvePassword(
        byName.get(profile.name) ?? { name: profile.name, url: profile.url, user: profile.user },
      ),
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
