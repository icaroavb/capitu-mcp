import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

/**
 * Spec proposal storage. A proposal is a draft technical plan that the user
 * must explicitly approve before capitu touches the SAP system.
 *
 * Lifecycle:
 *   1. capituSpecPropose inserts row with status='pending', returns token
 *   2. User reviews the proposed artifacts (via the markdown returned)
 *   3. capituSpecApply({token, confirmed: true}) reads the row, executes,
 *      updates status to 'applied' or 'partial' depending on result
 *      OR capituSpecApply({token, confirmed: false}) sets status='cancelled'
 *
 * Proposals are kept in the KB indefinitely for audit. Cleanup is manual.
 */

export type ProposalStatus = 'pending' | 'applied' | 'cancelled' | 'partial';

export interface ProposalRecord<TPayload = unknown> {
  token: string;
  title: string;
  targetPackage: string;
  payload: TPayload;
  status: ProposalStatus;
  createdAt: string;
  appliedAt: string | null;
  appliedLog: unknown | null;
}

export function newProposalToken(): string {
  return randomUUID();
}

export function insertProposal<TPayload>(
  db: Database,
  args: { title: string; targetPackage: string; payload: TPayload },
): string {
  const token = newProposalToken();
  db.prepare(
    `INSERT INTO spec_proposals (token, title, target_package, payload, status)
     VALUES (@token, @title, @targetPackage, @payload, 'pending')`,
  ).run({
    token,
    title: args.title,
    targetPackage: args.targetPackage,
    payload: JSON.stringify(args.payload),
  });
  return token;
}

export function getProposal<TPayload>(
  db: Database,
  token: string,
): ProposalRecord<TPayload> | null {
  const row = db
    .prepare('SELECT * FROM spec_proposals WHERE token = ?')
    .get(token) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToProposal<TPayload>(row);
}

export function listProposals(
  db: Database,
  status?: ProposalStatus,
): ProposalRecord[] {
  const sql = status
    ? 'SELECT * FROM spec_proposals WHERE status = ? ORDER BY created_at DESC'
    : 'SELECT * FROM spec_proposals ORDER BY created_at DESC';
  const rows = (status ? db.prepare(sql).all(status) : db.prepare(sql).all()) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => rowToProposal(r));
}

export function updateProposalStatus(
  db: Database,
  token: string,
  status: ProposalStatus,
  log?: unknown,
): void {
  db.prepare(
    `UPDATE spec_proposals
     SET status = @status, applied_at = CURRENT_TIMESTAMP, applied_log = @log
     WHERE token = @token`,
  ).run({
    token,
    status,
    log: log === undefined ? null : JSON.stringify(log),
  });
}

function rowToProposal<TPayload = unknown>(
  row: Record<string, unknown>,
): ProposalRecord<TPayload> {
  return {
    token: row.token as string,
    title: row.title as string,
    targetPackage: row.target_package as string,
    payload: row.payload ? (JSON.parse(row.payload as string) as TPayload) : (null as TPayload),
    status: row.status as ProposalStatus,
    createdAt: row.created_at as string,
    appliedAt: (row.applied_at as string) ?? null,
    appliedLog: row.applied_log ? JSON.parse(row.applied_log as string) : null,
  };
}
