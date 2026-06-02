import { CapituAdtClient } from './client.js';
import { classifyEdition } from './probe.js';
import type { SapEdition } from './types.js';

/**
 * Minimal profile shape the registry needs. Deliberately a structural subset
 * of @capitu/kb's InstanceProfile so this package does NOT depend on @capitu/kb
 * (the dependency direction is kb ← adt-client, never the reverse). The MCP
 * context layer, which already imports both packages, wires them together.
 */
export type RegistryAuthMode = 'basic' | 'cookie' | 'bearer';

export interface RegistryProfile {
  name: string;
  url: string;
  user: string;
  client?: string;
  language?: string;
  edition?: SapEdition;
  insecureSkipTlsVerify?: boolean;
  /** Auth strategy. Default 'basic'. */
  authMode?: RegistryAuthMode;
  // Per-instance safety (the ceiling intersection is applied in the MCP context
  // layer; the registry just carries the declared values for exposure).
  /** Explicit read-only flag from the profile (undefined = not declared). */
  readOnly?: boolean;
  /** Per-instance package allowlist from the profile (undefined = not declared). */
  allowedPackages?: string[];
}

/**
 * Per-instance safety as declared in the profile (before intersecting with the
 * env ceiling — that happens in the MCP context layer). `readOnlyDeclared` is
 * undefined when the profile didn't set `readOnly` at all, which the context
 * treats as the restrictive default.
 */
export interface InstanceSafety {
  readOnlyDeclared?: boolean;
  allowedPackages?: string[];
}

/**
 * Callbacks the registry uses to read/write shared state and resolve secrets,
 * injected so the registry stays storage-agnostic:
 *   - getActive/setActive bridge to the `meta` table in the shared SQLite KB,
 *     which is how the three separate MCP processes agree on one active system.
 *   - resolvePassword/Cookie/Bearer bridge to the env-var / file secret lookups.
 *     The registry never sees a secret until it must build a client, and never
 *     stores one. resolveCookie/resolveBearer are only called for their modes.
 */
export interface RegistryBridge {
  getActive: () => string | null;
  setActive: (name: string) => void;
  resolvePassword: (profile: RegistryProfile) => string;
  resolveCookie?: (profile: RegistryProfile) => string;
  resolveBearer?: (profile: RegistryProfile) => () => Promise<string>;
}

/** Non-secret summary of an instance — safe to return to the LLM/user. */
export interface InstanceSummary {
  name: string;
  url: string;
  user: string;
  client?: string;
  language?: string;
  edition: SapEdition;
  authMode: RegistryAuthMode;
  /** Whether the profile explicitly declared read-only (undefined = default-restrictive). */
  readOnly?: boolean;
  isActive: boolean;
}

/**
 * Resolves the *active* CapituAdtClient on demand and lets callers switch it at
 * runtime. The MCP ServerContext exposes `ctx.adt` as a getter delegating to
 * `active()`, so the ~38 existing tools keep calling `ctx.adt.search()` etc.
 * unchanged while the underlying connection can move between SAP systems.
 *
 * Clients are cached per instance name (lazy): switching to a system you've
 * used before reuses its client instead of re-authenticating. Switching away
 * tears down the previous client's session best-effort (fire-and-forget, so the
 * synchronous getter never blocks).
 */
export class InstanceRegistry {
  private readonly profiles: Map<string, RegistryProfile>;
  private readonly clients = new Map<string, CapituAdtClient>();
  private readonly bridge: RegistryBridge;
  /** Active name as of the last active() resolution — detects out-of-band switches. */
  private lastResolvedActive: string | null = null;

  constructor(profiles: RegistryProfile[], bridge: RegistryBridge) {
    this.profiles = new Map(profiles.map((p) => [p.name, p]));
    this.bridge = bridge;
  }

  /** True when at least one instance is configured. */
  get hasInstances(): boolean {
    return this.profiles.size > 0;
  }

  /**
   * Name of the currently active instance.
   *
   * Resolution order: the shared `meta` value if it names a known instance,
   * else the first configured profile (deterministic by insertion order). If
   * `meta` names an instance that no longer exists (renamed/removed), we ignore
   * the stale value and fall back to the first profile.
   */
  activeName(): string {
    const stored = this.bridge.getActive();
    if (stored && this.profiles.has(stored)) return stored;
    const first = this.profiles.keys().next().value as string | undefined;
    if (!first) {
      throw new Error(
        'No SAP instances configured. Create ~/.capitu/instances.json (or set ' +
          'CAPITU_INSTANCES_PATH), or set SAP_URL/SAP_USER for a single-instance setup.',
      );
    }
    return first;
  }

