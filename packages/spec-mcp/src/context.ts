import { CapituAdtClient } from '@capitu/adt-client';
import {
  type ComplianceContext,
  type EmbeddingsProvider,
  loadComplianceFromEnv,
  openKb,
  resolveEmbeddingsProvider,
} from '@capitu/kb';
import type { Database } from 'better-sqlite3';

/**
 * Spec agent context. Mirrors docs-mcp/dev-mcp shape so the KB / embeddings /
 * compliance gate work identically. The agent identifier is 'capitu-spec' so
 * learnings/traces are attributable.
 *
 * Spec needs ADT for validate / impactAnalysis but never writes. Most tools
 * are pure: requirement in, structured markdown out.
 */
export interface ServerContext {
  kb: Database;
  embeddings: EmbeddingsProvider;
  adt: CapituAdtClient;
  compliance: ComplianceContext;
  agent: 'capitu-spec';
}

export interface ServerContextOptions {
  kbPath?: string;
  embeddings?: EmbeddingsProvider;
}

export function buildContext(opts: ServerContextOptions = {}): ServerContext {
  const url = required('SAP_URL');
  const user = required('SAP_USER');
  const password = required('SAP_PASSWORD');
  const client = process.env.SAP_CLIENT;
  const language = process.env.SAP_LANGUAGE;

  const adt = new CapituAdtClient({ url, user, password, client, language });
  const kb = openKb({ path: opts.kbPath });
  const embeddings = opts.embeddings ?? resolveEmbeddingsProvider();
  const compliance = loadComplianceFromEnv();

  return { kb, embeddings, adt, compliance, agent: 'capitu-spec' };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `capitu-spec: required env var ${name} is missing. ADT connection is mandatory.`,
    );
  }
  return v;
}

export async function shutdownContext(ctx: ServerContext): Promise<void> {
  try {
    await ctx.adt.disconnect();
  } catch {
    // best-effort
  }
  try {
    ctx.kb.close();
  } catch {
    // best-effort
  }
}
