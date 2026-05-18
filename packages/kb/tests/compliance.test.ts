import { describe, expect, it } from 'vitest';
import {
  CompliancePolicyViolation,
  assertCompliance,
  evaluateCompliance,
  loadComplianceFromEnv,
} from '../src/index.js';

describe('compliance', () => {
  it('loads strict mode by default', () => {
    const ctx = loadComplianceFromEnv({});
    expect(ctx.mode).toBe('strict');
    expect(ctx.riskAcknowledged).toBe(false);
  });

  it('loads permissive only when explicitly set', () => {
    const ctx = loadComplianceFromEnv({
      CAPITU_COMPLIANCE_MODE: 'permissive',
      CAPITU_I_UNDERSTAND_API_POLICY_RISK: 'yes',
    });
    expect(ctx.mode).toBe('permissive');
    expect(ctx.riskAcknowledged).toBe(true);
  });

  it('endorsed categories always pass', () => {
    const strict = { mode: 'strict' as const, riskAcknowledged: false };
    for (const cat of [
      'code-read',
      'code-write',
      'code-check',
      'code-test',
      'transport',
      'git',
      'debug',
      'docs-read',
      'metadata-read',
    ] as const) {
      expect(evaluateCompliance(cat, strict).allowed).toBe(true);
    }
  });

  it('gray-zone categories blocked in strict mode', () => {
    const strict = { mode: 'strict' as const, riskAcknowledged: false };
    const decision = evaluateCompliance('sql-execute', strict);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/SAP API Policy/);
  });

  it('gray-zone categories require explicit risk acknowledgement in permissive', () => {
    const noAck = { mode: 'permissive' as const, riskAcknowledged: false };
    expect(evaluateCompliance('business-data-read', noAck).allowed).toBe(false);

    const acked = { mode: 'permissive' as const, riskAcknowledged: true };
    const decision = evaluateCompliance('business-data-read', acked);
    expect(decision.allowed).toBe(true);
    expect(decision.warning).toBeTruthy();
  });

  it('assertCompliance throws CompliancePolicyViolation on deny', () => {
    const strict = { mode: 'strict' as const, riskAcknowledged: false };
    expect(() => assertCompliance('sql-execute', strict)).toThrow(
      CompliancePolicyViolation,
    );
  });

  it('assertCompliance does not throw on endorsed category', () => {
    const strict = { mode: 'strict' as const, riskAcknowledged: false };
    expect(() => assertCompliance('code-write', strict)).not.toThrow();
  });
});
