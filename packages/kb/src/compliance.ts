/**
 * Compliance gate for the SAP API Policy (April 2026, Q33).
 *
 * The policy declares ADT APIs as "internal" and lists which uses are endorsed
 * vs out-of-scope. This module centralizes that decision: every tool that
 * touches ADT must declare its category and call `assertAllowed()` before acting.
 *
 * Two modes:
 *  - 'strict' (default): only categories explicitly endorsed by Q33 are allowed.
 *  - 'permissive': gray-zone categories are allowed too, but require an extra
 *    opt-in (CAPITU_I_UNDERSTAND_API_POLICY_RISK=yes) and emit a warning record.
 *
 * Reference (SAP API Policy FAQ Q33, paraphrased):
 *   Endorsed via ADT: code authoring, code checks, build processes,
 *   transport management, abapGit, debug of own code, ABAP Unit, ATC.
 *   NOT endorsed via ADT: programmatic table reads, SQL execution against
 *   backend, business-data integration, agentic AI workflows operating on
 *   business data, substitution for business APIs.
 */

import { envValue } from './winenv.js';

export type ComplianceMode = 'strict' | 'permissive';

export type ToolCategory =
  | 'code-read'
  | 'code-write'
  | 'code-check'
  | 'code-test'
  | 'transport'
  | 'git'
  | 'debug'
  | 'docs-read'
  | 'metadata-read'
  | 'business-data-read'
  | 'sql-execute'
  | 'business-runtime';

const ENDORSED_CATEGORIES = new Set<ToolCategory>([
  'code-read',
  'code-write',
  'code-check',
  'code-test',
  'transport',
  'git',
  'debug',
  'docs-read',
  'metadata-read',
]);

const GRAY_ZONE_CATEGORIES = new Set<ToolCategory>([
  'business-data-read',
  'sql-execute',
  'business-runtime',
]);

export interface ComplianceContext {
  mode: ComplianceMode;
  riskAcknowledged: boolean;
}

export class CompliancePolicyViolation extends Error {
  constructor(
    public readonly category: ToolCategory,
    public readonly mode: ComplianceMode,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = 'CompliancePolicyViolation';
  }
}

export function loadComplianceFromEnv(env: NodeJS.ProcessEnv = process.env): ComplianceContext {
  const raw = (envValue(env, 'CAPITU_COMPLIANCE_MODE') ?? 'strict').toLowerCase();
  const mode: ComplianceMode = raw === 'permissive' ? 'permissive' : 'strict';
  const riskAcknowledged = envValue(env, 'CAPITU_I_UNDERSTAND_API_POLICY_RISK') === 'yes';
  return { mode, riskAcknowledged };
}

export interface ComplianceDecision {
  allowed: boolean;
  warning?: string;
  reason?: string;
}

export function evaluate(category: ToolCategory, ctx: ComplianceContext): ComplianceDecision {
  if (ENDORSED_CATEGORIES.has(category)) {
    return { allowed: true };
  }
  if (!GRAY_ZONE_CATEGORIES.has(category)) {
    return {
      allowed: false,
      reason: `Unknown tool category: ${category}`,
    };
  }
  if (ctx.mode === 'strict') {
    return {
      allowed: false,
      reason: `Tool category '${category}' is out of scope of the SAP API Policy (April 2026, Q33) for ADT-based access. ADT is endorsed only for development tooling (code, checks, tests, transports, abapGit, debug). Set CAPITU_COMPLIANCE_MODE=permissive AND CAPITU_I_UNDERSTAND_API_POLICY_RISK=yes to override (your responsibility).`,
    };
  }
  if (!ctx.riskAcknowledged) {
    return {
      allowed: false,
      reason: `Permissive mode requires CAPITU_I_UNDERSTAND_API_POLICY_RISK=yes to confirm you understand category '${category}' is outside the endorsed ADT scope under SAP API Policy Q33.`,
    };
  }
  return {
    allowed: true,
    warning: `Category '${category}' is outside the endorsed ADT scope. Running because permissive mode is enabled. Audit trail recorded.`,
  };
}

export function assertAllowed(category: ToolCategory, ctx: ComplianceContext): void {
  const d = evaluate(category, ctx);
  if (!d.allowed) {
    throw new CompliancePolicyViolation(category, ctx.mode, d.reason ?? 'denied');
  }
}

export function isEndorsed(category: ToolCategory): boolean {
  return ENDORSED_CATEGORIES.has(category);
}

export function isGrayZone(category: ToolCategory): boolean {
  return GRAY_ZONE_CATEGORIES.has(category);
}
