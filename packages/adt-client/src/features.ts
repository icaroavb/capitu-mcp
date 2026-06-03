import type { CapituAdtClient } from './client.js';

/**
 * Per-instance SAP feature probing.
 *
 * When you switch to a SAP system you don't yet know, trial-and-error ("try
 * RAP, get 404, try something else") is wasteful and noisy. This module asks
 * the system once which optional capabilities exist, so the caller can plan.
 *
 * The idea is borrowed from ARC-1's `src/adt/features.ts`; the implementation
 * is ours and intentionally smaller — a lightweight GET per endpoint plus a
 * careful HTTP-status classification. We do NOT fetch data; a 2xx/4xx/5xx
 * shape is enough to tell "endpoint exists" from "not activated / forbidden".
 */

export type FeatureId = 'rap' | 'abapGit' | 'transport' | 'amdp' | 'ui5' | 'hana';

interface FeatureProbeDef {
  id: FeatureId;
  endpoint: string;
  description: string;
}

/**
 * One probe endpoint per feature. These are stable ADT collection URLs; their
 * mere existence (any dispatched response, even 400/405) signals the feature
 * is installed. Exported so tests and docs can reference the list.
 */
export const FEATURE_PROBES: readonly FeatureProbeDef[] = [
  { id: 'rap', endpoint: '/sap/bc/adt/ddic/ddl/sources', description: 'RAP/CDS development' },
  { id: 'abapGit', endpoint: '/sap/bc/adt/abapgit/repos', description: 'abapGit integration' },
  {
    id: 'transport',
    endpoint: '/sap/bc/adt/cts/transportrequests',
    description: 'CTS transport management',
  },
  { id: 'amdp', endpoint: '/sap/bc/adt/debugger/amdp', description: 'AMDP debugging' },
  { id: 'ui5', endpoint: '/sap/bc/adt/filestore/ui5-bsp', description: 'UI5/Fiori BSP' },
  { id: 'hana', endpoint: '/sap/bc/adt/ddic/sysinfo/hanainfo', description: 'HANA database' },
] as const;

export interface FeatureStatus {
  id: FeatureId;
  available: boolean;
  /** Human-readable reason, present when availability is negative or ambiguous. */
  reason?: string;
}

/**
 * Classify a probe's HTTP status into availability.
 *
 *   - 2xx → endpoint exists, clean response → available.
 *   - 400 / 405 / other 4xx / 5xx → endpoint exists; SAP dispatched to the
 *     handler and rejected the request shape → available. (Some collection
 *     endpoints return 400 without query params, e.g. /ddic/ddl/sources.)
 *   - 401 → rejected by ICM/SICF before auth could run → no signal about the
 *     endpoint. Report unavailable to avoid lying on misconfigured systems.
 *   - 403 → endpoint exists but the user lacks authorization → unusable for
 *     this user → unavailable, with a reason.
 *   - 404 → ICF service not activated / not registered → unavailable.
 *
 * Mirrors ARC-1's classifyFeatureProbeStatus semantics. Exported for testing.
 */
export function classifyFeatureStatus(id: FeatureId, statusCode: number): FeatureStatus {
  if (statusCode >= 200 && statusCode < 300) return { id, available: true };
  if (statusCode === 401) {
    return { id, available: false, reason: 'auth failure (401) — cannot determine availability' };
  }
  if (statusCode === 403) {
    return {
      id,
      available: false,
      reason: 'forbidden (403) — exists but user lacks authorization',
    };
  }
  if (statusCode === 404) {
    return { id, available: false, reason: 'not found (404) — ICF service not activated' };
  }
  // 400 / 405 / other 4xx / 5xx → endpoint exists, request was dispatched.
  return { id, available: true };
}

interface RawHttp {
  request: (
    url: string,
    opts: { method?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number }>;
}

/**
 * Probe all features against the connected system, in parallel. Each probe is
 * a single GET; failures are classified, never thrown — a system that lacks a
 * feature is the normal case, not an error. Connects lazily via the client.
 */
export async function probeFeatures(client: CapituAdtClient): Promise<FeatureStatus[]> {
  await client.connect();
  const http = (client.raw as unknown as { httpClient?: RawHttp }).httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new Error(
      'abap-adt-api: ADTClient.httpClient.request not available for feature probing.',
    );
  }
  return Promise.all(
    FEATURE_PROBES.map(async (probe) => {
      try {
        const resp = await http.request(probe.endpoint, { method: 'GET' });
        return classifyFeatureStatus(probe.id, resp.status);
      } catch (err) {
        // abap-adt-api throws on non-2xx with a statusCode; use it when present.
        const status =
          (err as { statusCode?: number; status?: number })?.statusCode ??
          (err as { status?: number })?.status;
        if (typeof status === 'number') return classifyFeatureStatus(probe.id, status);
        return { id: probe.id, available: false, reason: 'network error — cannot reach endpoint' };
      }
    }),
  );
}
