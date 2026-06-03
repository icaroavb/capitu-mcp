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
 * Effective write gate for the ACTIVE instance.
 *
 * Ceiling model: the server-wide env (CAPITU_ALLOW_WRITES /
 * CAPITU_ALLOWED_PACKAGES) is the maximum; a per-instance profile can only
 * restrict further. When a profile does not declare `readOnly`, the default is
 * restrictive (writes blocked) and `restrictedByDefault` is set so error
 * messages can explain how to opt in.
 */
export interface WriteGate {
  allowed: boolean;
  allowedPackages: string[];
  /** True when writes are off solely because the active profile didn't declare readOnly:false. */
  restrictedByDefault: boolean;
}

/**
 * ServerContext for capitu-dev.
 *
 * `adt` and `writes` are GETTERS backed by `registry`: they resolve against the
 * currently-active SAP instance. Tools call `ctx.adt.*` / read `ctx.writes`
 * unchanged; switching instance at runtime (capituDevUseInstance) changes both
 * without a restart, and the change propagates across docs/dev/spec via the KB.
 */
export interface ServerContext {
  kb: Database;
  embeddings: EmbeddingsProvider;
  /** Active SAP client. Resolved dynamically from `registry` — do not cache. */
  adt: CapituAdtClient;
  registry: InstanceRegistry;
  compliance: ComplianceContext;
  agent: 'capitu-dev';
  /** Effective write gate for the active instance (env ∩ profile). Getter. */
  writes: WriteGate;
  /** Name of the active instance — for error messages. Getter. */
  activeProfileName: string;
  /** Tool-visibility map from instances.json (tool→enabled). Undefined = all on. */
  toolVisibility?: Record<string, boolean>;
}

export interface ServerContextOptions {
  kbPath?: string;
  embeddings?: EmbeddingsProvider;
}

/** Server-wide write ceiling from env. The profile can only narrow this. */
interface EnvCeiling {
  allowWrites: boolean;
  allowedPackages: string[];
}

