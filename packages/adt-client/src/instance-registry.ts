import { CapituAdtClient } from './client.js';
import { classifyEdition } from './probe.js';
import type { SapEdition } from './types.js';

/**
 * Minimal profile shape the registry needs. Deliberately a structural subset
 * of @capitu/kb's InstanceProfile so this package does NOT depend on @capitu/kb
 * (the dependency direction is kb ← adt-client, never the reverse). The MCP
 * context layer, which already imports both packages, wires them together.
 */
export interface RegistryProfile {
  name: string;
  url: string;
  user: string;
  client?: string;
  language?: string;
  edition?: SapEdition;
  insecureSkipTlsVerify?: boolean;
}

/**
 * Callbacks the registry uses to read/write shared state and resolve secrets,
 * injected so the registry stays storage-agnostic:
 *   - getActive/setActive bridge to the `meta` table in the shared SQLite KB,
 *     which is how the three separate MCP processes agree on one active system.
 *   - resolvePassword bridges to the env-var password lookup. The registry
 *     never sees a password until it must build a client, and never stores one.
 */
export interface RegistryBridge {
  getActive: () => string | null;
  setActive: (name: string) => void;
  resolvePassword: (profile: RegistryProfile) => string;
}

/** Non-secret summary of an instance — safe to return to the LLM/user. */
export interface InstanceSummary {
  name: string;
  url: string;
  user: string;
  client?: string;
  language?: string;
  edition: SapEdition;
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
      isActive: p.name === active,
    }));
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
    const client = new CapituAdtClient({
      url: profile.url,
      user: profile.user,
      password: this.bridge.resolvePassword(profile),
      client: profile.client,
      language: profile.language,
      insecureSkipTlsVerify: profile.insecureSkipTlsVerify,
    });
    this.clients.set(name, client);
    return client;
  }
}