  /** Non-secret summary of every configured instance, flagging the active one. */
  list(): InstanceSummary[] {
    const active = this.profiles.size > 0 ? this.activeName() : null;
    return [...this.profiles.values()].map((p) => ({
      name: p.name,
      url: p.url,
      user: p.user,
      client: p.client,
      language: p.language,
      edition: p.edition ?? classifyEdition(p.url),
      authMode: p.authMode ?? 'basic',
      readOnly: p.readOnly,
      isActive: p.name === active,
    }));
  }

  /**
   * Declared safety of the active instance (before env-ceiling intersection).
   * The MCP context layer combines this with CAPITU_ALLOW_WRITES /
   * CAPITU_ALLOWED_PACKAGES to compute the effective gate.
   */
  activeSafety(): InstanceSafety {
    const profile = this.profiles.get(this.activeName());
    return {
      readOnlyDeclared: profile?.readOnly,
      allowedPackages: profile?.allowedPackages,
    };
  }

  /**
   * The CapituAdtClient for the active instance, building & caching it lazily.
   * If the active name changed since the last call (e.g. another MCP process
   * switched it via the shared KB), the previous client is disconnected
   * best-effort and the new one is returned.
   */
  active(): CapituAdtClient {
    const name = this.activeName();
    if (this.lastResolvedActive !== null && this.lastResolvedActive !== name) {
      // Active instance moved out from under us — release the old session.
      const prev = this.clients.get(this.lastResolvedActive);
      if (prev) void prev.disconnect().catch(() => {});
    }
    this.lastResolvedActive = name;
    return this.clientFor(name);
  }

  /**
   * Switch the active instance. Validates the name, persists it to the shared
   * KB (so the other MCP processes pick it up), and tears down the previous
   * client session best-effort. Returns the summary of the now-active instance.
   */
  async switchTo(name: string): Promise<InstanceSummary> {
    if (!this.profiles.has(name)) {
      const known = [...this.profiles.keys()].join(', ') || '(none)';
      throw new Error(`Unknown instance "${name}". Configured instances: ${known}.`);
    }
    const previous = this.activeName();
    if (previous !== name) {
      const prevClient = this.clients.get(previous);
      if (prevClient) {
        try {
          await prevClient.disconnect();
        } catch {
          // best-effort
        }
      }
    }
    this.bridge.setActive(name);
    this.lastResolvedActive = name;
    // Touch the client so a follow-up probe connects to the right system.
    this.clientFor(name);
    return this.list().find((i) => i.name === name) as InstanceSummary;
  }

  /** Disconnect every cached client. Called from server shutdown. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.disconnect().catch(() => {})));
  }

  /** Build-or-get the cached client for a named instance. */
  private clientFor(name: string): CapituAdtClient {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const profile = this.profiles.get(name);
    if (!profile) {
      throw new Error(`Unknown instance "${name}".`);
    }
    const mode = profile.authMode ?? 'basic';
    const base = {
      url: profile.url,
      user: profile.user,
      client: profile.client,
      language: profile.language,
      insecureSkipTlsVerify: profile.insecureSkipTlsVerify,
    };
    let client: CapituAdtClient;
    if (mode === 'cookie') {
      if (!this.bridge.resolveCookie) {
        throw new Error(`Instance "${name}" uses authMode "cookie" but no cookie resolver is wired.`);
      }
      client = new CapituAdtClient({
        ...base,
        password: '',
        authMode: 'cookie',
        cookie: this.bridge.resolveCookie(profile),
      });
    } else if (mode === 'bearer') {
      if (!this.bridge.resolveBearer) {
        throw new Error(`Instance "${name}" uses authMode "bearer" but no bearer resolver is wired.`);
      }
      client = new CapituAdtClient({
        ...base,
        password: '',
        authMode: 'bearer',
        bearerToken: this.bridge.resolveBearer(profile),
      });
    } else {
      client = new CapituAdtClient({
        ...base,
        password: this.bridge.resolvePassword(profile),
        authMode: 'basic',
      });
    }
    this.clients.set(name, client);
    return client;
  }
}
