import { execFileSync } from 'node:child_process';

/**
 * Windows User-scope environment fallback.
 *
 * Why this exists: MCP clients (Claude Desktop in particular) launch stdio
 * servers with a SANITIZED environment — a curated PATH plus whatever the
 * config's `env` block declares. Persistent User env vars set via
 * `[Environment]::SetEnvironmentVariable(..., "User")` therefore never reach
 * the server process, even though they exist in the registry and in every
 * normally-spawned shell. Since capitu's security model deliberately keeps
 * credentials OUT of files (passwords live only in User env vars — see
 * instances.ts), the servers must be able to read that scope directly.
 *
 * `readUserScopeEnv` queries `HKCU\Environment` via `reg.exe` (always present
 * on Windows; no native deps). Results — including misses — are cached for the
 * process lifetime: these are boot-time config values, not live state.
 *
 * Non-Windows platforms always resolve undefined (POSIX has no equivalent
 * scope; there the process environment is the single source of truth).
 */

const cache = new Map<string, string | undefined>();

/**
 * Extract the value from `reg query HKCU\Environment /v NAME` output, e.g.:
 *
 *   HKEY_CURRENT_USER\Environment
 *       SAP_URL    REG_SZ    https://host:8100
 *
 * Returns undefined when no REG_SZ/REG_EXPAND_SZ line is present or the value
 * is empty. REG_EXPAND_SZ values are returned VERBATIM (no %VAR% expansion) —
 * fine for the credentials/URLs this fallback targets.
 */
export function parseRegQueryValue(output: string): string | undefined {
  const match = output.match(/\sREG_(?:EXPAND_)?SZ\s+(.+)/);
  const value = match?.[1]?.trim();
  return value || undefined;
}

/** Read one User-scope env var from the Windows registry. Undefined off-Windows or on any error. */
export function readUserScopeEnv(name: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (cache.has(name)) return cache.get(name);
  let value: string | undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    value = parseRegQueryValue(out);
  } catch {
    value = undefined; // var absent (reg exits 1) or reg unavailable — treat as unset
  }
  cache.set(name, value);
  return value;
}

/** Test seam: drop the memoized values (e.g. after mutating the registry). */
export function clearUserScopeEnvCache(): void {
  cache.clear();
}

/**
 * Env lookup with the Windows User-scope fallback. MCP clients (notably Claude
 * Desktop) launch servers with a sanitized environment, so persistent User vars
 * don't arrive via process.env — see the module doc above.
 *
 * The fallback engages ONLY when `env` IS `process.env` (identity check): tests
 * pass crafted env objects and must never observe the developer machine's
 * registry, regardless of what they contain.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  return env === process.env ? readUserScopeEnv(name) : undefined;
}