function readEnvCeiling(): EnvCeiling {
  return {
    allowWrites: process.env.CAPITU_ALLOW_WRITES === 'true',
    allowedPackages: (process.env.CAPITU_ALLOWED_PACKAGES ?? '$TMP')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Compute the effective write gate for the active instance by intersecting the
 * env ceiling with the active profile's declared safety.
 *
 *   - writes allowed only if env allows AND the profile is not read-only.
 *   - profile readOnly undefined → restrictive default (blocked), flagged.
 *   - allowedPackages: profile list (if any) narrowed to what env permits;
 *     omitted → inherit the env list.
 */
function computeWriteGate(registry: InstanceRegistry, ceiling: EnvCeiling): WriteGate {
  const safety = registry.activeSafety();
  const profileReadOnly = safety.readOnlyDeclared; // boolean | undefined
  const restrictedByDefault = profileReadOnly === undefined;
  const profileAllowsWrites = profileReadOnly === false; // only an explicit false opens it
  const allowed = ceiling.allowWrites && profileAllowsWrites;

  // Packages: profile narrows the env list; if the profile didn't declare any,
  // inherit env. Intersection keeps only env-permitted patterns the profile lists.
  let allowedPackages: string[];
  if (safety.allowedPackages && safety.allowedPackages.length > 0) {
    allowedPackages = safety.allowedPackages.filter((p) =>
      isPackageAllowed(p.endsWith('*') ? p.slice(0, -1) || '$' : p, ceiling.allowedPackages),
    );
    // If the profile listed packages but none survive the env ceiling, the
    // gate is effectively empty (nothing writable) — keep it empty, not env.
  } else {
    allowedPackages = ceiling.allowedPackages;
  }

  return { allowed, allowedPackages, restrictedByDefault };
}

export function buildContext(opts: ServerContextOptions = {}): ServerContext {
  const kb = openKb({ path: opts.kbPath });
  const { registry, toolVisibility } = buildInstanceRegistry(kb);
  const embeddings = opts.embeddings ?? resolveEmbeddingsProvider();
  const compliance = loadComplianceFromEnv();
  const ceiling = readEnvCeiling();

  const ctx = {
    kb,
    embeddings,
    registry,
    compliance,
    agent: 'capitu-dev' as const,
    toolVisibility,
  };
  // `adt`, `writes`, `activeProfileName` resolve against the active instance on
  // every access, so a runtime switch is reflected without rebuilding ctx.
  Object.defineProperty(ctx, 'adt', { enumerable: true, get: () => registry.active() });
  Object.defineProperty(ctx, 'writes', {
    enumerable: true,
    get: () => computeWriteGate(registry, ceiling),
  });
  Object.defineProperty(ctx, 'activeProfileName', {
    enumerable: true,
    get: () => registry.activeName(),
  });
  return ctx as ServerContext;
}

/**
 * Wire a registry from the configured instance profiles + the shared KB, and
 * surface the tool-visibility map. Profiles carry per-instance safety + auth;
 * passwords/cookies/tokens are resolved lazily, never read here.
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

/**
 * Canonical write gate for all dev-mcp write tools. Throws with an actionable,
 * instance-aware message. Centralized here (single source of truth) so the
 * three write tools (write/service/edit-method) never drift.
 *
 * Two distinct denials, each with its own remedy:
 *   1. `restrictedByDefault` — the ACTIVE instance's profile didn't declare
 *      `readOnly: false`, so writes default off (the safe default the user
 *      chose). The fix is per-instance, no restart needed.
 *   2. Package not in the (env ∩ profile) allowlist — explain which list
 *      blocked it and how to widen the right one.
 */
export function assertWritesEnabled(ctx: ServerContext, packageName: string | undefined): void {
  const inst = ctx.activeProfileName;
  if (!ctx.writes.allowed) {
    if (ctx.writes.restrictedByDefault) {
      throw new Error(
        `Writes to instance "${inst}" are blocked: this instance is in READ-ONLY-BY-DEFAULT mode because its profile does not explicitly allow writes. This is the safe default for a newly-configured system.\n\nTo enable writes for this instance:\n  1. Edit ~/.capitu/instances.json, find the instance "${inst}", and add:\n       "readOnly": false,\n       "allowedPackages": ["$TMP", "Z*"]   (adjust to your sandbox packages)\n  2. Save the file.\n  3. Run capituDevUseInstance("${inst}") again — the profile is re-read, NO restart needed.\n\nNote: writes also require the server-wide ceiling CAPITU_ALLOW_WRITES=true; a profile can only narrow that ceiling, never widen it.`,
      );
    }
    throw new Error(
      `Writes are disabled by the server-wide ceiling for instance "${inst}". Set CAPITU_ALLOW_WRITES=true in the capitu-dev env (.mcp.json) and relaunch Claude Code. The per-instance profile may also need "readOnly": false.`,
    );
  }
  if (!packageName) {
    throw new Error(
      `Cannot determine the target package for the write to instance "${inst}" — blocked. Pass packageName explicitly.`,
    );
  }
  if (!isPackageAllowed(packageName, ctx.writes.allowedPackages)) {
    throw new Error(
      `Package '${packageName}' is not in the effective allowlist for instance "${inst}" (currently [${ctx.writes.allowedPackages.join(', ') || '(empty)'}]). This is the intersection of the server ceiling (CAPITU_ALLOWED_PACKAGES) and the instance profile\'s allowedPackages.\n\nTo allow it:\n  - If the instance profile lists packages: edit ~/.capitu/instances.json → "${inst}".allowedPackages, add '${packageName}' (wildcards like 'Z*' work), then capituDevUseInstance("${inst}") again (no restart).\n  - If the server ceiling is the blocker: widen CAPITU_ALLOWED_PACKAGES in .mcp.json and relaunch.\nThe allowlist is a deliberate safety gate against accidental writes to system namespaces.`,
    );
  }
}
