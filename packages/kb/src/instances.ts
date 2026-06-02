import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';

/**
 * Named SAP instance profiles for consultant-style multi-system use.
 *
 * Why this exists: the original design baked a single SAP connection into the
 * env vars read at server boot (SAP_URL/SAP_USER/…). A consultant works across
 * many systems and needs to switch the active instance at runtime, without
 * editing .mcp.json and restarting Claude Code. This module owns the
 * persistence side of that feature:
 *
 *   1. Loading the profile list from ~/.capitu/instances.json (or
 *      CAPITU_INSTANCES_PATH), with a backward-compatible fallback that
 *      synthesizes a single 'env' instance from the legacy SAP_* env vars.
 *   2. Reading/writing which instance is *active* in the shared `meta` table —
 *      the only channel the three separate MCP processes (docs/dev/spec) share.
 *      A switch in one process is observed by the others on their next tool
 *      call, giving a single coherent instance view across the ecosystem.
 *
 * Crucially, passwords NEVER live in the JSON. Each profile names an env var
 * (`passwordEnv`) whose value is the password — kept in the OS keychain / a
 * persistent Windows User env var, never in a file that could be committed.
 */

export const ACTIVE_INSTANCE_META_KEY = 'active_instance';

export type SapEditionHint = 'on-prem' | 'pce' | 'public-cloud' | 'btp-abap' | 'unknown';

export interface InstanceProfile {
  /** Stable handle the user types: "cliente-x-dev", "qas", … */
  name: string;
  url: string;
  user: string;
  client?: string;
  /** Logon language (PT/EN/DE). Must match the system's install language for writes. */
  language?: string;
  /** Optional explicit edition; when absent, callers infer it from the URL. */
  edition?: SapEditionHint;
  /**
   * Name of the environment variable holding this instance's password.
   * Defaults to 'SAP_PASSWORD' so a single-instance setup keeps working.
   * The password itself is NEVER stored here.
   */
  passwordEnv?: string;
  /** Allow self-signed certs (sandbox only). */
  insecureSkipTlsVerify?: boolean;
}

export interface InstanceProfilesResult {
  instances: InstanceProfile[];
  /** Initial active instance declared in the file, if any. */
  active?: string;
  /** Where the profiles came from — useful for diagnostics. */
  source: 'file' | 'env-fallback' | 'empty';
  /** Absolute path consulted (even if it didn't exist). */
  path: string;
}

/** Resolve the instances.json path: explicit env override, else ~/.capitu/instances.json. */
export function instancesPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CAPITU_INSTANCES_PATH;
  if (override?.trim()) return override.trim();
  return join(homedir(), '.capitu', 'instances.json');
}

/**
 * Load instance profiles.
 *
 * Order of precedence:
 *   1. instances.json (CAPITU_INSTANCES_PATH or ~/.capitu/instances.json).
 *   2. Backward-compatible fallback: a single instance named 'env' built from
 *      SAP_URL/SAP_USER/SAP_CLIENT/SAP_LANGUAGE (password via SAP_PASSWORD).
 *   3. Empty list (no file, no SAP_URL) — callers decide whether that's fatal.
 *
 * The JSON is validated structurally; a malformed file throws with a clear
 * message rather than silently falling back (so the user fixes the typo).
 */
export function loadInstanceProfiles(env: NodeJS.ProcessEnv = process.env): InstanceProfilesResult {
  const path = instancesPath(env);
  let raw: string | undefined;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // File absent — fall back to env vars below.
    raw = undefined;
  }

  if (raw !== undefined) {
    const instances = parseInstancesFile(raw, path);
    let parsedActive: string | undefined;
    try {
      const obj = JSON.parse(raw) as { active?: unknown };
      if (typeof obj.active === 'string' && obj.active.trim()) parsedActive = obj.active.trim();
    } catch {
      // parseInstancesFile already threw on invalid JSON; unreachable.
    }
    return { instances, active: parsedActive, source: 'file', path };
  }

  // Fallback: synthesize one instance from legacy env vars.
  const url = env.SAP_URL;
  const user = env.SAP_USER;
  if (url && user) {
    return {
      instances: [
        {
          name: 'env',
          url,
          user,
          client: env.SAP_CLIENT,
          language: env.SAP_LANGUAGE,
          passwordEnv: 'SAP_PASSWORD',
        },
      ],
      active: 'env',
      source: 'env-fallback',
      path,
    };
  }

  return { instances: [], source: 'empty', path };
}

/** Parse + validate the `instances` array of the JSON file. Throws on malformed input. */
function parseInstancesFile(raw: string, path: string): InstanceProfile[] {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `instances file at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const arr = (obj as { instances?: unknown }).instances;
  if (!Array.isArray(arr)) {
    throw new Error(`instances file at ${path} must have an "instances" array.`);
  }
  const seen = new Set<string>();
  return arr.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const url = typeof e.url === 'string' ? e.url.trim() : '';
    const user = typeof e.user === 'string' ? e.user.trim() : '';
    if (!name) throw new Error(`instances[${i}] in ${path} is missing "name".`);
    if (!url) throw new Error(`instance "${name}" in ${path} is missing "url".`);
    if (!user) throw new Error(`instance "${name}" in ${path} is missing "user".`);
    if (seen.has(name)) throw new Error(`instance name "${name}" is duplicated in ${path}.`);
    seen.add(name);
    return {
      name,
      url,
      user,
      client: typeof e.client === 'string' ? e.client : undefined,
      language: typeof e.language === 'string' ? e.language : undefined,
      edition: typeof e.edition === 'string' ? (e.edition as SapEditionHint) : undefined,
      passwordEnv:
        typeof e.passwordEnv === 'string' && e.passwordEnv.trim()
          ? e.passwordEnv.trim()
          : 'SAP_PASSWORD',
      insecureSkipTlsVerify: e.insecureSkipTlsVerify === true,
    };
  });
}

/** Read the active instance name from the shared `meta` table. Null if unset. */
export function getActiveInstance(db: Database): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(ACTIVE_INSTANCE_META_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Persist the active instance name into the shared `meta` table (upsert). */
export function setActiveInstance(db: Database, name: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(ACTIVE_INSTANCE_META_KEY, name);
}

/**
 * Resolve a profile's password from its env var. Throws a semantic error when
 * the var is missing so the caller can tell the user exactly which variable to
 * set, instead of failing later with an opaque 401 from SAP.
 */
export function resolvePassword(
  profile: InstanceProfile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const varName = profile.passwordEnv ?? 'SAP_PASSWORD';
  const value = env[varName];
  if (!value) {
    throw new Error(
      `Password for instance "${profile.name}" not found: environment variable ` +
        `${varName} is unset. Set it as a persistent User env var and reopen Claude Code.`,
    );
  }
  return value;
}
