import { CapituAdtClient } from '@capitu/adt-client';
import {
  type ComplianceContext,
  type EmbeddingsProvider,
  loadComplianceFromEnv,
  openKb,
  resolveEmbeddingsProvider,
} from '@capitu/kb';
import type { Database } from 'better-sqlite3';

export interface ServerContext {
  kb: Database;
  embeddings: EmbeddingsProvider;
  adt: CapituAdtClient;
  compliance: ComplianceContext;
  agent: 'capitu-docs';
}

export interface ServerContextOptions {
  /** Path to the shared KB SQLite file. Defaults to env CAPITU_KB_PATH. */
  kbPath?: string;
  /** Override embeddings provider (tests pass FakeEmbeddings). */
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

  return { kb, embeddings, adt, compliance, agent: 'capitu-docs' };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `capitu-docs: required env var ${name} is missing. ADT connection is mandatory in MVP. See README.md.`,
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
