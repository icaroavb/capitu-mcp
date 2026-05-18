import type { CapituAdtClient } from './client.js';
import type { ProbedEnvironment, SapEdition } from './types.js';

/**
 * Probe the connected SAP system to determine release, edition and basic
 * reachability. Read-only: never writes anything.
 *
 * Edition heuristics:
 *   - hostname ending in ".s4hana.cloud.sap" -> pce (S/4HANA Cloud RISE)
 *   - hostname containing "abap.ondemand.com" or "abap-system" -> btp-abap
 *   - custom datacenter hosts and everything else -> on-prem
 *
 * Release detection: tries multiple endpoints because ADT does not expose
 * a single canonical "system info" endpoint across versions. The first one
 * that responds with a usable string wins; null is returned otherwise.
 */
export async function probeEnvironment(
  c: CapituAdtClient,
): Promise<ProbedEnvironment> {
  const start = Date.now();
  await c.connect();

  const edition = classifyEdition(c.url);
  const release = await detectRelease(c);
  const objectTypeCount = await countObjectTypes(c);

  return {
    url: c.url,
    edition,
    sapBasisRelease: release,
    objectTypeCount,
    probedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}

export function classifyEdition(url: string): SapEdition {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.s4hana.cloud.sap')) {
      return 'pce';
    }
    if (host.includes('abap.ondemand.com') || host.includes('abap-system')) {
      return 'btp-abap';
    }
    // Datacenter hosts (Opus IDC, custom RISE deployments, on-prem in cloud)
    return 'on-prem';
  } catch {
    return 'unknown';
  }
}

async function detectRelease(c: CapituAdtClient): Promise<string | null> {
  // Strategy: try a few ADT endpoints that historically expose release.
  // None are guaranteed across all systems; we return the first hit.

  // 1) discovery endpoint sometimes carries release in headers/title
  try {
    const raw = c.raw as unknown as {
      featureDetails?: (svc: string) => Promise<unknown>;
    };
    if (typeof raw.featureDetails === 'function') {
      const details = (await raw.featureDetails(
        'discovery',
      )) as { title?: string };
      const m = details?.title?.match(/(\d{3})/);
      if (m) return m[1] ?? null;
    }
  } catch {
    // fall through
  }

  // 2) systemUsers itself doesn't expose release, but objectTypes URI
  // sometimes does via its metadata. As a fallback, we leave null —
  // the docs MCP can ask the user or use a sensible default.
  return null;
}

async function countObjectTypes(c: CapituAdtClient): Promise<number> {
  try {
    const types = await c.raw.objectTypes();
    return types.length;
  } catch {
    return 0;
  }
}
